import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, orderBy, doc, updateDoc } from 'firebase/firestore';
import { formatMinutesToTimeString, getLithuanianDateString, calculateCurrentTotalMinutes, sanitizeReportMinutes, isImplausibleSessionMinutes } from '../utils/timeUtils';
import { formatDisplayName, isManagerRole, resolveUserId, resolveUserName } from '../utils/formatters';
import { privateScopeConstraints, scopeRoster } from '../utils/teamScope';
import { absenceLabel } from '../utils/absence';
import { cn } from '../utils/cn';
import { addComment } from '../utils/commentActions';
import { gatherReportData } from '../utils/reportData';
import { buildReport } from '../utils/reportAggregate';
import { formatStatValue } from '../utils/workerStats';
import { Briefcase, MessageSquare, RotateCcw, AlertTriangle, FileText, Users, TrendingUp, TrendingDown, Minus, ChevronRight } from 'lucide-react';

import IconButton from './ui/IconButton';
import Button from './ui/Button';
import ConfirmDialog from './ui/ConfirmDialog';
import Select from './ui/Select';
import DatePicker from './ui/DatePicker';
import { Spinner } from './ui/Loading';
import TaskStatusPill from './task/TaskStatusPill';
import PriorityBadge from './task/PriorityBadge';
import DeletedBadge from './task/DeletedBadge';
import CompletedMarker from './task/CompletedMarker';
import AssigneeChip from './task/AssigneeChip';
import TaskRow from './task/TaskRow';

import DailyStatistics from './DailyStatistics';
import ReportExportModal from './ReportExportModal';
import { CommentsModal } from './TaskDetailsModals';
import { useAuth } from '../context/AuthContext';
import { TASK_TAGS } from '../utils/taskUtils';
import { PeriodPicker } from './reports/PeriodPicker';
import { PERIOD_PRESETS, resolvePresetRange } from './reports/periodPresets';

// Skirtumas (worked − planned) is meaningful only when the plan plausibly covers the worked span;
// a token plan against a full month produces a fake "+164:00 surplus". A worker counts as "planned"
// only when their plan is at least this fraction of worked time. Shared by the CSV Skirtumas gate
// and the on-screen coverage indicator so the two surfaces never disagree on who has a usable plan.
const PLAN_COVERAGE_FLOOR = 0.25;

