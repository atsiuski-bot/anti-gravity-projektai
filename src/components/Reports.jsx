import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, doc, updateDoc } from 'firebase/firestore';
import { formatMinutesToTimeString, getLithuanianDateString, vilniusWallClockToISO, addDaysToDateString, calculateCurrentTotalMinutes } from '../utils/timeUtils';
import { formatDisplayName, isManagerRole, resolveUserId } from '../utils/formatters';
import { privateScopeConstraints, scopeRoster } from '../utils/teamScope';
import { cn } from '../utils/cn';
import { addComment } from '../utils/commentActions';
import { gatherReportData } from '../utils/reportData';
import { buildReport } from '../utils/reportAggregate';
import { confirmTask, unconfirmTask, humanActor, MODES } from '../domain';
import { Briefcase, AlertTriangle, FileText, Users, User, TrendingUp, TrendingDown, Minus, ChevronLeft, ChevronRight } from 'lucide-react';

import Button from './ui/Button';
import IconButton from './ui/IconButton';
import Card from './ui/Card';
import ConfirmDialog from './ui/ConfirmDialog';
import Select from './ui/Select';
import DatePicker from './ui/DatePicker';
import { Spinner } from './ui/Loading';
import DeletedBadge from './task/DeletedBadge';
import TaskRow from './task/TaskRow';
import TaskActionRow from './task/TaskActionRow';
import TaskCard from './TaskCard';
import TaskDetailModal from './task/TaskDetailModal';
import { buildReviewActions } from '../utils/taskActionVisibility';

import DailyStatistics from './DailyStatistics';
import ReportExportModal from './ReportExportModal';
import { CommentsModal } from './TaskDetailsModals';
import { useAuth } from '../context/AuthContext';
import { TASK_TAGS } from '../utils/taskUtils';
import { PeriodPicker } from './reports/PeriodPicker';
import { PERIOD_PRESETS, resolvePresetRange, shiftRange } from './reports/periodPresets';


