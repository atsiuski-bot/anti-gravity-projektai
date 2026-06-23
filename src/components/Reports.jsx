import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, orderBy, doc, updateDoc } from 'firebase/firestore';
import { formatMinutesToTimeString, formatMinutesToHHMM, formatSignedMinutesToHHMM, getLithuanianDateString, calculateCurrentTotalMinutes, addDaysToDateString, sanitizeReportMinutes, isImplausibleSessionMinutes } from '../utils/timeUtils';
import { formatDisplayName, isManagerRole, resolveUserId, resolveUserName } from '../utils/formatters';
import { privateScopeConstraints } from '../utils/teamScope';
import { absenceLabel } from '../utils/absence';
import { addComment } from '../utils/commentActions';
import { ChevronDown, ChevronUp, Briefcase, MessageSquare, RotateCcw, AlertTriangle, Download, Calendar } from 'lucide-react';

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
import { CommentsModal } from './TaskDetailsModals';
import { useAuth } from '../context/AuthContext';
import { TASK_TAGS } from '../utils/taskUtils';

// Period ladder for the unified report tab: a single day (default) up through the year, plus a
// custom range driven by the date pickers. 'day' shows the daily timeline; the rest show the
// detailed work summary for the resolved date range.
const PERIOD_PRESETS = [
    { id: 'day', label: 'Ši diena' },
    { id: 'week', label: 'Ši savaitė' },
    { id: 'month', label: 'Šis mėnuo' },
    { id: '3months', label: '3 mėnesiai' },
    { id: 'year', label: 'Šie metai' },
];

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
                if (sessionName && sessionName !== 'Unknown') return sessionName;
                return 'Unknown';
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
            setWorkData(results);

        } catch (error) {
            console.error("Error fetching work hours:", error);
        } finally {
            setLoading(false);
        }
    };

    const fetchTasks = async () => {
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

            setFilteredTasks(sortedTasks);

        } catch (error) {
            console.error("Error fetching tasks:", error);
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
        } catch (error) {
            console.error("Error fetching calendar history:", error);
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
                confirmedBy: newStatus === 'confirmed' ? 'MANAGER' : null,
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
            fetchTasks(); // Refresh on error
        } finally {
            setReverting(false);
        }
    };

    // Resolve a period preset to a from/to range. All math is pure date-string arithmetic
    // (addDaysToDateString is DST-safe), weeks are Monday-started per Lithuanian convention, and
    // every range ends "today" so the report always runs up to the current day. Pure (returns the
    // range) so both the work-report and calendar-history pickers can share one source of truth.
    const resolvePresetRange = (preset) => {
        const today = getLithuanianDateString();
        const pad = (n) => String(n).padStart(2, '0');
        const dayOfWeek = (dateStr) => {
            const [y, m, d] = dateStr.split('-').map(Number);
            return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
        };
        const firstOfMonth = (dateStr) => `${dateStr.slice(0, 7)}-01`;
        const mondayOffset = (dayOfWeek(today) + 6) % 7; // days since this week's Monday
        const [y, m] = today.split('-').map(Number);

        let start;
        const end = today;
        switch (preset) {
            case 'day':
                start = today;
                break;
            case 'week':
                start = addDaysToDateString(today, -mondayOffset);
                break;
            case 'month':
                start = firstOfMonth(today);
                break;
            case '3months': {
                // Current month plus the two preceding it = 3 calendar months through today.
                const d = new Date(Date.UTC(y, m - 1 - 2, 1));
                start = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
                break;
            }
            case 'year':
                start = `${today.slice(0, 4)}-01-01`;
                break;
            default:
                return null;
        }
        return { start, end };
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

    // Human label for the currently selected period (shown on the collapsed picker button).
    const periodLabel = reportPeriod === 'custom'
        ? `${dateRange.start} – ${dateRange.end}`
        : (PERIOD_PRESETS.find((p) => p.id === reportPeriod)?.label ?? `${dateRange.start} – ${dateRange.end}`);

    // Calendar-history period picker — same collapsible modal + preset logic as the work report,
    // but every preset (including 'day') resolves to a from/to range, since history is always a
    // range query (there is no special daily-timeline mode here).
    const chooseHistoryPeriod = (period) => {
        setHistoryPeriod(period);
        setHistoryPeriodOpen(false);
        const range = resolvePresetRange(period);
        if (range) setHistoryRange(range);
    };

    const historyPeriodLabel = historyPeriod === 'custom'
        ? `${historyRange.start} – ${historyRange.end}`
        : (PERIOD_PRESETS.find((p) => p.id === historyPeriod)?.label ?? `${historyRange.start} – ${historyRange.end}`);

    // Export the already-computed hours summary to a CSV the manager can hand to payroll.
    // One row per worker-day (work + break, HH:MM), then a per-worker "Viso" total row.
    // Mirrors TaskHistory.handleExportCSV: same escapeCSV rules + UTF-8 BOM so Excel reads
    // the Lithuanian characters correctly. workData is whatever the current month resolved to.
    const handleExportHoursCSV = () => {
        const escapeCSV = (str) => {
            if (str === null || str === undefined) return '';
            const s = String(str);
            if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        };

        const headers = ['Vykdytojas', 'Data', 'Darbas (val:min)', 'Pertraukos (val:min)', 'Planuota (val:min)', 'Skirtumas (val:min)'];
        const rows = [];

        // Exclude test/founder accounts from the payroll export unless the manager opted in, so
        // team totals and the per-worker list aren't skewed by non-production rows.
        const testUserIds = new Set((users || []).filter(u => u.isTest).map(u => u.id));
        const rowsSource = showTestUsers ? workData : workData.filter(u => !testUserIds.has(u.userId));

        rowsSource.forEach(userStats => {
            const workerName = formatDisplayName(userStats.name);
            Object.entries(userStats.days)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .forEach(([date, dayData]) => {
                    rows.push([
                        escapeCSV(workerName),
                        escapeCSV(date),
                        escapeCSV(formatMinutesToHHMM(dayData.totalWork)),
                        escapeCSV(formatMinutesToHHMM(dayData.totalBreak)),
                        '',
                        '',
                    ].join(','));
                });
            // Export-time self-check: the Viso total and the per-day rows are built from one
            // sanitized userMap, so they must agree; a divergence beyond rounding signals a
            // malformed/merged dataset and is surfaced to the console rather than shipped silently.
            const daySum = Object.values(userStats.days).reduce((a, d) => a + (d.totalWork || 0), 0);
            if (Math.abs(daySum - userStats.totalMinutes) > 1) {
                console.warn(`[Reports] Viso/detalės neatitikimas (${workerName}): viso ${Math.round(userStats.totalMinutes)} vs dienų suma ${Math.round(daySum)} min`);
            }
            const hasPlan = userStats.plannedMinutes > 0;
            // Worked == 0 with a plan is a genuine 100% shortfall (a planned-but-absent worker),
            // so it is allowed through; only a non-trivial worked total against a tiny plan is
            // treated as inadequate coverage.
            const planCoversSpan = hasPlan && (
                userStats.totalMinutes <= 0 ||
                userStats.plannedMinutes >= PLAN_COVERAGE_FLOOR * userStats.totalMinutes
            );
            const plannedCell = hasPlan ? formatMinutesToHHMM(userStats.plannedMinutes) : '';
            const skirtumasCell = !hasPlan
                ? ''
                : (planCoversSpan
                    ? formatSignedMinutesToHHMM(userStats.totalMinutes - userStats.plannedMinutes)
                    : 'Nepakanka plano');
            rows.push([
                escapeCSV(workerName),
                escapeCSV('Viso'),
                escapeCSV(formatMinutesToHHMM(userStats.totalMinutes)),
                escapeCSV(formatMinutesToHHMM(userStats.totalBreakMinutes)),
                escapeCSV(plannedCell),
                escapeCSV(skirtumasCell),
            ].join(','));
        });

        const csvContent = [headers.join(','), ...rows].join('\n');
        // BOM so Excel recognises UTF-8 (Lithuanian diacritics).
        const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `darbo_valandos_${dateRange.start}_${dateRange.end}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
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
        let typeLabel = "Darbas ofise";
        let typeColor = "text-ink-muted";
        if (evt.isVacation) {
            TypeIcon = null;
            typeLabel = absenceLabel(evt) || "Atostogos";
            typeColor = "text-feedback-warning";
        } else if (evt.isWorkFromHome) {
            TypeIcon = null;
            typeLabel = "Nuotolinis darbas";
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
                <div role="tablist" aria-label="Ataskaitų skiltys" className="flex border-b border-line overflow-x-auto">

                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'report'}
                        onClick={() => setActiveTab('report')}
                        className={`px-4 py-2 font-medium text-sm transition-colors whitespace-nowrap border-b-2 ${activeTab === 'report' ? 'border-brand text-brand' : 'border-transparent text-ink-muted hover:text-ink'
                            }`}
                    >
                        Darbo ataskaita
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'approval'}
                        onClick={() => setActiveTab('approval')}
                        className={`px-4 py-2 font-medium text-sm transition-colors whitespace-nowrap border-b-2 ${activeTab === 'approval' ? 'border-brand text-brand' : 'border-transparent text-ink-muted hover:text-ink'
                            }`}
                    >
                        Patvirtinimas
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'calendar-history'}
                        onClick={() => setActiveTab('calendar-history')}
                        className={`px-4 py-2 font-medium text-sm transition-colors whitespace-nowrap border-b-2 ${activeTab === 'calendar-history' ? 'border-brand text-brand' : 'border-transparent text-ink-muted hover:text-ink'
                            }`}
                    >
                        Kalendoriaus pakeitimų istorija
                    </button>

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
                        <div className="flex-1 bg-surface-card rounded-card shadow-sm border border-line">
                        <button
                            type="button"
                            onClick={() => setPeriodOpen((o) => !o)}
                            aria-expanded={periodOpen}
                            className="w-full min-h-touch flex items-center justify-between gap-3 px-4 py-3 text-left rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        >
                            <span className="flex items-center gap-2 text-caption uppercase font-bold tracking-wide text-ink-muted">
                                <Calendar className="w-4 h-4" aria-hidden="true" />
                                Laikotarpis
                            </span>
                            <span className="flex items-center gap-2 min-w-0">
                                <span className="text-body font-semibold text-ink-strong truncate">{periodLabel}</span>
                                {periodOpen
                                    ? <ChevronUp className="w-4 h-4 text-ink-muted shrink-0" aria-hidden="true" />
                                    : <ChevronDown className="w-4 h-4 text-ink-muted shrink-0" aria-hidden="true" />}
                            </span>
                        </button>

                        {periodOpen && (
                            <div className="border-t border-line p-3 space-y-3 animate-in fade-in slide-in-from-top-2">
                                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                                    {PERIOD_PRESETS.map((p) => (
                                        <Button
                                            key={p.id}
                                            variant={reportPeriod === p.id ? 'primary' : 'secondary'}
                                            onClick={() => choosePeriod(p.id)}
                                            className="justify-center"
                                        >
                                            {p.label}
                                        </Button>
                                    ))}
                                </div>
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
                            </div>
                        )}
                        </div>

                        {reportPeriod !== 'day' && (
                            <Button
                                variant="success"
                                icon={Download}
                                onClick={handleExportHoursCSV}
                                disabled={loading || workData.length === 0}
                                aria-label="Eksportuoti CSV"
                                className="shrink-0 px-3 sm:px-4"
                            >
                                <span className="hidden sm:inline">Eksportuoti CSV</span>
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
                                Planą turi {withPlan} iš {rows.length} darbuotojų
                                {withPlan < rows.length ? ' — likusiems „Skirtumas" neskaičiuojamas.' : '.'}
                            </p>
                        );
                    })()}

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
                    <div className="bg-surface-card rounded-card shadow-sm border border-line">
                        <button
                            type="button"
                            onClick={() => setHistoryPeriodOpen((o) => !o)}
                            aria-expanded={historyPeriodOpen}
                            className="w-full min-h-touch flex items-center justify-between gap-3 px-4 py-3 text-left rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        >
                            <span className="flex items-center gap-2 text-caption uppercase font-bold tracking-wide text-ink-muted">
                                <Calendar className="w-4 h-4" aria-hidden="true" />
                                Laikotarpis
                            </span>
                            <span className="flex items-center gap-2 min-w-0">
                                <span className="text-body font-semibold text-ink-strong truncate">{historyPeriodLabel}</span>
                                {historyPeriodOpen
                                    ? <ChevronUp className="w-4 h-4 text-ink-muted shrink-0" aria-hidden="true" />
                                    : <ChevronDown className="w-4 h-4 text-ink-muted shrink-0" aria-hidden="true" />}
                            </span>
                        </button>

                        {historyPeriodOpen && (
                            <div className="border-t border-line p-3 space-y-3 animate-in fade-in slide-in-from-top-2">
                                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                                    {PERIOD_PRESETS.map((p) => (
                                        <Button
                                            key={p.id}
                                            variant={historyPeriod === p.id ? 'primary' : 'secondary'}
                                            onClick={() => chooseHistoryPeriod(p.id)}
                                            className="justify-center"
                                        >
                                            {p.label}
                                        </Button>
                                    ))}
                                </div>
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
                            </div>
                        )}
                    </div>

                    {loading && (
                        <div className="bg-surface-card rounded-card shadow-sm">
                            <Spinner label="Kraunami duomenys…" />
                        </div>
                    )}

                    {!loading && calendarHistory.length === 0 && (
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

                            {groupedTasks.length === 0 && (
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