export default function Reports({ users, canExport = false, viewRole }) {
    const { currentUser, userRole: authUserRole, userData } = useAuth();
    // viewRole lets a caller scope the whole report to a role other than the signed-in one — a
    // manager opening their OWN "Ataskaitos" passes 'worker' so it shows only personal data
    // (no team aggregates, no user dropdown, no export), identical to a worker's view.
    const userRole = viewRole ?? authUserRole;
    const [activeTab, setActiveTab] = useState('report');
    const [loading, setLoading] = useState(false);

    // --- HOURS REPORT STATE ---
    // Free from/to range (YYYY-MM-DD) instead of a single month, so a manager can pull an
    // arbitrary span for payroll. Defaults to the current month so far (1st → today).
    const [dateRange, setDateRange] = useState(() => {
        const today = getLithuanianDateString();
        return { start: `${today.slice(0, 7)}-01`, end: today };
    });
    const [workData, setWorkData] = useState([]); // Array of { userId, name, totalMinutes, days: { date: minutes } }
    // Test/founder accounts are excluded from the work report by default so payroll totals and
    // the leaderboard aren't skewed by non-production data; a manager can opt to show them.
    // Reports always exclude test (isTest) users — there is no manager toggle.
    const showTestUsers = false;

    // Unified report period. 'day' renders DailyStatistics (its own day navigation); any other
    // value renders the detailed summary for `dateRange`. `periodOpen` toggles the picker panel.
    const [reportPeriod, setReportPeriod] = useState('day'); // 'day' | 'week' | 'month' | '3months' | 'year' | 'custom'
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

    // --- CALENDAR HISTORY STATE ---
    // Same from/to range model as the work report (defaults to the current month so far), driven
    // by the identical collapsible period picker. `historyPeriod` tracks the active preset for the
    // collapsed label; `historyPeriodOpen` toggles the picker panel.
    const [historyRange, setHistoryRange] = useState(() => {
        const today = getLithuanianDateString();
        return { start: `${today.slice(0, 7)}-01`, end: today };
    });
    const [historyPeriod, setHistoryPeriod] = useState('month'); // 'day' | 'week' | 'month' | '3months' | 'year' | 'custom'
    const [historyPeriodOpen, setHistoryPeriodOpen] = useState(false);
    const [calendarHistory, setCalendarHistory] = useState([]);
    const [filteredTasks, setFilteredTasks] = useState([]);
    const [taskSort, setTaskSort] = useState('date_desc'); // date_desc, date_asc, time_desc, time_asc

    // Modal state
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null, task: null });

    // Friendly error banner (replaces banned window.alert — §8/§10). Never holds raw err.message.
    const [error, setError] = useState('');

    // Revert confirmation (replaces window.confirm — §8). Holds the task awaiting confirmation.
    const [revertTarget, setRevertTarget] = useState(null);
    const [reverting, setReverting] = useState(false);

    // Fetch Work Hours Data — only when a multi-day range is selected (day mode uses DailyStatistics).
    useEffect(() => {
        if (activeTab === 'report' && reportPeriod !== 'day') {
            fetchWorkHours();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchWorkHours is recreated each render; intentionally refetch only on tab/period/range change
    }, [activeTab, reportPeriod, dateRange.start, dateRange.end]);

    // Fetch Calendar History
    useEffect(() => {
        if (activeTab === 'calendar-history') {
            fetchCalendarHistory();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchCalendarHistory is recreated each render; intentionally refetch only on tab/range change
    }, [activeTab, historyRange.start, historyRange.end]);

    // Fetch Tasks Data
    useEffect(() => {
        if (activeTab === 'tasks') {
            fetchTasks();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchTasks is recreated each render; intentionally refetch only on tab/filter change
    }, [activeTab, taskFilters]); // Refetch when filters change

    const fetchWorkHours = async () => {
        setLoading(true);
        try {
            // The manager picks the span directly now; the aggregation below is span-agnostic.
            // (The old hardcoded "Jan 2026 starts on the 19th" clamp is gone — with explicit
            // from/to dates the manager sets the start, and no sessions exist before go-live.)
            const startStr = dateRange.start;
            const endStr = dateRange.end;

            // The query constrains itself to the rows this viewer may read (own / team /
            // whole-company) so it never requests a denied document once the rules tighten. This
            // introduces composite indexes (owner/team field + date) — listed in firestore.indexes.json.
            const sessScope = privateScopeConstraints({
                userData, uid: currentUser?.uid, effectiveRole: userRole, ownerField: 'userId'
            });

            const workQ = query(
                collection(db, 'work_sessions'),
                where('date', '>=', startStr),
                where('date', '<=', endStr),
                ...sessScope
            );

            // Query break_sessions by their canonical Lithuanian-local 'date' field too, so
            // breaks bucket into the same day/month as the work they sit alongside. The old
            // query filtered by the UTC 'startTime', which mis-bucketed breaks taken near
            // UTC midnight and split a Vilnius day across two months at the boundary.
            const breakQ = query(
                collection(db, 'break_sessions'),
                where('date', '>=', startStr),
                where('date', '<=', endStr),
                ...sessScope
            );

            // Planned hours come from the calendar (work_hours): start/end ISO timestamps, no
            // 'date' field, so we read the collection and bucket client-side by the Lithuanian
            // calendar day of each entry's start — same read permission as the session queries.
            const plannedQ = query(collection(db, 'work_hours'));

            const [workSnap, breakSnap, plannedSnap] = await Promise.all([
                getDocs(workQ),
                getDocs(breakQ),
                getDocs(plannedQ)
            ]);

            const workSessions = workSnap.docs
                .map(d => ({ ...d.data(), id: d.id, _type: 'work' }))
                .filter(session => !session.isDeleted);

            const breakSessions = breakSnap.docs.map(d => ({ ...d.data(), id: d.id, _type: 'break' }));

            // Aggregation
            const userMap = {};

            // Helper to get best available name
            const getUserName = (uid, sessionName) => {
                const u = users?.find(user => user.id === uid);
                if (u) return u.displayName || u.email;
                // Treat both the legacy English placeholder and the current Lithuanian one as
                // "no real name" so an old doc storing 'Unknown' never surfaces English; fall
                // back to the Lithuanian placeholder used everywhere else (resolveUserName).
                if (sessionName && sessionName !== 'Unknown' && sessionName !== 'Nežinomas') return sessionName;
                return 'Nežinomas';
            };

            // Helper to init user map
            const initUser = (uid, sessionName) => {
                if (!userMap[uid]) {
                    userMap[uid] = {
                        userId: uid,
                        name: getUserName(uid, sessionName),
                        totalMinutes: 0,
                        totalBreakMinutes: 0,
                        plannedMinutes: 0,
                        days: {} // { date: { totalWork: 0, totalBreak: 0, sessions: [] } }
                    };
                }
            };

            const isManager = isManagerRole(userRole);

            // Helper to check for duplicates
            const isDuplicate = (existingSessions, newSession) => {
                return existingSessions.some(existing => existing.id === newSession.id);
            };

            // Process Work
            workSessions.forEach(s => {
                const uid = resolveUserId(s);
                const uname = resolveUserName(s);
                if (!isManager && uid !== currentUser.uid) return;

                initUser(uid, uname);

                if (!userMap[uid].days[s.date]) {
                    userMap[uid].days[s.date] = { totalWork: 0, totalBreak: 0, sessions: [] };
                }

                // Deduplicate work sessions
                if (isDuplicate(userMap[uid].days[s.date].sessions, s)) {
                    return;
                }

                // Read-side guard: a corrupt single session (pre-clamp orphan, fat-fingered
                // edit) must not poison the total. Clamp before summing and flag the day so the
                // manager sees it was capped rather than silently inflated.
                const workMin = sanitizeReportMinutes(s.durationMinutes, { allowLarge: s.isManualAdjustment });
                if (isImplausibleSessionMinutes(s.durationMinutes, { allowLarge: s.isManualAdjustment })) {
                    userMap[uid].days[s.date].flagged = true;
                    userMap[uid].hasFlagged = true;
                }
                userMap[uid].totalMinutes += workMin;
                userMap[uid].days[s.date].totalWork += workMin;
                userMap[uid].days[s.date].sessions.push(s);
            });

            // Process Breaks
            breakSessions.forEach(s => {
                const uid = resolveUserId(s);
                const uname = resolveUserName(s);
                if (!isManager && uid !== currentUser.uid) return;

                // Only add breaks if user exists (or should we create? usually user has work too)
                // Let's create if missing to be safe
                if (!userMap[uid]) {
                    initUser(uid, uname);
                }

                if (!userMap[uid].days[s.date]) {
                    userMap[uid].days[s.date] = { totalWork: 0, totalBreak: 0, sessions: [] };
                }

                // Deduplicate break sessions
                if (isDuplicate(userMap[uid].days[s.date].sessions, s)) {
                    return;
                }

                const breakMin = sanitizeReportMinutes(s.durationMinutes);
                if (isImplausibleSessionMinutes(s.durationMinutes)) {
                    userMap[uid].days[s.date].flagged = true;
                    userMap[uid].hasFlagged = true;
                }
                userMap[uid].days[s.date].totalBreak += breakMin;
                userMap[uid].totalBreakMinutes += breakMin;
                userMap[uid].days[s.date].sessions.push(s);
            });

            // Post-process: Sort sessions by time for each day and inject inactive gaps
            Object.values(userMap).forEach(user => {
                Object.values(user.days).forEach(dayData => {
                    dayData.sessions.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

                    if (dayData.sessions.length > 0) {
                        dayData.dayStart = dayData.sessions[0].startTime;
                        // Find the latest end time
                        const maxEnd = dayData.sessions.reduce((max, s) => {
                            return new Date(s.endTime) > new Date(max) ? s.endTime : max;
                        }, dayData.sessions[0].endTime);
                        dayData.dayEnd = maxEnd;

                        // Inject 'inactive' sessions for gaps > 1 minute
                        const sessionsWithInactivity = [];
                        let lastEndTime = null;

                        dayData.sessions.forEach(session => {
                            const currentStartTime = new Date(session.startTime);

                            if (lastEndTime) {
                                const diffMs = currentStartTime.getTime() - lastEndTime.getTime();
                                const diffMinutes = Math.floor(diffMs / (1000 * 60));

                                // Only add gap if strictly > 1 minute and not negative (overlapping)
                                if (diffMinutes > 1) {
                                    sessionsWithInactivity.push({
                                        id: `inactive-${lastEndTime.getTime()}`,
                                        _type: 'inactive',
                                        startTime: lastEndTime.toISOString(),
                                        endTime: currentStartTime.toISOString(),
                                        durationMinutes: diffMinutes,
                                        taskTitle: 'Neaktyvus'
                                    });
                                }
                            }

                            sessionsWithInactivity.push(session);

                            // Update lastEndTime to the max of current lastEndTime and this session's endTime
                            // (Handle potential overlaps gracefully)
                            const currentEndTime = new Date(session.endTime);
                            if (!lastEndTime || currentEndTime > lastEndTime) {
                                lastEndTime = currentEndTime;
                            }
                        });

                        dayData.sessions = sessionsWithInactivity;
                    }
                });
            });

            // Planned vs actual: sum each worker's calendar-scheduled minutes that fall inside the
            // selected span, then attach to their row so the summary can show an overtime/undertime
            // delta. Only attached to workers who already have worked/break data in the span.
            plannedSnap.docs.forEach(d => {
                const wh = d.data();
                if (!wh.start || !wh.end) return;
                // Approved leave is time OFF, not planned work: counting an "Atostogos" slot
                // toward plannedMinutes makes a holiday week read as a planned shortfall against
                // a denominator the worker was never expected to fill. Exclude it from the plan.
                if (wh.isVacation) return;
                const uid = wh.userId;
                if (!uid) return;
                if (!isManager && uid !== currentUser.uid) return;
                const dayStr = getLithuanianDateString(new Date(wh.start));
                if (dayStr < startStr || dayStr > endStr) return;
                const mins = (new Date(wh.end).getTime() - new Date(wh.start).getTime()) / (1000 * 60);
                if (!Number.isFinite(mins) || mins <= 0) return;
                // Seed the row from the plan too: a worker who was scheduled but logged no
                // session in the span must still surface (worked 00:00, a real plan, a visible
                // negative Skirtumas) instead of vanishing — the mirror of the surplus case.
                initUser(uid);
                userMap[uid].plannedMinutes += mins;
            });
            Object.values(userMap).forEach(u => { u.plannedMinutes = Math.round(u.plannedMinutes); });

            // Expected-hours fallback: a worker who logged time but never hand-drew a calendar plan
            // would show plannedMinutes 0 and a meaningless Skirtumas. If they carry a
            // weeklyExpectedHours baseline, synthesize the plan for the span (baseline × weeks) so the
            // delta has a real denominator. Only fills a MISSING plan — a real calendar plan wins.
            const spanDays = Math.max(
                1,
                Math.round((new Date(endStr).getTime() - new Date(startStr).getTime()) / 86400000) + 1
            );
            const spanWeeks = spanDays / 7;
            Object.values(userMap).forEach(u => {
                if (u.plannedMinutes > 0) return;
                const usr = users?.find(x => x.id === u.userId);
                const baseline = usr?.weeklyExpectedHours;
                if (Number.isFinite(baseline) && baseline > 0) {
                    u.plannedMinutes = Math.round(baseline * 60 * spanWeeks);
                    u.plannedFromBaseline = true;
                }
            });

            // Convert to array
            const results = Object.values(userMap).sort((a, b) => b.totalMinutes - a.totalMinutes);
            setError('');
            setWorkData(results);

        } catch (error) {
            console.error("Error fetching work hours:", error);
            // Surface the failure as a friendly banner instead of silently leaving the report
            // empty — a swallowed fetch error otherwise reads as a genuine "no work" result.
            setError('Nepavyko užkrauti darbo valandų ataskaitos. Patikrinkite ryšį ir bandykite dar kartą.');
        } finally {
            setLoading(false);
        }
    };

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

            // Query 1: Archived - Respects date filter
            const archivedQ = query(
                collection(db, 'archived_tasks'),
                where('archivedAt', '>=', new Date(taskFilters.startDate).toISOString()),
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
                where('updatedAt', '>=', new Date(taskFilters.startDate).toISOString()),
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

            const start = new Date(taskFilters.startDate);
            const end = new Date(taskFilters.endDate);
            end.setHours(23, 59, 59); // End of day

            // Global filter
            allTasks = allTasks.filter(t => {
                // If it's unconfirmed (completed), we ALWAYS keep it (unless filtered by User/Tag)
                // If it's confirmed or archived, we respect date range
                const isUnconfirmed = t.status === 'completed';

                if (!isUnconfirmed) {
                    const dateStr = t.completedAt || t.archivedAt || t.updatedAt;
                    if (!dateStr) return false;
                    const d = new Date(dateStr);
                    if (d < start || d > end) return false;
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

    const fetchCalendarHistory = async () => {
        setLoading(true);
        try {
            const startStr = `${historyRange.start}T00:00:00.000Z`;
            const endStr = `${historyRange.end}T23:59:59.999Z`;

            const q = query(
                collection(db, 'calendar_requests'),
                where('createdAt', '>=', startStr),
                where('createdAt', '<=', endStr),
                orderBy('createdAt', 'desc')
            );

            const snap = await getDocs(q);
            const data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            // If it's a worker, only show their own history
            const isManager = isManagerRole(userRole);
            if (!isManager) {
                setCalendarHistory(data.filter(item => item.userId === currentUser.uid));
            } else {
                setCalendarHistory(data);
            }
            setError('');
        } catch (error) {
            console.error("Error fetching calendar history:", error);
            setError('Nepavyko užkrauti kalendoriaus istorijos. Patikrinkite ryšį ir bandykite dar kartą.');
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

            const taskRef = doc(db, 'tasks', task.id);
            await updateDoc(taskRef, {
                status: newStatus,
                confirmedAt: newStatus === 'confirmed' ? new Date().toISOString() : null,
                confirmedBy: newStatus === 'confirmed' ? (currentUser?.uid || null) : null,
                updatedAt: new Date().toISOString()
            });

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

    // Calendar-history period picker — same collapsible modal + preset logic as the work report,
    // but every preset (including 'day') resolves to a from/to range, since history is always a
    // range query (there is no special daily-timeline mode here).
    const chooseHistoryPeriod = (period) => {
        setHistoryPeriod(period);
        setHistoryPeriodOpen(false);
        const range = resolvePresetRange(period);
        if (range) setHistoryRange(range);
    };

    // Group tasks by date
    const groupedTasks = React.useMemo(() => {
        const groups = {};

        // Helper to get date string (YYYY-MM-DD)
        const getDateStr = (t) => {
            const dateStr = t.completedAt || t.archivedAt || t.updatedAt;
            if (!dateStr) return 'No Date';
            return dateStr.split('T')[0];
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

    // Helper to render table
    const TaskListTable = ({ tasks, title }) => (
        <div className="mb-6">
            {/* Mobile / touch: one card per task — never a horizontally-scrolling table (§9).
                Mirrors the desktop columns (confirm, status, priority, time, revert) as a card. */}
            <ul className="space-y-3 md:hidden">
                <li className="px-1 pb-1">
                    <h3 className="text-body font-bold text-ink">{title} ({tasks.length})</h3>
                </li>
                {tasks.map((task) => {
                    const dateStr = task.completedAt || task.archivedAt || task.updatedAt;
                    const worker = users?.find(u => u.id === task.assignedUserId);
                    const userName = worker ? (worker.displayName || worker.email) : (task.assignedUserName || '-');
                    const isConfirmed = task.status === 'confirmed';
                    const deleted = task.isDeleted || task.status === 'deleted';
                    const isManager = isManagerRole(userRole);
                    const isCompleter = task.completedBy === currentUser?.uid;
                    const canRevert = (isManager || isCompleter) && !task.isArchived;
                    return (
                        <li key={task.id} className="bg-surface-card rounded-card shadow-sm border border-line p-4 space-y-3">
                            <div className="flex items-start justify-between gap-2">
                                <div className={`min-w-0 flex-1 text-body-lg font-bold break-words ${deleted ? 'line-through text-ink-muted' : task.completed ? 'text-ink' : 'text-ink-strong'}`}>
                                    {!deleted && <CompletedMarker task={task} className="mr-1.5" />}
                                    {task.title}
                                </div>
                                <PriorityBadge priority={task.priority} />
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <AssigneeChip userId={task.assignedUserId} name={userName} firstNameOnly showIcon={false} />
                                {deleted ? <DeletedBadge /> : <TaskStatusPill task={task} />}
                                {dateStr && (
                                    <span className="text-caption text-ink-muted">{new Date(dateStr).toLocaleString()}</span>
                                )}
                            </div>
                            {task.description && (
                                <div className="text-caption text-ink-muted flex items-start gap-1 break-words">
                                    <Briefcase className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" aria-hidden="true" />
                                    <span className="whitespace-pre-wrap">{task.description}</span>
                                </div>
                            )}
                            <div className="flex items-center gap-2">
                                <span className="text-caption text-ink-muted">Plan. / Tikras:</span>
                                <span className="text-body-lg font-mono font-semibold text-ink-strong">
                                    <span className="text-brand">{task.estimatedTime || '-'}</span>
                                    <span className="text-ink-muted mx-1">/</span>
                                    <span>{formatMinutesToTimeString(calculateCurrentTotalMinutes(task))}</span>
                                </span>
                            </div>
                            <div className="flex items-center justify-between gap-2 pt-2 border-t border-line">
                                <label className={`flex items-center gap-2 min-h-touch ${task.isArchived ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                                    <input
                                        type="checkbox"
                                        checked={isConfirmed}
                                        onChange={() => handleToggleConfirm(task)}
                                        disabled={task.isArchived}
                                        aria-label={isConfirmed ? `Pažymėti „${task.title}“ kaip nepatvirtintą` : `Patvirtinti „${task.title}“`}
                                        className="w-5 h-5 rounded border-line text-feedback-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                    />
                                    <span className="text-caption text-ink">{isConfirmed ? 'Patvirtinta' : 'Nepatvirtinta'}</span>
                                </label>
                                <div className="flex items-center gap-1">
                                    <IconButton
                                        label="Peržiūrėti komentarus"
                                        onClick={() => setActiveModal({ type: 'comments', taskId: task.id, task: task })}
                                    >
                                        <MessageSquare className="w-4 h-4" aria-hidden="true" />
                                        {task.comments?.length > 0 && (
                                            <span className="ml-0.5 text-caption font-bold">{task.comments.length}</span>
                                        )}
                                    </IconButton>
                                    {canRevert && (
                                        <IconButton
                                            icon={RotateCcw}
                                            label="Grąžinti užduotį"
                                            onClick={() => handleRevert(task)}
                                        />
                                    )}
                                </div>
                            </div>
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
                        <th scope="col" className="px-2 py-2 text-center w-8 text-caption font-bold text-ink-muted uppercase tracking-wider">OK</th>
                        <th scope="col" className="px-2 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">UŽDUOTIS</th>
                        <th scope="col" className="px-1 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-12">DARB.</th>
                        <th scope="col" className="px-1 py-2 text-right text-caption font-bold text-ink-muted uppercase tracking-wider w-24">LAIKAS</th>
                        <th scope="col" className="px-1 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-16">PRIO</th>
                        <th scope="col" className="px-1 py-2 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-16">BŪSENA</th>
                        <th scope="col" className="px-1 py-2 text-center text-caption font-bold text-ink-muted uppercase tracking-wider w-10">KOM.</th>
                        <th scope="col" className="px-1 py-2 text-right text-caption font-bold text-ink-muted uppercase tracking-wider w-16"></th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-line">
                    {tasks.map((task) => {
                        const dateStr = task.completedAt || task.archivedAt || task.updatedAt;
                        const worker = users?.find(u => u.id === task.assignedUserId);
                        const userName = worker ? (worker.displayName || worker.email) : (task.assignedUserName || '-');
                        const isConfirmed = task.status === 'confirmed';

                        // Check permissions for revert button
                        const isManager = isManagerRole(userRole);
                        const isCompleter = task.completedBy === currentUser?.uid;
                        const canRevert = (isManager || isCompleter) && !task.isArchived;

                        return (
                            <TaskRow
                                key={task.id}
                                task={task}
                                rowClassName={`border-b border-line last:border-0 hover:bg-opacity-80 transition-colors ${isConfirmed ? 'bg-surface-card' : 'bg-feedback-info-soft'}`}
                                showConfirm
                                confirmChecked={isConfirmed}
                                confirmDisabled={task.isArchived}
                                onToggleConfirm={handleToggleConfirm}
                                confirmAriaLabel={isConfirmed ? `Pažymėti „${task.title}“ kaip nepatvirtintą` : `Patvirtinti „${task.title}“`}
                                assigneeName={userName}
                                commentCount={task.comments?.length || 0}
                                onOpenComments={() => setActiveModal({ type: 'comments', taskId: task.id, task: task })}
                                titleCell={
                                    <>
                                        <div className="flex items-center gap-2">
                                            <div className={`text-sm font-bold whitespace-normal break-words ${(task.isDeleted || task.status === 'deleted') ? 'line-through text-ink-muted' : task.completed ? 'text-ink' : 'text-ink-strong'}`}>
                                                {!(task.isDeleted || task.status === 'deleted') && <CompletedMarker task={task} className="mr-1.5" />}
                                                {task.title}
                                            </div>
                                            {(task.isDeleted || task.status === 'deleted') && <DeletedBadge />}
                                        </div>
                                        <div className="text-caption text-ink-muted mt-0.5 flex items-start gap-1">
                                            <Briefcase className="w-3 h-3 text-ink-muted flex-shrink-0 mt-0.5" />
                                            <span className="whitespace-normal break-words">{task.description || (task.tag ? `${task.tag}` : 'Užduotis')}</span>
                                        </div>
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
                                actions={
                                    canRevert && (
                                        <IconButton
                                            label="Grąžinti užduotį"
                                            variant="primary"
                                            onClick={() => handleRevert(task)}
                                            className="ml-auto bg-transparent text-brand hover:bg-brand-soft"
                                        >
                                            <RotateCcw className="w-4 h-4" aria-hidden="true" />
                                        </IconButton>
                                    )
                                }
                            />
                        );
                    })}
                </tbody>
            </table>
            </div>
        </div>
    );

    // Per-user "Dienos Išklotinė" panel — shared by the desktop expanded row and the mobile card
    // (keeps the day breakdown identical across both layouts instead of duplicating ~80 lines).
    // Derive the display fields for one calendar-history entry. Computed once and shared by the
    // mobile card and the desktop table so both layouts stay in sync (ISSUE #17b).
    const deriveCalendarEntry = (item) => {
        const workerLabel = item.userName || "Nežinomas vykdytojas";

        const eventStart = item.requestedEvent?.start || item.originalEvent?.start || null;
        const eventEnd = item.requestedEvent?.end || item.originalEvent?.end || null;
        const formatEventTime = (timeStr) => {
            if (!timeStr) return '-';
            const d = new Date(timeStr);
            return `${d.toLocaleDateString('lt-LT')} ${d.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit' })}`;
        };
        const calendarTimeLabel = `${formatEventTime(eventStart)} – ${formatEventTime(eventEnd)}`;
        const actionTimeLabel = new Date(item.createdAt).toLocaleString('lt-LT');

        const getActionColor = (action) => {
            if (action === 'add') return 'text-feedback-success bg-feedback-success-soft border-feedback-success-border';
            if (action === 'delete') return 'text-feedback-danger bg-feedback-danger-soft border-feedback-danger-border';
            return 'text-feedback-info bg-feedback-info-soft border-feedback-info-border';
        };
        const getActionText = (action) => {
            if (action === 'add') return 'Pridėjo';
            if (action === 'delete') return 'Ištrynė';
            return 'Redagavo';
        };

        const evt = item.requestedEvent || item.originalEvent || {};
        let TypeIcon = Briefcase;
        let typeLabel = "Veikla";
        let typeColor = "text-ink-muted";
        if (evt.isVacation) {
            TypeIcon = null;
            typeLabel = absenceLabel(evt) || "Atostogos";
            typeColor = "text-feedback-warning";
        } else if (evt.isWorkFromHome) {
            TypeIcon = null;
            typeLabel = "Veikla namuose";
            typeColor = "text-feedback-info";
        }

        let statusLabel = "Laukiama";
        let statusColor = "bg-feedback-warning-soft text-feedback-warning-text";
        if (item.status === 'approved') {
            statusLabel = "Patvirtinta";
            statusColor = "bg-feedback-success-soft text-feedback-success-text";
        } else if (item.status === 'declined') {
            statusLabel = "Atmesta";
            statusColor = "bg-feedback-danger-soft text-feedback-danger-text";
        }

        const getManagerName = (sysId) => {
            if (!sysId) return "-";
            if (sysId === 'system') return 'Sistema';
            const sysUser = users?.find(u => u.id === sysId);
            return sysUser ? (sysUser.displayName || sysUser.email) : sysId;
        };
        const managerLabel = item.approvedBy ? getManagerName(item.approvedBy) : "-";
        const reasonLabel = (item.reason === 'PlanningTime') ? "Suplanuota iš anksto" : (item.reason || "-");

        return {
            workerLabel, calendarTimeLabel, actionTimeLabel,
            actionColor: getActionColor(item.type), actionText: getActionText(item.type),
            TypeIcon, typeLabel, typeColor, statusLabel, statusColor, managerLabel, reasonLabel,
        };
    };

    return (
        <div className="space-y-6">
            {/* TABS — the calendar-change-history tab is a team/oversight feature, so it only
                appears in the manager team view. In a personal report (worker, or a manager
                viewing their OWN data via viewRole="worker") there is just one view, so the
                whole switcher is dropped. */}
            {isManagerRole(userRole) && (
                <div role="tablist" aria-label="Ataskaitų skiltys">
                    {/* Segmented switcher — same control as the Komandos darbai sub-tabs
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
                            Darbo ataskaita
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
                            Patvirtinimas
                        </button>
                        <div className="w-px bg-line" aria-hidden="true" />
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'calendar-history'}
                            onClick={() => setActiveTab('calendar-history')}
                            className={cn(
                                'flex-1 sm:flex-none inline-flex items-center justify-center px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold text-center leading-tight transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                activeTab === 'calendar-history' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            Kalendoriaus pakeitimų istorija
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
                <div className="space-y-4">
                    {/* Period selector + CSV export share one row: the collapsible period card
                        flexes to fill; the export button sits beside it (icon-only on mobile,
                        icon+label on desktop) and appears only for a multi-day range (day mode
                        has no export). The button reveals the range ladder (week → month →
                        3 months → year) and a custom date picker. */}
                    <div className="flex items-start gap-2">
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
                    {reportPeriod !== 'day' && isManagerRole(userRole) && workData.length > 0 && (() => {
                        const testIds = new Set((users || []).filter((u) => u.isTest).map((u) => u.id));
                        const rows = showTestUsers ? workData : workData.filter((u) => !testIds.has(u.userId));
                        if (rows.length === 0) return null;
                        // Count only workers whose plan actually covers the span — the same predicate
                        // the CSV's Skirtumas gate uses — so the indicator and the export agree on
                        // who has a usable plan (a thin real plan that the CSV blanks is NOT counted).
                        const withPlan = rows.filter((u) =>
                            u.plannedMinutes > 0 &&
                            (u.totalMinutes <= 0 || u.plannedMinutes >= PLAN_COVERAGE_FLOOR * u.totalMinutes)
                        ).length;
                        return (
                            <p className="mb-3 px-1 text-caption text-ink-muted">
                                Planą turi {withPlan} iš {rows.length} vykdytojų
                                {withPlan < rows.length ? ' — likusiems „Skirtumas" neskaičiuojamas.' : '.'}
                            </p>
                        );
                    })()}

                    {/* On-screen team summary — manager-only, multi-day ranges only. Reuses the same
                        aggregated report the download produces (buildReport): the team rollup with
                        period-over-period deltas, plus an "Įspėjimai" list of workers whose sessions
                        were clamped (dataTrust.implausibleSessions > 0), each linking into that
                        worker's day timeline so the manager can fix them. */}
                    {reportPeriod !== 'day' && isManagerRole(userRole) && (
                        <TeamPeriodSummary
                            range={dateRange}
                            users={users}
                            scope={{ userData, uid: currentUser?.uid, effectiveRole: userRole }}
                            onDrillWorker={(userId, name) => setSummaryDrillWorker({ userId, name })}
                        />
                    )}

                    {/* Day mode → the live daily timeline. Any multi-day range → the same view
                        aggregated over [start, end] (summary cards, sort filters).
                        On the manager team view the task-confirmation lists and history move to the
                        dedicated "Patvirtinimas" tab, so this tab shows only the work-hours surface
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

            {/* --- APPROVAL TAB: today's finished + awaiting-confirmation tasks and the task-history
                archive, scoped to the tasks this manager is responsible for. --- */}
            {activeTab === 'approval' && (
                <DailyStatistics
                    currentUser={currentUser}
                    userRole={userRole}
                    users={users}
                    canExport={canExport}
                    view="approval"
                />
            )}

            {/* --- CALENDAR HISTORY TAB CONTENT --- */}
            {activeTab === 'calendar-history' && (
                <div className="space-y-4">
                    {/* Period selector — identical collapsible modal to the work report tab, so
                        calendar filtering behaves the same everywhere in the app. */}
                    <PeriodPicker
                        presets={PERIOD_PRESETS}
                        activeId={historyPeriod}
                        onChoose={chooseHistoryPeriod}
                        open={historyPeriodOpen}
                        onToggle={() => setHistoryPeriodOpen((o) => !o)}
                        label="Laikotarpis"
                    >
                        <div className="flex flex-col gap-3 border-t border-line pt-3 sm:flex-row sm:items-end">
                            <div className="flex-1">
                                <label htmlFor="history-from" className="block text-caption font-semibold text-ink-muted mb-1">Nuo</label>
                                <DatePicker
                                    id="history-from"
                                    value={historyRange.start}
                                    max={historyRange.end}
                                    onChange={(v) => { setHistoryPeriod('custom'); setHistoryRange(prev => ({ ...prev, start: v })); }}
                                />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="history-to" className="block text-caption font-semibold text-ink-muted mb-1">Iki</label>
                                <DatePicker
                                    id="history-to"
                                    value={historyRange.end}
                                    min={historyRange.start}
                                    max={getLithuanianDateString()}
                                    onChange={(v) => { setHistoryPeriod('custom'); setHistoryRange(prev => ({ ...prev, end: v })); }}
                                />
                            </div>
                        </div>
                    </PeriodPicker>

                    {loading && (
                        <div className="bg-surface-card rounded-card shadow-sm">
                            <Spinner label="Kraunami duomenys…" />
                        </div>
                    )}

                    {!loading && !error && calendarHistory.length === 0 && (
                        <div className="bg-surface-card p-8 rounded-card shadow-sm text-center text-ink-muted">
                            Pagal pasirinktą laikotarpį nėra išsaugota jokių kalendoriaus pakeitimų istorijoje.
                        </div>
                    )}

                    {!loading && calendarHistory.length > 0 && (
                        <>
                            {/* Mobile / touch: one card per change (never a horizontally-scrolling table — §9) */}
                            <ul className="space-y-3 md:hidden">
                                {calendarHistory.map((item) => {
                                    const e = deriveCalendarEntry(item);
                                    const { TypeIcon } = e;
                                    return (
                                        <li key={item.id} className="bg-surface-card rounded-card border border-line shadow-sm p-4 space-y-3">
                                            <div className="flex items-start justify-between gap-2">
                                                <span className="text-body font-bold text-ink-strong truncate">{e.workerLabel}</span>
                                                <span className={`shrink-0 px-2 py-0.5 rounded-full text-caption font-bold ${e.statusColor}`}>
                                                    {e.statusLabel}
                                                </span>
                                            </div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className={`px-2 py-0.5 rounded text-caption uppercase font-bold border ${e.actionColor}`}>
                                                    {e.actionText}
                                                </span>
                                                <span className={`text-caption font-semibold flex items-center gap-1 ${e.typeColor}`}>
                                                    {TypeIcon && <TypeIcon className="w-3.5 h-3.5" aria-hidden="true" />}
                                                    {e.typeLabel}
                                                </span>
                                            </div>
                                            <dl className="grid grid-cols-1 gap-1 text-body">
                                                <div className="flex flex-col">
                                                    <dt className="text-caption uppercase font-bold tracking-wide text-ink-muted">Data ir laikas</dt>
                                                    <dd className="font-mono text-ink">{e.calendarTimeLabel}</dd>
                                                </div>
                                                <div className="flex flex-col">
                                                    <dt className="text-caption uppercase font-bold tracking-wide text-ink-muted">Keitimo laikas</dt>
                                                    <dd className="font-mono text-ink-muted">{e.actionTimeLabel}</dd>
                                                </div>
                                                <div className="flex flex-col">
                                                    <dt className="text-caption uppercase font-bold tracking-wide text-ink-muted">Patvirtino</dt>
                                                    <dd className="text-ink">{e.managerLabel}</dd>
                                                </div>
                                                {e.reasonLabel !== '-' && (
                                                    <div className="flex flex-col">
                                                        <dt className="text-caption uppercase font-bold tracking-wide text-ink-muted">Priežastis</dt>
                                                        <dd className="italic text-ink break-words">{e.reasonLabel}</dd>
                                                    </div>
                                                )}
                                            </dl>
                                        </li>
                                    );
                                })}
                            </ul>

                            {/* Desktop / wide: denser table is allowed (§9) */}
                            <div className="hidden bg-surface-card rounded-card shadow-sm border border-line overflow-x-auto md:block">
                                <table className="min-w-full divide-y divide-line">
                                    <thead className="bg-surface-sunken">
                                        <tr>
                                            <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Vykdytojas</th>
                                            <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Data ir laikas (kalendoriuje)</th>
                                            <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Veiksmas / tipas</th>
                                            <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Keitimo laikas</th>
                                            <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Patvirtino / būsena</th>
                                            <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Priežastis</th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-surface-card divide-y divide-line">
                                        {calendarHistory.map((item) => {
                                            const e = deriveCalendarEntry(item);
                                            const { TypeIcon } = e;
                                            return (
                                                <tr key={item.id} className="hover:bg-surface-sunken transition-colors">
                                                    <td className="px-4 py-3 whitespace-nowrap text-body font-medium text-ink-strong">
                                                        {e.workerLabel}
                                                    </td>
                                                    <td className="px-4 py-3 whitespace-nowrap text-caption text-ink-muted font-mono">
                                                        {e.calendarTimeLabel}
                                                    </td>
                                                    <td className="px-4 py-3 whitespace-nowrap">
                                                        <div className="flex flex-col gap-1 items-start">
                                                            <span className={`px-2 py-0.5 rounded text-caption uppercase font-bold border ${e.actionColor}`}>
                                                                {e.actionText}
                                                            </span>
                                                            <span className={`text-caption font-semibold flex items-center gap-1 ${e.typeColor}`}>
                                                                {TypeIcon && <TypeIcon className="w-3 h-3" aria-hidden="true" />}
                                                                {e.typeLabel}
                                                            </span>
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3 whitespace-nowrap text-caption text-ink-muted font-mono">
                                                        {e.actionTimeLabel}
                                                    </td>
                                                    <td className="px-4 py-3 whitespace-nowrap">
                                                        <div className="flex flex-col gap-1 items-start">
                                                            <span className={`px-2 py-0.5 rounded-full text-caption font-bold ${e.statusColor}`}>
                                                                {e.statusLabel}
                                                            </span>
                                                            <span className="text-caption text-ink-muted font-medium">
                                                                {e.managerLabel}
                                                            </span>
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3 text-body text-ink italic max-w-xs break-words">
                                                        {e.reasonLabel}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </div>
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
                                <label className="block text-caption font-semibold text-ink-muted mb-1">Filtruoti pagal Vykdytoją</label>
                                <Select
                                    value={taskFilters.userId}
                                    onChange={(val) => setTaskFilters(prev => ({ ...prev, userId: val }))}
                                    options={[
                                        { value: 'all', label: 'Visi Vykdytojai' },
                                        ...(users?.map((u) => ({ value: u.id, label: formatDisplayName(u.displayName || u.email) })) || []),
                                    ]}
                                    label="Vykdytojas"
                                    ariaLabel="Filtruoti pagal vykdytoją"
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

// One team-rollup metric tile with an optional period-over-period delta. The delta is derived by
// diffing the current vs previous team total (both from buildReport), so its arrow/colour mean the
// same thing as the per-worker deltas in the downloaded report. `goodWhen` says which direction is
// an improvement so colour never contradicts the numbers (more hours/tasks = up-good; on-time % up
// = good). Colour is paired with an arrow + sign, never the sole signal (DESIGN_SYSTEM §5).
function SummaryStat({ label, value, delta }) {
    let Arrow = Minus;
    let tone = 'text-ink-muted';
    if (delta && delta.pct !== 0) {
        Arrow = delta.improved ? TrendingUp : TrendingDown;
        tone = delta.improved ? 'text-feedback-success' : 'text-feedback-danger';
    }
    return (
        <div className="flex flex-col px-1">
            <span className="text-caption text-ink-muted">{label}</span>
            <span className="mt-0.5 text-h3 font-bold text-ink-strong tabular-nums">{value}</span>
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
function TeamPeriodSummary({ range, users, scope, onDrillWorker }) {
    const { userData, uid, effectiveRole } = scope || {};
    const [state, setState] = useState({ loading: true, team: null, prevTeam: null, warnings: [], error: false });

    // The roster the summary covers — everyone the viewer may see, minus disabled and test accounts
    // (Reports never counts test users), matching the export modal's candidate list.
    const workerIds = useMemo(() => {
        const roster = scopeRoster(users, userData, uid) || [];
        return roster.filter((u) => !u.isDisabled && !u.isTest).map((u) => u.id);
    }, [users, userData, uid]);

    const startStr = range?.start;
    const endStr = range?.end;

    useEffect(() => {
        let ignore = false;
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
                const generatedAt = new Date().toISOString();
                // Current report carries the team rollup + per-worker dataTrust we surface.
                const current = buildReport({ generatedAt, window, prevWindow, scopeLabel: '', includeEarnings: true, workers });
                // A second build over the PREVIOUS window (already fetched) gives a real prior team
                // total to diff — true team-level deltas without modifying the aggregator.
                const previous = buildReport({ generatedAt, window: prevWindow, prevWindow, scopeLabel: '', includeEarnings: true, workers });
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
        // eslint-disable-next-line react-hooks/exhaustive-deps -- userData/users read through the stable workerIds + scope ids; depending on the whole objects would refetch on every parent render
    }, [startStr, endStr, workerIds, uid, effectiveRole]);

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
            <div className="mb-4 rounded-card border border-line bg-surface-card p-4 shadow-sm">
                <Spinner label="Kraunama komandos suvestinė…" />
            </div>
        );
    }
    // Silent when there is nothing to summarise or the build failed — the report below still stands.
    if (state.error || !state.team || state.team.workerCount === 0) return null;

    const t = state.team;
    const p = state.prevTeam;

    return (
        <section
            className="mb-4 rounded-card border border-line bg-surface-card p-4 shadow-sm"
            aria-label="Komandos laikotarpio suvestinė"
        >
            <div className="mb-3 flex items-center gap-2">
                <Users className="h-5 w-5 text-brand" aria-hidden="true" />
                <h3 className="text-body font-bold text-ink-strong">Komandos suvestinė</h3>
                <span className="ml-auto font-mono text-caption text-ink-muted">{startStr} – {endStr}</span>
            </div>

            <div className="grid grid-cols-2 gap-x-2 gap-y-4 divide-line sm:grid-cols-4 sm:divide-x">
                <SummaryStat label="Vykdytojų" value={t.workerCount} />
                <SummaryStat
                    label="Viso dirbta"
                    value={formatStatValue(t.totalHours, 'hours')}
                    delta={p ? delta(t.totalHours, p.totalHours) : null}
                />
                <SummaryStat
                    label="Užbaigta užduočių"
                    value={t.completedTasks}
                    delta={p ? delta(t.completedTasks, p.completedTasks) : null}
                />
                {Number.isFinite(t.avgOnTimePct) ? (
                    <SummaryStat
                        label="Vid. punktualus startas"
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
        </section>
    );
}