export default function Reports({ users, canExport = false, viewRole, views = ['report', 'approval', 'history'] }) {
    const { currentUser, userRole: authUserRole, userData } = useAuth();
    // viewRole lets a caller scope the whole report to a role other than the signed-in one — a
    // manager opening their OWN "Ataskaitos" passes 'worker' so it shows only personal data
    // (no team aggregates, no user dropdown, no export), identical to a worker's view.
    const userRole = viewRole ?? authUserRole;
    // `views` selects which report sections this instance carries. The three manager sections
    // (Veiklos ataskaita / Pridavimas / Istorija) were lifted OUT of a standalone "Kom. ataskaitos"
    // tab and re-hosted as sub-tabs of other top-level tabs (report → Kom. kalendorius;
    // approval + history → Kom. veiklos). Each host renders Reports with a single view, so the
    // internal switcher is suppressed (views.length === 1) and the parent tab strip is the only
    // tab affordance. Defaults to all three for any caller that still wants the full surface.
    const [activeTab, setActiveTab] = useState(views[0]);
    const [loading, setLoading] = useState(false);

    // --- HOURS REPORT STATE ---
    // Free from/to range (YYYY-MM-DD) instead of a single month, so a manager can pull an
    // arbitrary span for payroll. Defaults to the current month so far (1st → today).
    // Personal reports (worker role, or a manager viewing their own data via viewRole='worker')
    // default to 'day' view; the team report keeps 'week' as its default.
    const isPersonalView = userRole === 'worker';
    const [dateRange, setDateRange] = useState(() => resolvePresetRange(isPersonalView ? 'day' : 'week'));
    // Test/founder accounts are excluded from the work report by default so payroll totals and
    // the leaderboard aren't skewed by non-production data; a manager can opt to show them.
    // Reports always exclude test (isTest) users — there is no manager toggle.
    const showTestUsers = false;

    // Unified report period. 'day' renders DailyStatistics (its own day navigation); any other
    // value renders the detailed summary for `dateRange`. `periodOpen` toggles the picker panel.
    const [reportPeriod, setReportPeriod] = useState(isPersonalView ? 'day' : 'week'); // 'day' | 'week' | 'month' | '3months' | 'year' | 'custom'
    const [periodOpen, setPeriodOpen] = useState(false);

    // The rich "Atsisiųsti ataskaitą" modal (Markdown / JSON / CSV summary + per-worker selection).
    // Manager-only (gated by canExport); owns its own period + worker scope, so it works in any mode.
    const [exportModalOpen, setExportModalOpen] = useState(false);

    // On-screen team summary drill-down: clicking a flagged worker in the summary opens THAT worker's
    // day timeline (the same single-worker drill-down the team calendar uses), scoped to the report's
    // range, so the manager can locate and fix the suspicious sessions. { userId, name } | null.
    const [summaryDrillWorker, setSummaryDrillWorker] = useState(null);

    // --- TASKS REPORT STATE ---
    const [taskFilters, setTaskFilters] = useState({
        userId: 'all',
        tag: 'all',
        startDate: getLithuanianDateString(),
        endDate: getLithuanianDateString(),
    });

    const [filteredTasks, setFilteredTasks] = useState([]);
    const [taskSort, setTaskSort] = useState('date_desc'); // date_desc, date_asc, time_desc, time_asc

    // Modal state
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null, task: null });
    // The shared "open the task" detail sheet — the SAME one the mobile card opens, so a task reads
    // identically whether tapped on a phone or clicked in the desktop table.
    const [detailTask, setDetailTask] = useState(null);

    // Friendly error banner (replaces banned window.alert — §8/§10). Never holds raw err.message.
    const [error, setError] = useState('');

    // Revert confirmation (replaces window.confirm — §8). Holds the task awaiting confirmation.
    const [revertTarget, setRevertTarget] = useState(null);
    const [reverting, setReverting] = useState(false);

    // No work-hours fetch here on purpose. Every number this tab shows comes from
    // TeamPeriodSummary / PersonalPeriodSummary / DailyStatistics, and the CSV export lives in
    // ReportExportModal — so the old fetch re-read work_sessions, break_sessions and the ENTIRE
    // unfiltered work_hours collection on every period tap only to discard the result, while its
    // failures still raised the shared error banner over a report that was rendering fine.

    // Fetch Tasks Data
    useEffect(() => {
        if (activeTab === 'tasks') {
            fetchTasks();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchTasks is recreated each render; intentionally refetch only on tab/filter change
    }, [activeTab, taskFilters]); // Refetch when filters change

    const fetchTasks = async ({ preserveError = false } = {}) => {
        setLoading(true);
        try {
            const isManager = isManagerRole(userRole);

            // Constrain every task query to the rows this viewer may read (own / team /
            // whole-company), so nothing is denied once the rules tighten. Adds composite indexes
            // (assignedUserId|teamManagerIds + the range/equality field) — see firestore.indexes.json.
            const taskScope = privateScopeConstraints({
                userData, uid: currentUser?.uid, effectiveRole: userRole, ownerField: 'assignedUserId'
            });

            // Both server-side lower bounds are anchored to the SAME Vilnius midnight the in-memory
            // window below uses. `new Date('YYYY-MM-DD')` is UTC midnight — 03:00 Vilnius in summer —
            // so a task finished or confirmed between 00:00 and 03:00 on the range's first day was
            // never FETCHED, even though the client filter and the day grouping would have shown it.
            const rangeStartIso = vilniusWallClockToISO(taskFilters.startDate, '00:00') || new Date(taskFilters.startDate).toISOString();

            // Query 1: Archived - Respects date filter
            const archivedQ = query(
                collection(db, 'archived_tasks'),
                where('archivedAt', '>=', rangeStartIso),
                ...taskScope
            );

            // Query 2: Active - Completed or Confirmed
            // We fetch ALL 'completed' (unconfirmed) tasks to ensure "Done Earlier" list is complete
            // And all recent tasks based on update time

            const activeUnconfirmedQ = query(
                collection(db, 'tasks'),
                where('status', '==', 'completed'),
                ...taskScope
            );

            // Also get confirmed ones that match date filter
            const activeRecentQ = query(
                collection(db, 'tasks'),
                where('updatedAt', '>=', rangeStartIso),
                ...taskScope
            );

            const [archivedSnap, activeUnconfirmedSnap, activeRecentSnap] = await Promise.all([
                getDocs(archivedQ),
                getDocs(activeUnconfirmedQ),
                getDocs(activeRecentQ)
            ]);

            const mapDoc = (d, isArchived) => ({ ...d.data(), id: d.id, isArchived });

            const archivedTasks = archivedSnap.docs.map(d => mapDoc(d, true));
            const activeUnconfirmed = activeUnconfirmedSnap.docs.map(d => mapDoc(d, false));
            const activeRecent = activeRecentSnap.docs.map(d => mapDoc(d, false));

            // Merge and deduplicate active tasks
            const activeMap = new Map();
            [...activeUnconfirmed, ...activeRecent].forEach(t => activeMap.set(t.id, t));

            let allTasks = [...archivedTasks, ...Array.from(activeMap.values())];

            // Date range anchored to the VILNIUS calendar day, not UTC/browser-local midnight, so a
            // task completed in the last Vilnius hours of a day (or just after midnight) lands on the
            // correct side of the boundary. Half-open interval [start, end): `end` is the EXCLUSIVE
            // next-Vilnius-day 00:00. startDate/endDate are getLithuanianDateString output, so the
            // helper never returns null in practice; the || fallbacks are purely defensive. (M1.)
            const start = new Date(vilniusWallClockToISO(taskFilters.startDate, '00:00') || taskFilters.startDate);
            const end = new Date(vilniusWallClockToISO(addDaysToDateString(taskFilters.endDate, 1), '00:00') || addDaysToDateString(taskFilters.endDate, 1));

            // Global filter
            allTasks = allTasks.filter(t => {
                // If it's unconfirmed (completed), we ALWAYS keep it (unless filtered by User/Tag)
                // If it's confirmed or archived, we respect date range
                const isUnconfirmed = t.status === 'completed';

                if (!isUnconfirmed) {
                    const dateStr = t.completedAt || t.archivedAt || t.updatedAt;
                    if (!dateStr) return false;
                    const d = new Date(dateStr);
                    if (d < start || d >= end) return false;
                }

                const tAssignedUserId = resolveUserId(t);
                
                if (taskFilters.userId !== 'all' && tAssignedUserId !== taskFilters.userId) return false;
                if (taskFilters.tag !== 'all' && t.tag !== taskFilters.tag) return false;

                // Security: Force filter by user for non-managers
                if (!isManager && tAssignedUserId !== currentUser.uid) return false;

                return true;
            });

            // CRITICAL: Sort tasks by completion date (newest first)
            // Force sort to ALWAYS be by completedAt descending
            const sortedTasks = [...allTasks].sort((a, b) => {
                const getTimestamp = (task) => {
                    const dateStr = task.completedAt || task.archivedAt || task.updatedAt;
                    if (!dateStr) return 0;
                    const timestamp = new Date(dateStr).getTime();
                    return isNaN(timestamp) ? 0 : timestamp;
                };

                const timeA = getTimestamp(a);
                const timeB = getTimestamp(b);

                // Always descending (newest first)
                return timeB - timeA;
            });

            // Don't clear a caller-set banner (e.g. confirmRevert calls fetchTasks() to restore
            // the optimistically-removed task AFTER a failed revert — the READ succeeds and would
            // otherwise wipe the revert-failure message).
            if (!preserveError) setError('');
            setFilteredTasks(sortedTasks);

        } catch (error) {
            console.error("Error fetching tasks:", error);
            // Surface the failure (banner) instead of falling through to the empty-state copy,
            // which would misread a failed load as "no tasks found".
            setError('Nepavyko užkrauti užduočių ataskaitos. Patikrinkite ryšį ir bandykite dar kartą.');
        } finally {
            setLoading(false);
        }
    };

    const handleToggleConfirm = async (task) => {
        try {
            if (task.isArchived) {
                setError("Negalima keisti archyvuotų užduočių būsenos.");
                return;
            }
            setError('');

            const isConfirmed = task.status === 'confirmed';
            const newStatus = isConfirmed ? 'completed' : 'confirmed';

            // Optimistic update
            setFilteredTasks(prev => prev.map(t =>
                t.id === task.id ? { ...t, status: newStatus, confirmedAt: newStatus === 'confirmed' ? new Date().toISOString() : null } : t
            ));

            // Audited confirm/unconfirm toggle (ADR 0015) — replaces the inline write whose confirmedBy
            // was a literal 'MANAGER' string; the command stamps the real manager uid.
            const actor = humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email, role: userRole });
            if (newStatus === 'confirmed') {
                await confirmTask({ task }, { actor, mode: MODES.COMMIT, reason: 'confirmed from reports' });
            } else {
                await unconfirmTask({ task }, { actor, mode: MODES.COMMIT, reason: 'unconfirmed from reports' });
            }

        } catch (error) {
            console.error("Error toggling confirmation:", error);
            fetchTasks();
        }
    };

    const handleAddComment = async (text) => {
        const { task } = activeModal;
        if (!task || !text.trim()) return;

        try {
            const comment = {
                text: text,
                user: currentUser.displayName || currentUser.email,
                userId: currentUser.uid,
                createdAt: new Date().toISOString()
            };

            const updatedComments = [...(task.comments || []), comment];

            // Update local state immediately
            setFilteredTasks(prev => prev.map(t =>
                t.id === task.id ? { ...t, comments: updatedComments } : t
            ));

            // Also update the activeModal task
            setActiveModal(prev => ({
                ...prev,
                task: { ...prev.task, comments: updatedComments }
            }));

            // Determine collection based on archival status
            const collectionName = task.isArchived ? 'archived_tasks' : 'tasks';

            await addComment(task.id, text, currentUser, task.comments || [], collectionName);
        } catch (err) {
            console.error("Error adding comment:", err);
            setError("Nepavyko pridėti komentaro. Bandykite dar kartą.");
        }
    };

    // Step 1: validate permissions / state, then open the ConfirmDialog (replaces window.confirm — §8).
    const handleRevert = (task) => {
        // Check permissions: manager or the user who completed the task
        const isManager = isManagerRole(userRole);
        const isCompleter = task.completedBy === currentUser.uid;

        if (!isManager && !isCompleter) {
            setError("Neturite teisių grąžinti šios užduoties.");
            return;
        }

        if (task.isArchived) {
            setError("Negalima grąžinti archyvuotos užduoties. Naudokite užduočių istoriją.");
            return;
        }

        setError('');
        setRevertTarget(task);
    };

    // Step 2: the user confirmed in the dialog — perform the revert.
    const confirmRevert = async () => {
        const task = revertTarget;
        if (!task) return;
        setReverting(true);

        try {
            // Optimistic update
            setFilteredTasks(prev => prev.filter(t => t.id !== task.id));

            const taskRef = doc(db, 'tasks', task.id);
            await updateDoc(taskRef, {
                status: 'in-progress',
                timerStatus: 'paused',
                completed: false,
                completedAt: null,
                completedBy: null,
                confirmedAt: null,
                confirmedBy: null,
                // Clear the soft-delete flags too. A task deleted with "keep work hours" is stored
                // as completed AND isDeleted, so a revert that reset only the completion left it
                // deleted: the active list hides it (deletedAt older than the work-day cutoff) and
                // the nightly sweep archives it away — the manager pressed Grąžinti and the task
                // vanished for good. reopenTask and the two other restore paths clear all three.
                isDeleted: false,
                deletedAt: null,
                deletedBy: null,
                updatedAt: new Date().toISOString()
                // Importantly, we do NOT touch timerMinutes, actualTime, or any other time tracking data
            });

            setRevertTarget(null);
        } catch (err) {
            console.error("Error reverting task:", err);
            // Never surface raw err.message to the user (§10) — map to friendly Lithuanian copy.
            setError("Klaida grąžinant užduotį. Bandykite iš naujo arba kontaktuokite vadybą.");
            setRevertTarget(null);
            fetchTasks({ preserveError: true }); // Refresh on error — keep the revert-failure banner
        } finally {
            setReverting(false);
        }
    };

    const applyPreset = (preset) => {
        const range = resolvePresetRange(preset);
        if (range) setDateRange(range);
    };

    // Period selector handler: 'day' falls through to the daily view; any preset resolves a range
    // and switches to the detailed summary. Closes the picker panel either way.
    const choosePeriod = (period) => {
        setReportPeriod(period);
        setPeriodOpen(false);
        if (period !== 'day') applyPreset(period);
    };

    // Shift the active period window one unit in the given direction (−1 back, +1 forward).
    // The preset type is preserved so the shift function knows the canonical step size (week=7 days,
    // month=calendar month, etc.). The date range is replaced; the picker chip stays highlighted.
    const shiftPeriod = (direction) => {
        setDateRange(shiftRange(reportPeriod, dateRange, direction));
    };

    // Group tasks by date
    const groupedTasks = React.useMemo(() => {
        const groups = {};

        // Helper to get the VILNIUS calendar-day key (YYYY-MM-DD). Using getLithuanianDateString
        // (not a raw UTC split) keeps a task finished 00:00–03:00 Vilnius on the correct day, so the
        // grouped view agrees with DailyStatistics' 03:00 work-day boundary. (Full-sweep M2.)
        const getDateStr = (t) => {
            const dateStr = t.completedAt || t.archivedAt || t.updatedAt;
            if (!dateStr) return 'No Date';
            return getLithuanianDateString(dateStr);
        };

        filteredTasks.forEach(t => {
            const dateKey = getDateStr(t);
            if (!groups[dateKey]) {
                groups[dateKey] = [];
            }
            groups[dateKey].push(t);
        });

        // Sort groups by date descending
        return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
    }, [filteredTasks]);

    // Report-surface props for the shared TaskCard (mobile): the SAME card the active lists use,
    // timer hidden, acting on report semantics — accept/un-accept (the old confirm checkbox, now a
    // toggle button) and revert. The footer mirrors what the shared detail modal shows on tap.
    const reportCardProps = (task) => {
        const isManager = isManagerRole(userRole);
        const isCompleter = task.completedBy === currentUser?.uid;
        const canRevert = (isManager || isCompleter) && !task.isArchived;
        return {
            actions: buildReviewActions({
                task,
                isManager,
                canRestore: canRevert,
                onToggleConfirm: handleToggleConfirm,
                onRestore: handleRevert,
            }),
            detailOverrides: {
                canManage: isManager,
                canDelete: false,
                onConfirm: task.isArchived ? undefined : () => handleToggleConfirm(task),
                onRevert: canRevert ? () => handleRevert(task) : undefined,
            },
        };
    };

    // Helper to render table
    const TaskListTable = ({ tasks, title }) => (
        <div className="mb-6">
            {/* Mobile / touch: one card per task — the SAME shared TaskCard the active lists use
                (report surface: timer hidden, accept/revert buttons). Never a table (§9). */}
            <ul className="space-y-3 md:hidden">
                <li className="px-1 pb-1">
                    <h3 className="text-body font-bold text-ink">{title} ({tasks.length})</h3>
                </li>
                {tasks.map((task) => {
                    const { actions, detailOverrides } = reportCardProps(task);
                    return (
                        <li key={task.id}>
                            <TaskCard
                                task={task}
                                role={isManagerRole(userRole) ? 'manager' : 'worker'}
                                surface="report"
                                actions={actions}
                                detailOverrides={detailOverrides}
                            />
                        </li>
                    );
                })}
                {tasks.length === 0 && (
                    <li className="bg-surface-card rounded-card border border-line px-6 py-8 text-center text-body text-ink-muted">
                        Pagal pasirinktą laikotarpį užduočių nėra.
                    </li>
                )}
            </ul>

            {/* Desktop / wide: denser table is allowed (§9) */}
            <div className="hidden md:block bg-surface-card rounded-card shadow-sm border border-line overflow-hidden">
            <div className="px-4 py-3 bg-surface-sunken border-b border-line">
                <h3 className="text-body font-bold text-ink">{title} ({tasks.length})</h3>
            </div>
            <table className="min-w-full divide-y divide-line table-fixed">
                <thead className="bg-surface-sunken">
                    <tr>
                        <th scope="col" className="px-2 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">UŽDUOTIS</th>
                        <th scope="col" className="px-1 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-12">MEIST.</th>
                        <th scope="col" className="px-1 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-16">PRIOR.</th>
                        <th scope="col" className="px-1 py-2 text-right text-caption font-bold text-ink-muted uppercase tracking-wider w-24">LAIKAS</th>
                        <th scope="col" className="px-1 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-16">ŽYMOS</th>
                        <th scope="col" className="px-1 py-2 text-right text-caption font-bold text-ink-muted uppercase tracking-wider w-20"></th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-line">
                    {tasks.map((task) => {
                        const dateStr = task.completedAt || task.archivedAt || task.updatedAt;
                        const worker = users?.find(u => u.id === task.assignedUserId);
                        const userName = worker ? (worker.displayName || worker.email) : (task.assignedUserName || '-');
                        // The SAME action set the mobile card shows, rendered through the one adaptive
                        // single-line row (no comment / edit buttons — those live in the detail sheet).
                        const { actions: rowActions } = reportCardProps(task);

                        return (
                            <TaskRow
                                key={task.id}
                                task={task}
                                onOpen={setDetailTask}
                                rowClassName={`border-b border-line last:border-0 hover:bg-opacity-80 transition-colors ${task.status === 'confirmed' ? 'bg-surface-card' : 'bg-feedback-info-soft'}`}
                                assigneeName={userName}
                                titleCell={
                                    <>
                                        <div className="flex items-center gap-2">
                                            <div className={`text-sm font-bold whitespace-normal break-words ${(task.isDeleted || task.status === 'deleted') ? 'line-through text-ink-muted' : task.completed ? 'text-ink' : 'text-ink-strong'}`}>
                                                {task.title}
                                            </div>
                                            {(task.isDeleted || task.status === 'deleted') && <DeletedBadge />}
                                        </div>
                                        {task.description && (
                                            <div className="text-caption text-ink-muted mt-0.5 flex items-start gap-1">
                                                <Briefcase className="w-3 h-3 text-ink-muted flex-shrink-0 mt-0.5" />
                                                <span className="whitespace-normal break-words">{task.description}</span>
                                            </div>
                                        )}
                                        {dateStr && (
                                            <div className="text-caption text-ink-muted mt-1">
                                                {new Date(dateStr).toLocaleString()}
                                            </div>
                                        )}
                                    </>
                                }
                                timeCell={
                                    <>
                                        <span className="text-brand">{task.estimatedTime || '-'}</span>
                                        <span className="text-ink-muted mx-1">/</span>
                                        <span className="text-ink-strong">{formatMinutesToTimeString(calculateCurrentTotalMinutes(task))}</span>
                                    </>
                                }
                                actions={<TaskActionRow actions={rowActions} />}
                            />
                        );
                    })}
                </tbody>
            </table>
            </div>
        </div>
    );

    return (
        <div className="space-y-4">
            {/* TABS — Veiklos ataskaita / Pridavimas / Istorija. These are team/oversight surfaces,
                so the switcher only appears in the manager team view. In a personal report (worker,
                or a manager viewing their OWN data via viewRole="worker") there is just one view, so
                the whole switcher is dropped. */}
            {isManagerRole(userRole) && views.length > 1 && (
                <div role="tablist" aria-label="Ataskaitų skiltys">
                    {/* Segmented switcher — same control as the Komandos veiklos sub-tabs
                        (ManagerView). Labels wrap to multiple lines on a narrow screen
                        instead of forcing a horizontal scroll. */}
                    <div className="flex w-full sm:inline-flex sm:w-auto overflow-hidden rounded-control border border-line bg-surface-sunken">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'report'}
                            onClick={() => setActiveTab('report')}
                            className={cn(
                                'flex-1 sm:flex-none inline-flex items-center justify-center px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold text-center leading-tight transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                activeTab === 'report' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            Veiklos ataskaita
                        </button>
                        <div className="w-px bg-line" aria-hidden="true" />
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'approval'}
                            onClick={() => setActiveTab('approval')}
                            className={cn(
                                'flex-1 sm:flex-none inline-flex items-center justify-center px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold text-center leading-tight transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                activeTab === 'approval' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            Pridavimas
                        </button>
                        <div className="w-px bg-line" aria-hidden="true" />
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'history'}
                            onClick={() => setActiveTab('history')}
                            className={cn(
                                'flex-1 sm:flex-none inline-flex items-center justify-center px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold text-center leading-tight transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                activeTab === 'history' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            Istorija
                        </button>
                    </div>
                </div>
            )}

            {/* Friendly error banner — replaces banned window.alert (§8); never raw err.message (§10) */}
            {error && (
                <div
                    role="alert"
                    className="flex items-start gap-3 rounded-control border-l-4 border-feedback-danger bg-feedback-danger-soft p-4"
                >
                    <AlertTriangle className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-feedback-danger-text">{error}</p>
                    <button
                        type="button"
                        onClick={() => setError('')}
                        aria-label="Uždaryti pranešimą"
                        className="ml-auto text-caption font-semibold text-feedback-danger-text underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                    >
                        Uždaryti
                    </button>
                </div>
            )}



            {/* --- WORK REPORT TAB (merged daily view + detailed range summary) --- */}
            {activeTab === 'report' && (
                <div className="space-y-2">
                    {/* Period selector + CSV export share one row: the collapsible period card
                        flexes to fill; the export button sits beside it (icon-only on mobile,
                        icon+label on desktop) and appears only for a multi-day range (day mode
                        has no export). The button reveals the range ladder (week → month →
                        3 months → year) and a custom date picker. */}
                    <div className="flex items-stretch gap-2">
                        <div className="flex-1 min-w-0">
                        <PeriodPicker
                            presets={PERIOD_PRESETS}
                            activeId={reportPeriod}
                            onChoose={choosePeriod}
                            open={periodOpen}
                            onToggle={() => setPeriodOpen((o) => !o)}
                            label="Laikotarpis"
                        >
                            <div className="flex flex-col gap-3 border-t border-line pt-3 sm:flex-row sm:items-end">
                                <div className="flex-1">
                                    <label htmlFor="report-from" className="block text-caption font-semibold text-ink-muted mb-1">Nuo</label>
                                    <DatePicker
                                        id="report-from"
                                        value={dateRange.start}
                                        max={dateRange.end}
                                        onChange={(v) => { setReportPeriod('custom'); setDateRange(prev => ({ ...prev, start: v })); }}
                                    />
                                </div>
                                <div className="flex-1">
                                    <label htmlFor="report-to" className="block text-caption font-semibold text-ink-muted mb-1">Iki</label>
                                    <DatePicker
                                        id="report-to"
                                        value={dateRange.end}
                                        min={dateRange.start}
                                        max={getLithuanianDateString()}
                                        onChange={(v) => { setReportPeriod('custom'); setDateRange(prev => ({ ...prev, end: v })); }}
                                    />
                                </div>
                            </div>
                        </PeriodPicker>
                        </div>

                        {/* Single export entry point: the modal carries Markdown (for an LLM) / JSON /
                            a per-day timesheet CSV, with a worker-subset picker — superseding the old
                            standalone hours-CSV button. Manager-only; the modal owns its own period +
                            scope, so it is offered in every mode (including 'day'). */}
                        {canExport && (
                            <Button
                                variant="primary"
                                icon={FileText}
                                onClick={() => setExportModalOpen(true)}
                                aria-label="Atsisiųsti ataskaitą (AI / JSON / CSV)"
                                className="shrink-0 px-3 sm:px-4"
                            >
                                <span className="hidden sm:inline">Ataskaita</span>
                            </Button>
                        )}
                    </div>

                    {/* Plan-coverage indicator: how many of the listed workers have ANY plan
                        (calendar or expected-hours baseline) for the span. Surfaces silently-missing
                        plans so a manager sees that Skirtumas can't be trusted for the remainder. */}

                    {/* On-screen team summary — manager-only, multi-day ranges only. */}
                    {reportPeriod !== 'day' && isManagerRole(userRole) && (
                        <TeamPeriodSummary
                            range={dateRange}
                            users={users}
                            scope={{ userData, uid: currentUser?.uid, effectiveRole: userRole }}
                            onDrillWorker={(userId, name) => setSummaryDrillWorker({ userId, name })}
                            onShiftPeriod={shiftPeriod}
                            atToday={dateRange.end >= getLithuanianDateString()}
                        />
                    )}

                    {/* Personal summary card — worker view (or manager on their own personal report),
                        multi-day ranges only. Same card shape as TeamPeriodSummary but scoped to the
                        signed-in user: Veikla/Pertraukos/Viso with period-over-period deltas. */}
                    {reportPeriod !== 'day' && !isManagerRole(userRole) && (
                        <PersonalPeriodSummary
                            range={dateRange}
                            currentUser={currentUser}
                            users={users}
                            scope={{ userData, uid: currentUser?.uid, effectiveRole: userRole }}
                            onShiftPeriod={shiftPeriod}
                            atToday={dateRange.end >= getLithuanianDateString()}
                        />
                    )}

                    {/* Day mode → the live daily timeline. Any multi-day range → the same view
                        aggregated over [start, end] (summary cards, sort filters).
                        On the manager team view the task-acceptance lists and history move to the
                        dedicated "Pridavimas" tab, so this tab shows only the work-hours surface
                        (view='hours'). A personal report (worker, or a manager viewing their own
                        data via viewRole='worker') has no such tab, so it keeps the full surface. */}
                    {reportPeriod === 'day' ? (
                        <DailyStatistics
                            currentUser={currentUser}
                            userRole={userRole}
                            users={users}
                            canExport={canExport}
                            view={isManagerRole(userRole) ? 'hours' : 'full'}
                            showTestUsers={showTestUsers}
                        />
                    ) : (
                        <DailyStatistics
                            currentUser={currentUser}
                            userRole={userRole}
                            users={users}
                            canExport={canExport}
                            dateRange={dateRange}
                            view={isManagerRole(userRole) ? 'hours' : 'full'}
                            showTestUsers={showTestUsers}
                            // The summary card above (team for managers, personal for workers)
                            // already carries the period span + Veikla/Pertraukos/Viso totals,
                            // so suppress the duplicate summary inside DailyStatistics.
                            periodSummaryAbove
                            onShiftPeriod={shiftPeriod}
                        />
                    )}

                    {canExport && (
                        <ReportExportModal
                            open={exportModalOpen}
                            onClose={() => setExportModalOpen(false)}
                            users={users}
                            scope={{ userData, uid: currentUser?.uid, effectiveRole: userRole }}
                            defaultRange={{ start: dateRange.start, end: dateRange.end }}
                        />
                    )}

                    {/* Drill-down opened from a summary warning — that worker's day timeline over the
                        report range, the same single-worker modal the team calendar uses. */}
                    {summaryDrillWorker && (
                        <DailyStatistics
                            currentUser={currentUser}
                            userRole={userRole}
                            users={users}
                            canExport={canExport}
                            dateRange={dateRange}
                            forceUserId={summaryDrillWorker.userId}
                            forceUserName={summaryDrillWorker.name}
                            workerDetailOnly
                            showTestUsers={showTestUsers}
                            onClose={() => setSummaryDrillWorker(null)}
                        />
                    )}
                </div>
            )}

            {/* --- PRIDAVIMAS TAB: tasks finished by the team and awaiting THIS manager's acceptance
                (status 'completed'), scoped to the tasks they are responsible for. The accepted
                ('confirmed') half and the archive move to the sibling "Istorija" tab, so a task
                lives in exactly one place across the two tabs. --- */}
            {activeTab === 'approval' && (
                <DailyStatistics
                    currentUser={currentUser}
                    userRole={userRole}
                    users={users}
                    canExport={canExport}
                    view="approval"
                    approvalPhase="pending"
                />
            )}

            {/* --- ISTORIJA TAB: tasks the manager has already accepted (status 'confirmed') — the
                live, not-yet-archived ones on top, the archived ones in the TaskHistory browser
                below. Same manager scoping as Pridavimas. --- */}
            {activeTab === 'history' && (
                <DailyStatistics
                    currentUser={currentUser}
                    userRole={userRole}
                    users={users}
                    canExport={canExport}
                    view="approval"
                    approvalPhase="accepted"
                />
            )}



            {/* --- TASKS TAB CONTENT --- */}
            {activeTab === 'tasks' && (
                <div className="space-y-4">
                    <div className="bg-surface-card p-4 rounded-card shadow-sm border border-line grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                            <label htmlFor="task-filter-from" className="block text-caption font-semibold text-ink-muted mb-1">Nuo</label>
                            <DatePicker
                                id="task-filter-from"
                                value={taskFilters.startDate}
                                onChange={(v) => setTaskFilters(prev => ({ ...prev, startDate: v }))}
                            />
                        </div>
                        <div>
                            <label htmlFor="task-filter-to" className="block text-caption font-semibold text-ink-muted mb-1">Iki</label>
                            <DatePicker
                                id="task-filter-to"
                                value={taskFilters.endDate}
                                onChange={(v) => setTaskFilters(prev => ({ ...prev, endDate: v }))}
                            />
                        </div>
                        <div>
                            <label className="block text-caption font-semibold text-ink-muted mb-1">Filtruoti pagal Žymą</label>
                            <Select
                                value={taskFilters.tag}
                                onChange={(val) => setTaskFilters(prev => ({ ...prev, tag: val }))}
                                options={[
                                    { value: 'all', label: 'Visos Žymos' },
                                    ...TASK_TAGS.map((tag) => ({ value: tag, label: tag })),
                                ]}
                                label="Žyma"
                                ariaLabel="Filtruoti pagal žymą"
                            />
                        </div>
                        {(isManagerRole(userRole)) && (
                            <div>
                                <label className="block text-caption font-semibold text-ink-muted mb-1">Filtruoti pagal Meistrą</label>
                                <Select
                                    value={taskFilters.userId}
                                    onChange={(val) => setTaskFilters(prev => ({ ...prev, userId: val }))}
                                    options={[
                                        { value: 'all', label: 'Visi Meistrai' },
                                        ...(users?.map((u) => ({ value: u.id, label: formatDisplayName(u.displayName || u.email) })) || []),
                                    ]}
                                    label="Meistras"
                                    ariaLabel="Filtruoti pagal meistrą"
                                />
                            </div>
                        )}
                        <div className="col-span-2 md:col-span-4 flex justify-end">
                            <Select
                                value={taskSort}
                                onChange={setTaskSort}
                                options={[
                                    { value: 'date_desc', label: 'Naujausi viršuje' },
                                    { value: 'date_asc', label: 'Seniausi viršuje' },
                                    { value: 'time_desc', label: 'Ilgiausiai trukę viršuje' },
                                    { value: 'time_asc', label: 'Trumpiausiai trukę viršuje' },
                                ]}
                                label="Rūšiavimas"
                                ariaLabel="Rūšiuoti užduotis"
                                className="w-full sm:w-64"
                            />
                        </div>
                    </div>

                    {loading ? (
                        <div className="bg-surface-card rounded-card shadow-sm">
                            <Spinner label="Kraunami duomenys…" />
                        </div>
                    ) : (
                        <>
                            {groupedTasks.length > 0 && groupedTasks.map(([date, tasks]) => (
                                <TaskListTable
                                    key={date}
                                    tasks={tasks}
                                    title={`Užduotys: ${date}`}
                                />
                            ))}

                            {!error && groupedTasks.length === 0 && (
                                <div className="bg-surface-card p-8 rounded-card shadow-sm text-center text-ink-muted">
                                    Nerasta užduočių pagal pasirinktus filtrus.
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}



            {activeModal.type === 'comments' && activeModal.task && (
                <CommentsModal
                    isOpen={true}
                    onClose={() => setActiveModal({ type: null, taskId: null, task: null })}
                    comments={activeModal.task.comments}
                    onAddComment={handleAddComment}
                />
            )}

            {/* The shared task detail sheet — opened by a desktop-table row click. Reuses the EXACT
                per-surface wiring the mobile card uses (reportCardProps.detailOverrides). */}
            {detailTask && (() => {
                const ov = reportCardProps(detailTask).detailOverrides;
                return (
                    <TaskDetailModal
                        isOpen
                        onClose={() => setDetailTask(null)}
                        task={{ ...detailTask, isArchived: !!(detailTask.isArchived || detailTask.archivedAt) }}
                        allowPhotoAdd={false}
                        showManagerLine
                        canManage={ov.canManage}
                        canDelete={ov.canDelete}
                        onConfirm={ov.onConfirm ? () => { setDetailTask(null); ov.onConfirm(); } : undefined}
                        onRevert={ov.onRevert ? () => { setDetailTask(null); ov.onRevert(); } : undefined}
                    />
                );
            })()}

            {/* Revert confirmation (replaces window.confirm — §8) */}
            {revertTarget && (
                <ConfirmDialog
                    open
                    title="Grąžinti užduotį?"
                    message={`Užduotis „${revertTarget.title}“ bus grąžinta į aktyvių sąrašą.`}
                    warning="Užduotis nebebus pažymėta kaip užbaigta. Sugaištas laikas nebus pakeistas."
                    confirmLabel="Grąžinti"
                    variant="primary"
                    loading={reverting}
                    onConfirm={confirmRevert}
                    onCancel={() => setRevertTarget(null)}
                />
            )}
        </div>
    );
}

// Personal period summary — same card shape as TeamPeriodSummary but scoped to one worker.
// Calls gatherReportData with workerIds=[uid] so it only reads data the security rules already
// permit the viewer to see, then reads workers[0] for the individual's totals and deltas.
function PersonalPeriodSummary({ range, currentUser, users, scope, onShiftPeriod, atToday }) {
    const { userData, uid, effectiveRole } = scope || {};
    const [state, setState] = useState({ loading: true, current: null, previous: null, error: false });

    const startStr = range?.start;
    const endStr = range?.end;
    const selfUid = currentUser?.uid;

    useEffect(() => {
        let ignore = false;
        if (!startStr || !endStr || !selfUid) {
            setState({ loading: false, worker: null, prevWorker: null, error: false });
            return undefined;
        }
        setState((s) => ({ ...s, loading: true, error: false }));
        (async () => {
            try {
                const reportWindow = { startStr, endStr };
                const workerIds = [selfUid];
                const { workers, prevWindow } = await gatherReportData({
                    db, userData, uid, effectiveRole, users, window: reportWindow, workerIds, includeRecognition: false,
                });
                const generatedAt = new Date().toISOString();
                const current = buildReport({ generatedAt, window: reportWindow, prevWindow, scopeLabel: '', includeEarnings: false, workers });
                const previous = buildReport({ generatedAt, window: prevWindow, prevWindow, scopeLabel: '', includeEarnings: false, workers });
                if (ignore) return;
                setState({
                    loading: false,
                    current: current.team || null,
                    previous: previous.team || null,
                    error: false,
                });
            } catch (err) {
                console.error('Personal summary build failed:', err);
                if (!ignore) setState({ loading: false, worker: null, prevWorker: null, error: true });
            }
        })();
        return () => { ignore = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [startStr, endStr, selfUid, uid, effectiveRole]);

    const delta = (cur, prev) => {
        if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
        const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
        if (pct === 0) return { pct: 0, improved: null };
        return { pct, improved: pct > 0 };
    };

    if (state.loading) {
        return (
            <Card className="mb-4 p-4">
                <Spinner label="Kraunama asmeninė suvestinė…" />
            </Card>
        );
    }
    if (state.error || !state.current) return null;

    const w = state.current;
    const p = state.previous;

    return (
        <Card
            as="section"
            className="mb-4 p-4"
            aria-label="Asmeninė laikotarpio suvestinė"
        >
            <div className="mb-3 flex items-center gap-2">
                {onShiftPeriod && (
                    <IconButton icon={ChevronLeft} label="Ankstesnis laikotarpis" onClick={() => onShiftPeriod(-1)} />
                )}
                <span className="font-mono text-caption text-ink-muted">{startStr} – {endStr}</span>
                {onShiftPeriod && (
                    <IconButton icon={ChevronRight} label="Kitas laikotarpis" onClick={() => onShiftPeriod(1)} disabled={atToday} />
                )}
                <User className="h-5 w-5 text-brand ml-auto flex-shrink-0" aria-hidden="true" />
                <h3 className="text-body font-bold text-ink-strong hidden sm:block">Mano suvestinė</h3>
            </div>

            <div className="grid grid-cols-3 divide-x divide-line">
                <SummaryStat
                    label="Veikla"
                    value={formatMinutesToTimeString(w.totalWorkMinutes)}
                    delta={p ? delta(w.totalWorkMinutes, p.totalWorkMinutes) : null}
                />
                <SummaryStat
                    label="Pertraukos"
                    value={formatMinutesToTimeString(w.totalBreakMinutes)}
                    valueClass="text-session-break-accent"
                />
                <SummaryStat
                    label="Viso"
                    value={formatMinutesToTimeString(w.totalWorkMinutes + w.totalBreakMinutes)}
                    valueClass="text-brand"
                    labelClass="text-brand"
                />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-x-2 divide-line border-t border-line pt-4 sm:divide-x">
                <SummaryStat
                    label="Užbaigta užduočių"
                    value={w.completedTasks ?? '—'}
                    delta={p ? delta(w.completedTasks, p.completedTasks) : null}
                />
                {Number.isFinite(w.avgOnTimePct) && (
                    <SummaryStat
                        label="Startas laiku"
                        value={`${w.avgOnTimePct}%`}
                        delta={p && Number.isFinite(p.avgOnTimePct) ? delta(w.avgOnTimePct, p.avgOnTimePct) : null}
                    />
                )}
            </div>
        </Card>
    );
}

// One team-rollup metric tile with an optional period-over-period delta. The delta is derived by
// diffing the current vs previous team total (both from buildReport), so its arrow/colour mean the
// same thing as the per-worker deltas in the downloaded report. `goodWhen` says which direction is
// an improvement so colour never contradicts the numbers (more hours/tasks = up-good; on-time % up
// = good). Colour is paired with an arrow + sign, never the sole signal (DESIGN_SYSTEM §5).
function SummaryStat({ label, value, delta, valueClass = 'text-ink-strong', labelClass = 'text-ink-muted' }) {
    let Arrow = Minus;
    let tone = 'text-ink-muted';
    if (delta && delta.pct !== 0) {
        Arrow = delta.improved ? TrendingUp : TrendingDown;
        tone = delta.improved ? 'text-feedback-success' : 'text-feedback-danger';
    }
    return (
        <div className="flex flex-col px-1">
            <span className={cn('text-caption', labelClass)}>{label}</span>
            <span className={cn('mt-0.5 text-h3 font-bold tabular-nums', valueClass)}>{value}</span>
            {delta && (
                <span className={cn('mt-0.5 flex items-center gap-0.5 text-caption font-semibold tabular-nums', tone)}>
                    <Arrow className="h-3 w-3" aria-hidden="true" />
                    {delta.pct > 0 ? '+' : ''}{delta.pct}%
                </span>
            )}
        </div>
    );
}

// On-screen team/period summary — the same conclusion the report download carries, surfaced inline.
// Builds buildReport over the report's range for the whole scoped roster (one fetch, the same reads
// the export modal makes — no new query kind, schema, or rule), then reads its team rollup, derives
// team-level deltas by diffing against a second buildReport over the previous window (the fetch
// already spans it), and lists workers whose sessions were clamped (dataTrust.implausibleSessions).
// Pure presentation over the shared aggregator: reportAggregate.js is imported and called, never
// modified. Best-effort — any failure renders nothing, leaving the work-hours report below intact.
function TeamPeriodSummary({ range, users, scope, onDrillWorker, onShiftPeriod, atToday }) {
    const { userData, uid, effectiveRole } = scope || {};
    const [state, setState] = useState({ loading: true, team: null, prevTeam: null, warnings: [], error: false });

    // VALUE identity of the roster this summary covers: each visible id plus whether that account is
    // disabled, sorted into one string. Test accounts are dropped (Reports never counts them).
    //
    // Why a string and not an id ARRAY: `users` is rebuilt inline on every parent render and
    // `userData` is a new object on every user-doc snapshot, so an array memoised on them was a new
    // dependency each time — the effect below then re-ran the whole five-collection report fetch and
    // blanked the card back to its spinner while the manager was reading it. A string changes only
    // when the roster genuinely changes.
    const rosterKey = useMemo(() => (
        (scopeRoster(users, userData, uid) || [])
            .filter((u) => !u.isTest)
            .map((u) => `${u.id}|${u.isDisabled ? 'off' : 'on'}`)
            .sort()
            .join(',')
    ), [users, userData, uid]);

    const startStr = range?.start;
    const endStr = range?.end;

    useEffect(() => {
        let ignore = false;
        const rosterEntries = rosterKey ? rosterKey.split(',') : [];
        const idOf = (entry) => entry.slice(0, entry.lastIndexOf('|'));
        // Disabled accounts are FETCHED like everyone else: a worker offboarded mid-period still
        // worked the days before they left, and dropping them by current account state erased those
        // hours from the team totals while the day table below still listed them — two contradictory
        // totals on one screen, and no way to close out their last period.
        const workerIds = rosterEntries.map(idOf);
        const disabledIds = new Set(rosterEntries.filter((e) => e.endsWith('|off')).map(idOf));
        if (!startStr || !endStr || startStr > endStr || workerIds.length === 0) {
            setState({ loading: false, team: null, prevTeam: null, warnings: [], error: false });
            return undefined;
        }
        setState((s) => ({ ...s, loading: true, error: false }));
        (async () => {
            try {
                const window = { startStr, endStr };
                const { workers, prevWindow } = await gatherReportData({
                    db, userData, uid, effectiveRole, users, window, workerIds, includeRecognition: false,
                });
                // ...but a disabled account with NO session in the compared span is a closed account,
                // not a team member: keep it out so "Meistrų" is not inflated by former staff.
                const inCompared = (s) => s.date >= prevWindow.startStr && s.date <= endStr;
                const counted = workers.filter((w) => (
                    !disabledIds.has(w.userId)
                    || (w.workSessions || []).some(inCompared)
                    || (w.breakSessions || []).some(inCompared)
                ));
                const generatedAt = new Date().toISOString();
                // Current report carries the team rollup + per-worker dataTrust we surface.
                const current = buildReport({ generatedAt, window, prevWindow, scopeLabel: '', includeEarnings: true, workers: counted });
                // A second build over the PREVIOUS window (already fetched) gives a real prior team
                // total to diff — true team-level deltas without modifying the aggregator.
                const previous = buildReport({ generatedAt, window: prevWindow, prevWindow, scopeLabel: '', includeEarnings: true, workers: counted });
                if (ignore) return;
                const warnings = current.workers
                    .filter((w) => w.dataTrust && w.dataTrust.implausibleSessions > 0)
                    .map((w) => ({ userId: w.userId, name: w.name, count: w.dataTrust.implausibleSessions }));
                setState({ loading: false, team: current.team, prevTeam: previous.team, warnings, error: false });
            } catch (err) {
                console.error('Team summary build failed:', err);
                if (!ignore) setState({ loading: false, team: null, prevTeam: null, warnings: [], error: true });
            }
        })();
        return () => { ignore = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- userData/users read through the stable rosterKey + scope ids; depending on the whole objects would refetch on every parent render
    }, [startStr, endStr, rosterKey, uid, effectiveRole]);

    // Team-level delta from current vs previous total. `goodWhen='up'` for quantities (more is
    // better) and on-time %; null when there is no prior value to compare against.
    const delta = (cur, prev) => {
        if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
        const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
        if (pct === 0) return { pct: 0, improved: null };
        return { pct, improved: pct > 0 };
    };

    if (state.loading) {
        return (
            <Card className="mb-4 p-4">
                <Spinner label="Kraunama komandos suvestinė…" />
            </Card>
        );
    }
    // Silent when there is nothing to summarise or the build failed — the report below still stands.
    if (state.error || !state.team || state.team.workerCount === 0) return null;

    const t = state.team;
    const p = state.prevTeam;

    return (
        <Card
            as="section"
            className="mb-4 p-4"
            aria-label="Komandos laikotarpio suvestinė"
        >
            <div className="mb-3 flex items-center gap-2">
                {onShiftPeriod && (
                    <IconButton icon={ChevronLeft} label="Ankstesnis laikotarpis" onClick={() => onShiftPeriod(-1)} />
                )}
                <span className="font-mono text-caption text-ink-muted">{startStr} – {endStr}</span>
                {onShiftPeriod && (
                    <IconButton icon={ChevronRight} label="Kitas laikotarpis" onClick={() => onShiftPeriod(1)} disabled={atToday} />
                )}
                <Users className="h-5 w-5 text-brand ml-auto flex-shrink-0" aria-hidden="true" />
                <h3 className="text-body font-bold text-ink-strong hidden sm:block">Komandos suvestinė</h3>
            </div>

            {/* Time triplet — the period's worked / break / total hours to the minute, from the same
                aggregator the rest of the card uses. This is the former standalone
                Veikla/Pertraukos/Viso bar (previously rendered by DailyStatistics below), folded in so
                the whole period reads as ONE summary instead of two disconnected blocks. Colour-coded
                (break = session-break accent, total = brand) but always paired with a text label. */}
            <div className="grid grid-cols-3 divide-x divide-line">
                <SummaryStat
                    label="Veikla"
                    value={formatMinutesToTimeString(t.totalWorkMinutes)}
                    delta={p ? delta(t.totalWorkMinutes, p.totalWorkMinutes) : null}
                />
                <SummaryStat
                    label="Pertraukos"
                    value={formatMinutesToTimeString(t.totalBreakMinutes)}
                    valueClass="text-session-break-accent"
                />
                <SummaryStat
                    label="Viso"
                    value={formatMinutesToTimeString(t.totalWorkMinutes + t.totalBreakMinutes)}
                    valueClass="text-brand"
                    labelClass="text-brand"
                />
            </div>

            {/* Team KPIs — headline counts and quality, separated from the time triplet by a rule so
                the two tiers (time · team) read as one card with a clear internal hierarchy. */}
            <div className="mt-4 grid grid-cols-3 gap-x-2 divide-line border-t border-line pt-4 sm:divide-x">
                <SummaryStat label="Meistrų" value={t.workerCount} />
                <SummaryStat
                    label="Užbaigta užduočių"
                    value={t.completedTasks}
                    delta={p ? delta(t.completedTasks, p.completedTasks) : null}
                />
                {Number.isFinite(t.avgOnTimePct) ? (
                    <SummaryStat
                        label="Vid. startas laiku"
                        value={`${t.avgOnTimePct}%`}
                        delta={p && Number.isFinite(p.avgOnTimePct) ? delta(t.avgOnTimePct, p.avgOnTimePct) : null}
                    />
                ) : (
                    <SummaryStat label="Uždarbis (neto)" value={t.netEarningsEur ? `${Number(t.netEarningsEur).toLocaleString('lt-LT')} €` : '—'} />
                )}
            </div>

            {/* Įspėjimai — workers whose sessions were clamped (would otherwise read as inflated time).
                Each chip drills into that worker's day timeline so the manager can locate and fix them. */}
            {state.warnings.length > 0 && (
                <div className="mt-4 border-t border-line pt-3">
                    <p className="mb-2 flex items-center gap-1.5 text-caption font-bold uppercase tracking-wide text-feedback-warning-text">
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                        Įspėjimai — patikrintinos sesijos
                    </p>
                    <ul className="flex flex-wrap gap-2">
                        {state.warnings.map((w) => (
                            <li key={w.userId}>
                                <button
                                    type="button"
                                    onClick={() => onDrillWorker?.(w.userId, w.name)}
                                    className="flex min-h-touch items-center gap-1.5 rounded-control border border-feedback-warning-border bg-feedback-warning-soft px-3 py-1.5 text-caption font-semibold text-feedback-warning-text transition-colors hover:bg-feedback-warning-soft/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                >
                                    <span className="break-words">{w.name}</span>
                                    <span className="rounded-full bg-feedback-warning-border/40 px-1.5 font-mono tabular-nums">{w.count}</span>
                                    <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </Card>
    );
}
