import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, updateDoc, setDoc, deleteDoc, addDoc } from 'firebase/firestore';
import { formatMinutesToTimeString, getLithuanianDateString, getLithuanianWeekday, getLithuanian3AMCutoff, addDaysToDateString, calculateCurrentTotalMinutes } from '../utils/timeUtils';
import { formatDisplayName, formatTime, isManagerRole, resolveUserId, resolveUserName } from '../utils/formatters';
import { privateScopeConstraints, isScopedManager } from '../utils/teamScope';
import { useAuth } from '../context/AuthContext';
import PriorityBadge from './task/PriorityBadge';
import DeletedBadge from './task/DeletedBadge';
import TaskStatusPill from './task/TaskStatusPill';
import TimeChangedWarning from './task/TimeChangedWarning';
import TaskRow from './task/TaskRow';
import { addComment } from '../utils/commentActions';
import { logError } from '../utils/errorLog';
import { Calendar, Clock, Coffee, User, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Zap, MessageSquare, Check, Filter, RotateCcw, X, Pencil } from 'lucide-react';
import clsx from 'clsx';
import { CommentsModal } from './TaskDetailsModals';
import TaskHistory from './TaskHistory';
import SessionTypeIcon from './SessionTypeIcon';
import IconButton from './ui/IconButton';
import ConfirmDialog from './ui/ConfirmDialog';
import Modal from './ui/Modal';
import TaskModal from './TaskModal';

export default function DailyStatistics({ currentUser, userRole, users = [], canExport = false, dateRange = null, forceUserId = null, initialDate = null, embedded = false, view = 'full' }) {
    // userData carries the auth identity (role + scopedManager) the listeners scope against;
    // `userRole` prop is the surface's effective role (a manager's own report passes 'worker').
    const { userData } = useAuth();
    const scoped = isScopedManager(userData);
    const scopeUid = currentUser?.uid;
    // Managers see the whole team here; workers see only themselves. The per-member picker was
    // removed (individual drill-down moves to the team calendar), so this is fixed at mount and
    // never changes — no setter. `forceUserId` overrides it: the team calendar opens this view
    // embedded in a modal, scoped to one clicked worker. Narrowing is client-side only — the
    // Firestore listeners still scope by role via privateScopeConstraints, so this never widens
    // what the viewer may read.
    const [selectedUserId] = useState(forceUserId ?? (isManagerRole(userRole) ? 'all' : currentUser?.uid));
    const [selectedDate, setSelectedDate] = useState(initialDate ?? getLithuanianDateString());
    const [, setLoading] = useState(false);

    // When a date range is supplied (the period report), the component aggregates the whole span
    // instead of a single day: the day stepper, the live ticker, the per-day timeline gaps and the
    // "day start/end" card are dropped, but the summary cards, the sort filters and the finished-
    // task list all compute over [rangeStart, rangeEnd]. With no range it stays a single-day view,
    // byte-for-byte identical to before (rangeStart === rangeEnd === selectedDate).
    const isRange = !!(dateRange && dateRange.start && dateRange.end);
    const rangeStart = isRange ? dateRange.start : selectedDate;
    const rangeEnd = isRange ? dateRange.end : selectedDate;

    // Data states
    const [, setDailyStats] = useState(null); // From daily_stats collection (legacy/ref for other stats if any)
    const [breakSessions, setBreakSessions] = useState([]); // from break_sessions collection
    const [sessions, setSessions] = useState([]); // From work_sessions collection
    const [, setScheduledTasks] = useState([]); // Tasks planned for this weekday
    const [finishedTasks, setFinishedTasks] = useState([]); // Tasks finished on this specific date

    // Ticker for active sessions
    const [currentTime, setCurrentTime] = useState(new Date());

    useEffect(() => {
        if (selectedDate !== getLithuanianDateString()) return;
        const interval = setInterval(() => {
            setCurrentTime(new Date());
        }, 60000); // Update every minute
        return () => clearInterval(interval);
    }, [selectedDate]);

    // Modal state
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null, task: null });

    // Friendly, mapped error copy shown in the inline banner (never raw err.message — §10)
    const [actionError, setActionError] = useState('');

    // Restore confirmation (replaces window.confirm — §8)
    const [restoreTarget, setRestoreTarget] = useState(null);
    const [restoring, setRestoring] = useState(false);

    // Per-worker drill-down: clicking a row in the team "Darbo valandos" summary opens a
    // modal listing everything that worker touched that day — both finished work and the
    // session still running — without forcing the manager to switch the user filter.
    const [workerDetail, setWorkerDetail] = useState(null); // { userId, name } | null

    // Clicking a work card inside that drill-down opens the full task. We swap modals rather
    // than stack them (two focus-trapped dialogs fight) — the worker modal closes, the task
    // opens; closing the task returns to the day statistics.
    const [openTaskDetail, setOpenTaskDetail] = useState(null); // task | null

    // Calculate previous/next day
    const handleDateChange = (offset) => {
        const date = new Date(selectedDate);
        date.setDate(date.getDate() + offset);
        setSelectedDate(getLithuanianDateString(date));
    };

    const [expandedTasks, setExpandedTasks] = useState(new Set());

    const toggleExpand = (taskId) => {
        const newExpanded = new Set(expandedTasks);
        if (newExpanded.has(taskId)) {
            newExpanded.delete(taskId);
        } else {
            newExpanded.add(taskId);
        }
        setExpandedTasks(newExpanded);
    };

    useEffect(() => {
        if (!selectedUserId || !rangeStart || !rangeEnd) return;

        setLoading(true);
        const weekday = getLithuanianWeekday(rangeStart);

        // Clear previous data to avoid stale state
        setDailyStats(null);
        setSessions([]);
        setScheduledTasks([]);
        setFinishedTasks([]);



        // 1. Listen to Break Sessions by the canonical Vilnius-local 'date' field, the
        // same key the work_sessions query below and Reports.jsx use. The old query
        // filtered a naive `${date}T00:00:00`..`T23:59:59` range against the UTC
        // `startTime`, so a break taken after Vilnius midnight (stored under the previous
        // UTC date) fell out of the day and breaks in the 00:00-03:00 window bled across
        // the work-day boundary. Equality on a single field needs only the automatic
        // index (no composite), so we sort by startTime client-side rather than via
        // orderBy on a second field (which would demand a composite index this repo
        // has no firestore.indexes.json to declare). A range query (>= start, <= end) on
        // the same single field stays within that automatic index, so the period view
        // needs no extra index either — single day is just rangeStart === rangeEnd.
        // Constrain each private listener to the rows this viewer may read (own / team /
        // whole-company), so nothing is denied once the rules tighten. work_hours/calendar stay
        // public and are not read here. Composite indexes (owner|team field + date/archivedAt) are
        // declared in firestore.indexes.json.
        const sessScope = privateScopeConstraints({ userData, uid: scopeUid, effectiveRole: userRole, ownerField: 'userId' });
        const taskScope = privateScopeConstraints({ userData, uid: scopeUid, effectiveRole: userRole, ownerField: 'assignedUserId' });

        const breaksQ = query(collection(db, 'break_sessions'),
            where('date', '>=', rangeStart),
            where('date', '<=', rangeEnd),
            ...sessScope);

        const unsubBreaks = onSnapshot(breaksQ, (snap) => {
            const breaksData = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                .filter(brk => {
                    const brkUserId = resolveUserId(brk);
                    if (selectedUserId !== 'all' && brkUserId !== selectedUserId) return false;
                    return true;
                })
                .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
            setBreakSessions(breaksData);
        }, (error) => {
            logError(error, { source: 'onSnapshot:breakSessions' });
        });

        // (Optional: Keep listening to daily_stats only if needed for legacy reasons, 
        // but for now we are calculating breaks from break_sessions. 
        // We'll leave it empty or remove if not used elsewhere, but to minimize disruption let's comment it out or leave as is if other fields are used.)
        // Actually, let's keep it null for now as we don't rely on it for breaks anymore.
        setDailyStats(null);
        let unsubStats = () => { }; // No-op


        // 2. Listen to Work Sessions. Range on `date` only (no orderBy — an inequality plus an
        // orderBy on a different field would force a composite index; startTime ordering is done
        // client-side wherever it matters, e.g. the timeline below).
        const sessionsBaseQ = collection(db, 'work_sessions');
        const sessionsQ = query(sessionsBaseQ, where('date', '>=', rangeStart), where('date', '<=', rangeEnd), ...sessScope);

        const unsubSessions = onSnapshot(sessionsQ, (snap) => {
            const sessionsData = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(session => {
                    if (session.isDeleted) return false;
                    const sessionUserId = resolveUserId(session);
                    if (selectedUserId !== 'all' && sessionUserId !== selectedUserId) return false;
                    return true;
                });
            setSessions(sessionsData);
        }, (error) => {
            logError(error, { source: 'onSnapshot:workSessions' });
            setLoading(false);
        });

        // 3. Listen to Tasks (Active & Archived)
        let activeQ, archivedQ;

        // Limit query to rangeEnd + 2 days to capture anything archived shortly after completion.
        // Start from the beginning of the range's first day.
        const startIso = `${rangeStart}T00:00:00`;

        // End 2 days after the range's last day (handles weekend archives or delayed archiving)
        const rangeEndDate = new Date(rangeEnd);
        rangeEndDate.setDate(rangeEndDate.getDate() + 2);
        const endIso = `${rangeEndDate.toISOString().split('T')[0]}T23:59:59`;

        activeQ = taskScope.length ? query(collection(db, 'tasks'), ...taskScope) : collection(db, 'tasks');
        archivedQ = query(
            collection(db, 'archived_tasks'),
            where('archivedAt', '>=', startIso),
            where('archivedAt', '<=', endIso),
            ...taskScope
        );

        let activeTasks = [];
        let archivedTasks = [];
        let deletedTasks = [];

        const updateAggregatedTasks = () => {
            // deduplicate tasks by ID to avoid duplicate key warnings
            const taskMap = new Map();
            [...activeTasks, ...archivedTasks, ...deletedTasks].forEach(t => {
                if (t.id) taskMap.set(t.id, t);
            });
            const allRelevantTasks = Array.from(taskMap.values()).filter(t => {
                const taskUserId = resolveUserId(t);
                if (selectedUserId !== 'all' && taskUserId !== selectedUserId) return false;
                return true;
            });

            // Filter for scheduled (planned for this weekday)
            const scheduled = allRelevantTasks.filter(t => t.dayOfWeek === weekday);
            setScheduledTasks(scheduled);

            // Filter for finished OR deleted in range OR unconfirmed (status === 'completed' and active)
            const inRange = (dateStr) => !!dateStr && dateStr >= rangeStart && dateStr <= rangeEnd;
            const finishedToday = allRelevantTasks.filter(t => {
                const compDate = t.completedAt?.split('T')[0];
                const archDate = t.archivedAt?.split('T')[0];
                const delDate = t.deletedAt?.split('T')[0];

                const isRelevantDate = inRange(compDate) || inRange(archDate) || inRange(delDate);

                // Include ALL unconfirmed active tasks (status 'completed') AND confirmed tasks that haven't been archived yet.
                // This ensures they stay visible after confirmation until the nightly archive job runs.
                const isActiveUnarchived = !t.archivedAt && !t.isDeleted && (t.status === 'completed' || t.status === 'confirmed');

                return isRelevantDate || isActiveUnarchived;
            });

            setFinishedTasks(finishedToday);
            setLoading(false);
        };

        const unsubActive = onSnapshot(activeQ, (snap) => {
            const allActiveTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));

            activeTasks = allActiveTasks.filter(t => !t.isDeleted && t.status !== 'deleted');
            updateAggregatedTasks();
        }, (error) => {
            console.error("Error fetching active tasks:", error);
            setLoading(false);
        });

        const unsubArchived = onSnapshot(archivedQ, (snap) => {
            archivedTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));

            updateAggregatedTasks();
            setLoading(false);
        });

        // Listen to Deleted Tasks
        const deletedQ = taskScope.length ? query(collection(db, 'deleted_tasks'), ...taskScope) : collection(db, 'deleted_tasks');

        const unsubDeleted = onSnapshot(deletedQ, (snap) => {
            deletedTasks = snap.docs.map(d => ({ id: d.id, ...d.data(), isDeleted: true }));
            updateAggregatedTasks();
        }, (error) => {
            console.error("Error fetching deleted tasks:", error);
        });

        return () => {
            unsubBreaks();
            unsubStats();
            unsubSessions();
            unsubActive();
            unsubArchived();
            unsubDeleted();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- userData is read via the stable `scoped` flag + `userRole`; depending on the whole object would re-subscribe every listener on each live-session user-doc update
    }, [selectedUserId, rangeStart, rangeEnd, scoped, scopeUid, userRole]);

    // 3AM work-day window for the selected span: opens at 03:00 on the first day and closes at
    // 03:00 the day AFTER the last day. For a single day these collapse to the original
    // [03:00 today, 03:00 tomorrow) window; for a range they widen to cover the whole span.
    const get3AMCutoff = () => {
        return getLithuanian3AMCutoff(rangeStart);
    };
    const getNextDayCutoff = () => {
        return getLithuanian3AMCutoff(addDaysToDateString(rangeEnd, 1));
    };

    // Sorting state
    const [sortBy, setSortBy] = useState('time'); // 'time' or 'status'

    // Split finished tasks into Today, Earlier, and Archived
    const splitTasks = useMemo(() => {
        const cutoff = get3AMCutoff();
        // End the window at the NEXT calendar day's 03:00 cutoff, not "cutoff + 24h":
        // across a DST switch a fixed +24h drifts the boundary by an hour, dropping or
        // double-counting work done in that hour. (Range-aware: closes after rangeEnd.)
        const nextDayCutoff = getNextDayCutoff();

        const todayTasksList = [];
        const earlierTasksList = [];
        const archivedTasksList = [];

        finishedTasks.forEach(t => {
            if (t.archivedAt) {
                // For archived tasks, hide them if they were archived AFTER the selected day's window
                const archDate = new Date(t.archivedAt);
                if (archDate >= nextDayCutoff) return; // Hide future archived tasks

                archivedTasksList.push(t);
                return;
            }

            // Exclude updatedAt from fallback to prevent old tasks showing up when edited
            const dateStr = t.completedAt || t.confirmedAt || t.deletedAt;
            if (!dateStr) {
                // If no completion date, put in earlier tasks or ignore?
                // If it's completed but has no date, it's likely old.
                earlierTasksList.push(t);
                return;
            }
            const finishedDate = new Date(dateStr);

            // BOUNDING LOGIC:
            // 1. If finished AFTER this day's 3AM window ends -> Hide entirely
            if (finishedDate >= nextDayCutoff) {
                return;
            }

            // 2. If finished WITHIN this day's 3AM window -> Today
            if (finishedDate >= cutoff) {
                todayTasksList.push(t);
            }
            // 3. If finished BEFORE this day's 3AM window -> Earlier
            else {
                earlierTasksList.push(t);
            }
        });

        // Robust descending sort helper
        const sortTasks = (tasks) => {
            return [...tasks].sort((a, b) => {
                if (sortBy === 'status') {
                    const getStatusRank = (task) => {
                        if (task.isDeleted || task.status === 'deleted') return 3;
                        if (task.status === 'confirmed') return 2;
                        return 1; // 'completed' / unconfirmed
                    };
                    const rankA = getStatusRank(a);
                    const rankB = getStatusRank(b);
                    if (rankA !== rankB) return rankA - rankB; // Ascending rank
                }

                const getTime = (task) => {
                    // Exclude updatedAt from sort to match split logic
                    const dateStr = task.completedAt || task.archivedAt || task.deletedAt || task.confirmedAt;
                    if (!dateStr) return 0;
                    const d = new Date(dateStr);
                    return isNaN(d.getTime()) ? 0 : d.getTime();
                };
                const timeA = getTime(a);
                const timeB = getTime(b);

                if (timeA === timeB) return (b.id || "").localeCompare(a.id || "");
                return timeB - timeA;
            });
        };

        return {
            todayTasks: sortTasks(todayTasksList),
            earlierTasks: sortTasks(earlierTasksList),
            archivedTasks: sortTasks(archivedTasksList)
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- get3AMCutoff/getNextDayCutoff only read rangeStart/rangeEnd, already listed
    }, [finishedTasks, rangeStart, rangeEnd, sortBy]);

    const { todayTasks, earlierTasks, archivedTasks } = splitTasks;

    // The "Patvirtinimas" surface (view='approval') shows a manager only the tasks they are
    // responsible for: ones where they are the assigned vadovas (task.managerId), or where they
    // manage the worker who did the task (the worker's managers include them). Admins are NOT
    // narrowed — they oversee the whole company. "Managers of the doer" is read from the task's
    // denormalized teamManagerIds (the same field the scoped-manager reads use, kept in sync by a
    // Cloud Function), falling back to the worker's user doc so it still resolves for any legacy
    // row written before that denormalization.
    const applyApprovalFilter = view === 'approval' && (userRole === 'manager' || userRole === 'seniorManager');
    const isApprovalRelevant = (task) => {
        const uid = currentUser?.uid;
        if (!uid) return false;
        if (task.managerId && task.managerId === uid) return true;
        if (Array.isArray(task.teamManagerIds) && task.teamManagerIds.includes(uid)) return true;
        const doer = users.find(u => u.id === resolveUserId(task));
        return !!doer && Array.isArray(doer.teamManagerIds) && doer.teamManagerIds.includes(uid);
    };
    const approvalTodayTasks = applyApprovalFilter ? todayTasks.filter(isApprovalRelevant) : todayTasks;
    const approvalEarlierTasks = applyApprovalFilter ? earlierTasks.filter(isApprovalRelevant) : earlierTasks;
    // The two task lists shown by this surface: full/hours surfaces use the raw split lists;
    // the approval surface uses the manager-scoped ones.
    const shownTodayTasks = view === 'approval' ? approvalTodayTasks : todayTasks;
    const shownEarlierTasks = view === 'approval' ? approvalEarlierTasks : earlierTasks;

    // ALL sessions go into the timeline — Quick Work and Calls are regular work sessions,
    // they were previously excluded to avoid double-count with manualTasks but that caused them to vanish.
    const validSessions = sessions;

    // Active Sessions Integration
    const activeTaskSessionsForToday = useMemo(() => {
        const active = [];
        // A period report is about recorded work, not what is ticking right now — skip live
        // sessions in range mode. In day mode, only the current day shows live progress.
        if (isRange || selectedDate !== getLithuanianDateString()) return active;

        users.forEach(u => {
            if (u.activeSession && u.activeSession.type === 'task') {
                const start = new Date(u.activeSession.startTime);
                const durationMinutes = (currentTime - start) / (1000 * 60);
                if (durationMinutes > 0) {
                    active.push({
                        id: `active_${u.id}`,
                        taskId: u.activeSession.taskId,
                        taskTitle: u.activeSession.taskTitle || 'Vykdoma užduotis',
                        userId: u.id,
                        userName: u.displayName || u.email,
                        startTime: u.activeSession.startTime,
                        endTime: currentTime.toISOString(),
                        durationMinutes,
                        date: getLithuanianDateString(start),
                        isActive: true
                    });
                }
            }
        });
        
        if (selectedUserId !== 'all') {
            return active.filter(s => s.userId === selectedUserId);
        }
        return active;
    }, [users, isRange, selectedDate, selectedUserId, currentTime]);

    const activeBreaksForToday = useMemo(() => {
        const active = [];
        if (isRange || selectedDate !== getLithuanianDateString()) return active;


        users.forEach(u => {
            if (u.activeSession && u.activeSession.type === 'break') {
                const start = new Date(u.activeSession.startTime);
                const durationMinutes = (currentTime - start) / (1000 * 60);
                if (durationMinutes > 0) {
                    active.push({
                        id: `active_break_${u.id}`,
                        userId: u.id,
                        userName: u.displayName || u.email,
                        startTime: u.activeSession.startTime,
                        endTime: currentTime.toISOString(),
                        durationMinutes,
                        date: getLithuanianDateString(start),
                        isActive: true
                    });
                }
            }
        });

        if (selectedUserId !== 'all') {
            return active.filter(s => s.userId === selectedUserId);
        }
        return active;
    }, [users, isRange, selectedDate, selectedUserId, currentTime]);

    const allValidSessions = useMemo(() => [...validSessions, ...activeTaskSessionsForToday], [validSessions, activeTaskSessionsForToday]);
    const allBreakSessions = useMemo(() => [...breakSessions, ...activeBreaksForToday], [breakSessions, activeBreaksForToday]);

    // Aggregations
    const totalTimerMinutes = allValidSessions.reduce((acc, s) => acc + (s.durationMinutes || 0), 0);
    const totalBreakMinutes = allBreakSessions.reduce((acc, s) => acc + (s.durationMinutes || 0), 0);

    // Filter tasks that have manual minutes (Quick Work, Calls, or Manual Logs)
    // AND belong to the selected date's work day (3AM - 3AM)
    const manualTasks = useMemo(() => {
        const cutoff = get3AMCutoff();
        // Calendar-day next cutoff (DST-safe), not "cutoff + 24h" — see splitTasks above.
        const nextDayCutoff = getNextDayCutoff();

        // Build a set of taskIds that already have explicit work_sessions.
        // Exclude manual-adjustment sessions: an adjustment is a correction layered on top
        // of a task's own total (already reflected via the task's manualMinutes /
        // timeAdjustments), not the task's primary tracked work. If an adjustment-only
        // session marked the task as "has sessions", the task's base manualMinutes would be
        // wrongly dropped from the daily total — counting only the correction.
        const taskIdsWithSessions = new Set(
            sessions.filter(s => !s.isManualAdjustment).map(s => s.taskId).filter(Boolean)
        );

        return finishedTasks.filter(t => {
            if (!t.manualMinutes) return false;

            // Call tasks (isSystemTask) and Quick Work tasks (isQuickWork) always have
            // a dedicated work_session logged alongside the task. Including manualMinutes
            // from these tasks would double-count because the session already carries
            // the same duration. The taskId on those sessions uses synthetic IDs
            // (e.g. "call_xxx", "quick_xxx") that never match the task's Firestore ID,
            // so the generic taskIdsWithSessions check below doesn't catch them.
            if (t.isSystemTask || t.isQuickWork) return false;

            // If this task already has real work_sessions tracked, skip it here —
            // the sessions themselves carry the accurate split data.
            if (taskIdsWithSessions.has(t.id)) return false;

            // If time was adjusted via work_sessions (timeChanged), skip to avoid double-count
            if (t.timeChanged) return false;

            const dateStr = t.completedAt || t.deletedAt || t.confirmedAt;
            if (!dateStr) return false;

            const finishedDate = new Date(dateStr);
            return finishedDate >= cutoff && finishedDate < nextDayCutoff;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- get3AMCutoff/getNextDayCutoff only read rangeStart/rangeEnd, already listed
    }, [finishedTasks, sessions, rangeStart, rangeEnd]);

    const totalManualMinutes = manualTasks.reduce((acc, t) => acc + (t.manualMinutes || 0), 0);

    // Sum from actualTime in tasks (including manual entries)
    // We strictly use calculated values now to ensure consistency
    const totalWorkedMinutes = totalTimerMinutes + totalManualMinutes;



    // Merge sessions and manual tasks for Timeline
    const combinedTimelineItems = useMemo(() => {
        const items = allValidSessions.map(s => {
            // Check if this session belongs to a deleted task
            const deletedTask = finishedTasks.find(t => t.id === s.taskId && t.isDeleted);
            let title = s.isActive ? `⏳ (Vykdoma) ${s.taskTitle}` : s.taskTitle;
            if (deletedTask) {
                title = `Ištrinta užduotis: ${deletedTask.title}`;
            }

            return {
                id: s.id,
                taskId: s.taskId,
                type: 'session',
                startTime: s.startTime,
                endTime: s.endTime,
                title: title,
                duration: s.durationMinutes,
                userId: resolveUserId(s),
                userName: resolveUserName(s) || 'Nežinomas',
                isActive: !!s.isActive,
                isSystemTask: s.isSystemTask || (s.taskId && String(s.taskId).startsWith('call_')),
                isQuickWork: s.isQuickWork || (s.taskId && String(s.taskId).startsWith('quick_'))
            };
        });

        manualTasks.forEach(t => {
            const endStr = t.completedAt || t.deletedAt || t.confirmedAt || new Date().toISOString();
            const end = new Date(endStr);
            const start = new Date(end.getTime() - (t.manualMinutes * 60000));

            let title = t.title;
            if (t.isDeleted) {
                title = `Deleted task: ${t.title}`;
            }

            items.push({
                id: t.id,
                type: 'task',
                startTime: start.toISOString(),
                endTime: end.toISOString(),
                title: title,
                duration: t.manualMinutes,
                userId: resolveUserId(t),
                userName: resolveUserName(t),
                isSystemTask: t.isSystemTask,
                isQuickWork: t.isQuickWork
            });
        });

        allBreakSessions.forEach(brk => {
            const userId = resolveUserId(brk);
            const userName = resolveUserName(brk) || userId;

            items.push({
                id: brk.id,
                type: 'break',
                startTime: brk.startTime,
                endTime: brk.endTime,
                title: 'Pertrauka',
                duration: brk.durationMinutes,
                userId: userId,
                userName: userName
            });
        });

        // Sort by start time
        const sortedItems = items.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

        // Inject inactive gaps for individual mode (matches Reports.jsx logic). Skipped in range
        // mode — an overnight gap between one day's last session and the next day's first would
        // render as a giant, meaningless "Neaktyvus" block spanning the hours nobody works.
        if (!isRange && selectedUserId !== 'all' && sortedItems.length > 0) {
             const withGaps = [];
             for (let i = 0; i < sortedItems.length; i++) {
                 const current = sortedItems[i];
                 withGaps.push(current);

                 if (i < sortedItems.length - 1) {
                     const next = sortedItems[i + 1];
                     const currentEnd = new Date(current.endTime);
                     const nextStart = new Date(next.startTime);
                     const gapMs = nextStart.getTime() - currentEnd.getTime();
                     const gapMinutes = Math.floor(gapMs / 60000);

                     if (gapMinutes > 1) { // Only show gaps > 1 minute
                         withGaps.push({
                             id: `gap-${current.id}`,
                             type: 'inactive',
                             startTime: current.endTime,
                             endTime: next.startTime,
                             title: 'Neaktyvus',
                             duration: gapMinutes,
                         });
                     }
                 }
             }
             return withGaps;
        }

        return sortedItems;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- finishedTasks changes already propagate via manualTasks; preserving current timing
    }, [allValidSessions, manualTasks, allBreakSessions, selectedUserId, isRange]);


    // Find earliest start and latest end from COMBINED items
    const firstActivity = combinedTimelineItems.length > 0 ? combinedTimelineItems[0].startTime : null;
    const lastActivity = combinedTimelineItems.length > 0 ? combinedTimelineItems[combinedTimelineItems.length - 1].endTime : null;


    // Group sessions by worker for Team mode
    const workerSummaries = selectedUserId === 'all' ? combinedTimelineItems.reduce((acc, s) => {
        if (!acc[s.userId]) {
            const worker = users.find(u => u.id === s.userId);
            const rawName = worker ? (worker.displayName || worker.email) : (s.userName || 'Nežinomas');
            const displayName = formatDisplayName(rawName);

            acc[s.userId] = {
                name: displayName,
                earliestStart: s.startTime,
                latestEnd: s.endTime,
                taskTimeMinutes: 0,
                breakMinutes: 0,
                // We'll sum breaks later
            };
        }
        if (s.type === 'break') {
            acc[s.userId].breakMinutes += (s.duration || 0);
        } else {
            acc[s.userId].taskTimeMinutes += (s.duration || 0);
        }
        if (s.startTime && (!acc[s.userId].earliestStart || s.startTime < acc[s.userId].earliestStart)) acc[s.userId].earliestStart = s.startTime;
        if (s.endTime && (!acc[s.userId].latestEnd || s.endTime > acc[s.userId].latestEnd)) acc[s.userId].latestEnd = s.endTime;

        return acc;
    }, {}) : null;

    const workerList = workerSummaries ? Object.entries(workerSummaries) : [];

    const handleToggleConfirm = async (task) => {
        const isCurrentlyConfirmed = task.status === 'confirmed';

        // Determine if it's a deleted task
        const isDeletedTask = task.isDeleted || task.status === 'deleted';

        // Logical new status
        let newStatus;
        if (isDeletedTask) {
            // For deleted tasks: toggle between 'confirmed' and 'deleted'
            // We interpret 'confirmed' on a deleted task as "Deleted-Confirmed"
            newStatus = isCurrentlyConfirmed ? 'deleted' : 'confirmed';
        } else {
            // Normal tasks: toggle between 'confirmed' and 'completed' (unconfirmed)
            newStatus = isCurrentlyConfirmed ? 'completed' : 'confirmed';
        }

        try {
            // Determine collection based on whether it's archived OR deleted
            // Deleted tasks are moved to archived_tasks collection by default now
            const collectionName = (task.archivedAt || task.isDeleted || task.status === 'deleted') ? 'archived_tasks' : 'tasks';

            const updates = {
                status: newStatus,
                confirmedAt: newStatus === 'confirmed' ? new Date().toISOString() : null,
                confirmedBy: newStatus === 'confirmed' ? currentUser.uid : null,
                updatedAt: new Date().toISOString()
            };

            // CRITICAL: If it was a deleted task, ensure isDeleted is TRUE even if status becomes 'confirmed'.
            // This prevents it from accidentally appearing as an active task.
            if (isDeletedTask) {
                updates.isDeleted = true;
                // Preserve deletedAt if present, or set it if missing
                if (!task.deletedAt) {
                    updates.deletedAt = new Date().toISOString();
                }
            }

            await updateDoc(doc(db, collectionName, task.id), updates);

            // Optimistic update for UI responsiveness
            setFinishedTasks(prev => prev.map(t =>
                t.id === task.id ? { ...t, ...updates } : t
            ));

        } catch (err) {
            console.error("Error confirming task:", err);
            // Map to friendly Lithuanian copy — never surface raw err.message (§10).
            if (err.code === 'not-found') {
                setActionError("Dokumento nerasta. Perkraukite puslapį ir bandykite vėl.");
            } else {
                setActionError("Nepavyko atnaujinti būsenos. Perkraukite puslapį ir bandykite vėl.");
            }
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
            setFinishedTasks(prev => prev.map(t =>
                t.id === task.id ? { ...t, comments: updatedComments } : t
            ));

            // Also update the activeModal task so the modal shows the new comment immediately
            setActiveModal(prev => ({
                ...prev,
                task: { ...prev.task, comments: updatedComments }
            }));

            // Determine collection based on archival status
            const collectionName = task.archivedAt ? 'archived_tasks' : 'tasks';

            await addComment(task.id, text, currentUser, task.comments || [], collectionName);
        } catch (err) {
            console.error("Error adding comment:", err);
            setActionError("Komentaras nebuvo išsaugotas. Bandykite vėl.");
        }
    };

    // Open the restore confirmation (replaces window.confirm — §8).
    const handleRestore = (task) => {
        setRestoreTarget(task);
    };

    const confirmRestore = async () => {
        const task = restoreTarget;
        if (!task) return;
        setRestoring(true);
        try {
            const restoredTask = {
                ...task,
                status: 'in-progress',
                timerStatus: 'paused',
                completed: false,
                completedAt: null,
                confirmedAt: null,
                confirmedBy: null,
                archivedAt: null,
                archivedBy: null,
                isDeleted: false,
                deletedAt: null,
                deletedBy: null,
                updatedAt: new Date().toISOString()
            };

            // Determine collection based on whether it's archived
            const sourceCollection = task.archivedAt ? 'archived_tasks' : 'tasks';

            // Restore to tasks collection
            await setDoc(doc(db, 'tasks', task.id), restoredTask);

            // If it was in archived_tasks, delete it from there
            if (task.archivedAt) {
                await deleteDoc(doc(db, sourceCollection, task.id));
            }

            // Update local state to remove from finished tasks
            setFinishedTasks(prev => prev.filter(t => t.id !== task.id));
            setRestoreTarget(null);
        } catch (err) {
            console.error("Error restoring task:", err);
            setActionError("Nepavyko grąžinti užduoties. Patikrinkite ryšį ir bandykite iš naujo.");
        } finally {
            setRestoring(false);
        }
    };

    const handleTimeChange = async (task, newTotalMinutes, reason) => {
        // A manual time edit changes payable hours, so it must be justified. Block an
        // unattributed write and tell the editor why instead of silently overriding.
        const trimmedReason = (reason || '').trim();
        if (!trimmedReason) {
            setActionError("Nurodykite laiko keitimo priežastį.");
            return;
        }
        try {
            const collectionName = (task.archivedAt || task.isDeleted || task.status === 'deleted') ? 'archived_tasks' : 'tasks';

            // Snapshot the pre-edit total BEFORE writing, so the report row can show "from → to"
            // and an auditor can see what the tracked figure was before the override.
            const previousTotalMinutes = Math.round(calculateCurrentTotalMinutes(task)) || 0;

            // Calculate how much time is already accounted for in timeAdjustments
            let adjustmentsTotal = 0;
            if (task.timeAdjustments && Array.isArray(task.timeAdjustments)) {
                task.timeAdjustments.forEach(adj => {
                    adjustmentsTotal += (adj.durationMinutes || 0);
                });
            }

            // The user intends for the new absolute total to be newTotalMinutes.
            // Since `calculateCurrentTotalMinutes` calculates total = manualMinutes + timeAdjustments,
            // we must subtract the existing timeAdjustments from newTotalMinutes to get the correct manualMinutes.
            // Exception: if manualMinutes drops below 0, it means the correction exceeds the total (prevent negative base time).
            const newManualMinutes = Math.max(0, (newTotalMinutes || 0) - adjustmentsTotal);

            const updates = {
                timerMinutes: 0,
                manualMinutes: newManualMinutes,
                timeChanged: true,
                timeChangedBy: currentUser?.uid || 'unknown',
                timeChangedByName: currentUser?.displayName || currentUser?.email || 'Nežinomas',
                timeChangedAt: new Date().toISOString(),
                timeChangedFrom: previousTotalMinutes,
                timeChangedTo: (newTotalMinutes || 0),
                timeChangedReason: trimmedReason,
                updatedAt: new Date().toISOString()
            };

            if (!task.id) throw new Error("Missing task ID");
            await updateDoc(doc(db, collectionName, task.id), updates);

            // True database update to ensure time goes to statistics
            const difference = (newTotalMinutes || 0) - previousTotalMinutes;

            if (difference !== 0) {
                const completedDateDate = task.completedAt ? new Date(task.completedAt) : new Date();

                // Construct payload explicitly removing undefined to prevent Firestore assertions.
                // Carries the reason + who made it so the adjustment row is self-describing.
                const payload = {
                    taskId: task.id || 'unknown_id',
                    taskTitle: `🕒 Laiko korekcija: ${task.title || 'Užduotis'}`,
                    reason: trimmedReason,
                    userId: task.assignedUserId || task.creatorId || 'unknown',
                    userName: task.assignedUserName || task.creatorName || 'Nežinomas vykdytojas',
                    adjustedBy: currentUser?.uid || 'unknown',
                    startTime: completedDateDate.toISOString(),
                    endTime: new Date().toISOString(),
                    durationMinutes: difference,
                    date: getLithuanianDateString(completedDateDate) || new Date().toISOString().split('T')[0],
                    createdAt: new Date().toISOString(),
                    isManualAdjustment: true
                };

                await addDoc(collection(db, 'work_sessions'), payload);
            }

            setFinishedTasks(prev => prev.map(t =>
                t.id === task.id ? { ...t, ...updates } : t
            ));
            setActionError('');
        } catch (err) {
            console.error('Error changing task time:', err);
            setActionError("Laiko keitimas nepavyko. Patikrinkite įvesties reikšmes ir bandykite iš naujo.");
        }
    };

    // View mode state for responsive design
    // Initialise from the current width so a phone never shows the desktop table on the first
    // paint (the resize listener below keeps it in sync afterwards). WCAG 1.4.10 / §9.
    const [viewMode, setViewMode] = useState(() =>
        (typeof window !== 'undefined' && window.innerWidth < 768) ? 'mobile' : 'desktop'
    );

    useEffect(() => {
        const handleResize = () => {
            setViewMode(window.innerWidth < 768 ? 'mobile' : 'desktop');
        };

        window.addEventListener('resize', handleResize);
        handleResize(); // Initial check

        return () => window.removeEventListener('resize', handleResize);
    }, []);



    const weekday = getLithuanianWeekday(selectedDate);

    return (
        <div className="space-y-4">
            {actionError && (
                <div
                    role="alert"
                    className="flex items-start justify-between gap-3 rounded-card border border-feedback-danger bg-feedback-danger/10 px-4 py-3 text-body text-feedback-danger"
                >
                    <span>{actionError}</span>
                    <IconButton
                        icon={X}
                        label="Užverti pranešimą"
                        variant="ghost"
                        onClick={() => setActionError('')}
                    />
                </div>
            )}

            {/* Hours surface (work timeline + day summary). The "Patvirtinimas" tab
                (view='approval') drops all of this and shows only the task-confirmation
                sections below. */}
            {view !== 'approval' && (
              <>
            {/* Header Controls — kept to a single compact row on every viewport (no column
                stacking on mobile) so the date stepper + filters take minimal vertical space. */}
            <div className="bg-surface-card p-2 rounded-card shadow-sm border border-line flex flex-row flex-wrap gap-2 items-center justify-between">

                {/* Left group — date control plus, on desktop, the day's totals inline, so on
                    md+ the whole summary collapses into this single toolbar row. */}
                <div className="flex flex-wrap items-center gap-2 md:gap-4">

                {/* Day mode: a day stepper. Range mode: a static span label — the period is
                    chosen by the picker in the parent (Reports), so there is nothing to step. */}
                {isRange ? (
                    <div className="flex items-center gap-1.5 bg-surface-sunken px-3 py-2 rounded-control border border-line font-medium text-caption text-ink-strong whitespace-nowrap">
                        <Calendar className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden="true" />
                        {rangeStart} – {rangeEnd}
                    </div>
                ) : (
                    <div className="flex items-center gap-1 bg-surface-sunken p-1 rounded-control border border-line">
                        <IconButton
                            icon={ChevronLeft}
                            label="Ankstesnė diena"
                            onClick={() => handleDateChange(-1)}
                        />
                        <div className="flex items-center gap-1.5 px-1.5 justify-center font-medium text-caption text-ink-strong whitespace-nowrap">
                            <Calendar className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                            {selectedDate}
                        </div>
                        <IconButton
                            icon={ChevronRight}
                            label="Kita diena"
                            onClick={() => handleDateChange(1)}
                        />
                    </div>
                )}

                {/* Desktop only: the day's totals inline in the toolbar row (mobile keeps the
                    dedicated summary card below). Merges the former four-card grid into one line. */}
                <div className="hidden md:flex items-center gap-4 flex-wrap">
                    {selectedUserId !== 'all' && !isRange && (
                        <span className="flex items-center gap-1.5 whitespace-nowrap">
                            <Clock className="w-4 h-4 text-ink-muted shrink-0" aria-hidden="true" />
                            <span className="text-caption text-ink-muted">Pradžia/Pabaiga</span>
                            <span className="text-body font-bold text-ink-strong tabular-nums">
                                {firstActivity ? formatTime(firstActivity) : '--:--'}–{lastActivity ? formatTime(lastActivity) : '--:--'}
                            </span>
                        </span>
                    )}
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                        <Clock className="w-4 h-4 text-ink-muted shrink-0" aria-hidden="true" />
                        <span className="text-caption text-ink-muted">Darbas</span>
                        <span className="text-body font-bold text-ink-strong tabular-nums">{formatMinutesToTimeString(totalWorkedMinutes)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                        <Coffee className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
                        <span className="text-caption text-ink-muted">Pertraukos</span>
                        <span className="text-body font-bold text-amber-600 tabular-nums">{formatMinutesToTimeString(totalBreakMinutes)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                        <Zap className="w-4 h-4 text-brand shrink-0" aria-hidden="true" />
                        <span className="text-caption text-brand">Viso</span>
                        <span className="text-body font-bold text-brand tabular-nums">{formatMinutesToTimeString(totalWorkedMinutes + totalBreakMinutes)}</span>
                    </span>
                </div>
                </div>

                {/* Sort filter — a horizontal two-option segmented control (Pagal laiką |
                    Pagal būseną) so both choices stay on one row and the toolbar keeps to a
                    single line. */}
                <div
                    className="flex bg-surface-sunken rounded-control overflow-hidden border border-line"
                    role="group"
                    aria-label="Rūšiuoti"
                >
                    <button
                        type="button"
                        onClick={() => setSortBy('time')}
                        aria-pressed={sortBy === 'time'}
                        className={clsx(
                            "flex items-center gap-1.5 px-3 py-1.5 text-caption font-semibold transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
                            sortBy === 'time' ? "bg-brand text-white" : "text-ink hover:bg-surface-card"
                        )}
                    >
                        <Filter className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        Pagal laiką
                    </button>
                    <div className="w-px bg-line" aria-hidden="true" />
                    <button
                        type="button"
                        onClick={() => setSortBy('status')}
                        aria-pressed={sortBy === 'status'}
                        className={clsx(
                            "flex items-center gap-1.5 px-3 py-1.5 text-caption font-semibold transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
                            sortBy === 'status' ? "bg-brand text-white" : "text-ink hover:bg-surface-card"
                        )}
                    >
                        <Filter className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        Pagal būseną
                    </button>
                </div>
            </div>

            {/* Summary Cards */}
            {/* Mobile: one compact card — the three durations as hero numbers in a single row,
                with the day span as a slim header. Replaces the four full-width stacked cards so
                the whole day summary fits in the top half of the first screen (§9 dual density:
                a tuned, denser mobile layout instead of one card per row). */}
            <div className="md:hidden bg-surface-card rounded-card shadow-sm border border-line p-3">
                {selectedUserId !== 'all' && !isRange && (
                    <div className="flex items-center justify-between gap-2 border-b border-line pb-2.5 mb-2.5">
                        <span className="flex items-center gap-1.5 text-caption text-ink-muted">
                            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                            Dienos pradžia / pabaiga
                        </span>
                        <span className="text-body font-semibold text-ink-strong tabular-nums">
                            {firstActivity ? formatTime(firstActivity) : '--:--'} - {lastActivity ? formatTime(lastActivity) : '--:--'}
                        </span>
                    </div>
                )}
                <div className="grid grid-cols-3 divide-x divide-line">
                    <div className="flex flex-col items-center px-1 text-center">
                        <span className="flex items-center gap-1 text-caption text-ink-muted">
                            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                            Darbas
                        </span>
                        <span className="mt-1 text-h3 font-bold text-ink-strong tabular-nums">
                            {formatMinutesToTimeString(totalWorkedMinutes)}
                        </span>
                    </div>
                    <div className="flex flex-col items-center px-1 text-center">
                        <span className="flex items-center gap-1 text-caption text-ink-muted">
                            <Coffee className="w-3.5 h-3.5" aria-hidden="true" />
                            Pertraukos
                        </span>
                        <span className="mt-1 text-h3 font-bold text-session-break-accent tabular-nums">
                            {formatMinutesToTimeString(totalBreakMinutes)}
                        </span>
                    </div>
                    <div className="flex flex-col items-center px-1 text-center">
                        <span className="flex items-center gap-1 text-caption text-brand">
                            <Zap className="w-3.5 h-3.5" aria-hidden="true" />
                            Viso
                        </span>
                        <span className="mt-1 text-h3 font-bold text-brand tabular-nums">
                            {formatMinutesToTimeString(totalWorkedMinutes + totalBreakMinutes)}
                        </span>
                    </div>
                </div>
            </div>

            {/* Timeline Table or Worker Summary */}
            <div className="bg-surface-card rounded-card shadow-sm border border-line overflow-hidden">
                <div className="px-6 py-4 border-b border-line bg-surface-sunken text-ink-strong">
                    <h3 className="font-semibold">{selectedUserId === 'all' ? 'Darbo valandos' : (isRange ? 'Darbų eiga' : 'Darbų eiga (Timeline)')}</h3>
                </div>

                {combinedTimelineItems.length === 0 ? (
                    <div className="p-12 text-center text-ink-muted">
                        <p>{isRange ? 'Šiuo laikotarpiu darbo sesijų nefiksuota.' : 'Šią dieną darbo sesijų nefiksuota.'}</p>
                    </div>
                ) : selectedUserId === 'all' ? (
                    <>
                        {/* Mobile: one card per worker — never a horizontal table on a phone (§9) */}
                        <ul className="divide-y divide-line md:hidden">
                            {workerList.map(([userId, summary]) => (
                                <li
                                    key={userId}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`Peržiūrėti ${summary.name} dienos užduotis`}
                                    onClick={() => setWorkerDetail({ userId, name: summary.name })}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setWorkerDetail({ userId, name: summary.name }); } }}
                                    className="p-4 cursor-pointer hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                                >
                                    <p className="flex items-center gap-1.5 text-body font-semibold text-ink-strong">
                                        {summary.name}
                                        <ChevronRight className="w-4 h-4 text-ink-muted" aria-hidden="true" />
                                    </p>
                                    <p className="mt-0.5 font-mono text-caption text-ink-muted">
                                        {formatTime(summary.earliestStart)} – {formatTime(summary.latestEnd)}
                                    </p>
                                    <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                                        <div>
                                            <dt className="text-caption text-ink-muted">Pertraukos</dt>
                                            <dd className="font-mono text-body font-semibold text-amber-700">{formatMinutesToTimeString(summary.breakMinutes)}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-caption text-ink-muted">Užduotims</dt>
                                            <dd className="font-mono text-body font-semibold text-brand">{formatMinutesToTimeString(summary.taskTimeMinutes)}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-caption text-ink-muted">Bendras laikas</dt>
                                            <dd className="font-mono text-body font-bold text-ink-strong">{formatMinutesToTimeString(summary.taskTimeMinutes + summary.breakMinutes)}</dd>
                                        </div>
                                    </dl>
                                </li>
                            ))}
                            <li className="bg-surface-sunken p-4">
                                <p className="mb-2 text-body font-bold text-ink-strong">Viso komanda</p>
                                <dl className="grid grid-cols-3 gap-2 text-center">
                                    <div>
                                        <dt className="text-caption text-ink-muted">Pertraukos</dt>
                                        <dd className="font-mono text-body font-semibold text-amber-700">{formatMinutesToTimeString(totalBreakMinutes)}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-caption text-ink-muted">Užduotims</dt>
                                        <dd className="font-mono text-body font-semibold text-brand">{formatMinutesToTimeString(totalWorkedMinutes)}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-caption text-ink-muted">Bendras laikas</dt>
                                        <dd className="font-mono text-body font-bold text-ink-strong">{formatMinutesToTimeString(totalWorkedMinutes + totalBreakMinutes)}</dd>
                                    </div>
                                </dl>
                            </li>
                        </ul>

                        {/* Desktop: dense team summary table. Every cell uses the same px-4 py-3
                            padding (header included) so the columns line up — a leftover md:px-2
                            override on the header only made it drift out of alignment. */}
                        <div className="hidden overflow-x-auto md:block">
                        <table className="w-full divide-y divide-line text-sm">
                            <thead className="bg-surface-sunken">
                                <tr>
                                    <th scope="col" className="px-4 py-3 text-left font-medium text-ink-muted">Vykdytojas</th>
                                    <th scope="col" className="px-4 py-3 text-center font-medium text-ink-muted">Pradžia</th>
                                    <th scope="col" className="px-4 py-3 text-center font-medium text-ink-muted">Pabaiga</th>
                                    <th scope="col" className="px-4 py-3 text-right font-medium text-ink-muted">Pertraukos</th>
                                    <th scope="col" className="px-4 py-3 text-right font-medium text-ink-muted">Užduotims</th>
                                    <th scope="col" className="px-4 py-3 text-right font-medium text-ink-strong" title="Bendras laikas: darbas ir pertraukos — ne tik darbo valandos.">Bendras laikas</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-line">
                                {workerList.map(([userId, summary]) => (
                                    <tr
                                        key={userId}
                                        role="button"
                                        tabIndex={0}
                                        aria-label={`Peržiūrėti ${summary.name} dienos užduotis`}
                                        onClick={() => setWorkerDetail({ userId, name: summary.name })}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setWorkerDetail({ userId, name: summary.name }); } }}
                                        className="cursor-pointer hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                                    >
                                        <td className="px-4 py-3 text-ink-strong font-medium">
                                            <span className="inline-flex items-center gap-1.5">
                                                {summary.name}
                                                <ChevronRight className="w-3.5 h-3.5 text-ink-muted" aria-hidden="true" />
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-center text-ink-muted font-mono text-sm">
                                            {formatTime(summary.earliestStart)}
                                        </td>
                                        <td className="px-4 py-3 text-center text-ink-muted font-mono text-sm">
                                            {formatTime(summary.latestEnd)}
                                        </td>
                                        <td className="px-4 py-3 text-right text-amber-600 font-mono">
                                            {formatMinutesToTimeString(summary.breakMinutes)}
                                        </td>
                                        <td className="px-4 py-3 text-right text-indigo-600 font-mono font-semibold">
                                            {formatMinutesToTimeString(summary.taskTimeMinutes)}
                                        </td>
                                        <td className="px-4 py-3 text-right text-ink-strong font-mono font-bold bg-blue-50/10">
                                            {formatMinutesToTimeString(summary.taskTimeMinutes + summary.breakMinutes)}
                                        </td>
                                    </tr>
                                ))}
                                <tr className="bg-surface-sunken font-bold">
                                    <td colSpan="3" className="px-4 py-3 text-right text-ink-strong">
                                        Viso komanda:
                                    </td>
                                    <td className="px-4 py-3 text-right text-amber-700">
                                        {formatMinutesToTimeString(totalBreakMinutes)}
                                    </td>
                                    <td className="px-4 py-3 text-right text-indigo-700">
                                        {formatMinutesToTimeString(totalWorkedMinutes)}
                                    </td>
                                    <td className="px-4 py-3 text-right text-ink-strong font-bold bg-blue-50/30">
                                        {formatMinutesToTimeString(totalWorkedMinutes + totalBreakMinutes)}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    </>
                ) : (
                    <>
                        {/* Mobile: timeline as a card list — never a horizontal table on a phone (§9) */}
                        <ul className="divide-y divide-line md:hidden">
                            {combinedTimelineItems.map((item, idx) => (
                                <li key={item.id || idx} className="flex items-center justify-between gap-3 p-4">
                                    <div className="min-w-0">
                                        <p className="font-mono text-caption text-ink-muted">
                                            {formatTime(item.startTime)} – {formatTime(item.endTime)}
                                        </p>
                                        <div className="mt-0.5 flex items-center gap-1.5 text-body text-ink">
                                            {item.type === 'break' ? (
                                                <><SessionTypeIcon type="break" className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" /> Pertrauka</>
                                            ) : item.type === 'inactive' ? (
                                                <span className="italic text-ink-muted">{item.title || 'Neaktyvus'}</span>
                                            ) : (
                                                <>
                                                    <SessionTypeIcon
                                                        type={item.isSystemTask ? 'call' : (item.isQuickWork ? 'quickWork' : 'task')}
                                                        className="w-3.5 h-3.5 flex-shrink-0"
                                                        aria-hidden="true"
                                                    />
                                                    <span className="truncate">{item.title || 'Darbas'}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <span className={clsx(
                                        "font-mono text-body font-bold whitespace-nowrap",
                                        item.type === 'break' ? 'text-amber-700' : item.type === 'inactive' ? 'text-ink-muted' : 'text-brand'
                                    )}>
                                        {formatMinutesToTimeString(item.duration)}
                                    </span>
                                </li>
                            ))}
                            <li className="flex items-center justify-between gap-3 bg-surface-sunken p-4">
                                <span className="text-body font-semibold text-ink-strong">Viso (laikmatis + rankinis)</span>
                                <span className="font-mono text-body font-bold text-brand">{formatMinutesToTimeString(totalWorkedMinutes)}</span>
                            </li>
                        </ul>

                        {/* Desktop: dense timeline table */}
                        <div className="hidden overflow-x-auto md:block">
                        <table className="w-full md:w-auto divide-y divide-line text-sm">
                            <thead className="bg-surface-sunken">
                                <tr>
                                    <th scope="col" className="px-4 py-3 md:px-2 md:py-2 text-left font-medium text-ink-muted w-24">Laikas</th>
                                    <th scope="col" className="px-4 py-3 md:px-2 md:py-2 text-left font-medium text-ink-muted">Užduotis</th>
                                    <th scope="col" className="px-4 py-3 md:px-2 md:py-2 text-right font-medium text-ink-muted w-32">Trukmė</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-line">
                                {combinedTimelineItems.map((item, idx) => (
                                    <tr key={item.id || idx} className={`text-xs hover:bg-surface-sunken border-b border-line last:border-0 ${item.type === 'break' ? 'text-amber-700 bg-amber-50/10' : item.type === 'inactive' ? 'text-ink-muted italic' : 'text-ink-muted'}`}>
                                        <td className="px-4 py-3 font-mono text-ink-muted w-24">
                                            {formatTime(item.startTime)} - {formatTime(item.endTime)}
                                        </td>
                                        <td className="px-4 py-3 font-medium flex-grow truncate">
                                            {item.type === 'break' ? (
                                                <span className="flex items-center gap-1.5"><SessionTypeIcon type="break" className="w-3.5 h-3.5" /> Pertrauka</span>
                                            ) : item.type === 'inactive' ? (
                                                <span className="flex items-center gap-1.5 text-ink-muted">{item.title || 'Neaktyvus'}</span>
                                            ) : (
                                                <span className="flex items-center gap-1.5">
                                                    <SessionTypeIcon
                                                        type={item.isSystemTask ? 'call' : (item.isQuickWork ? 'quickWork' : 'task')}
                                                        className="w-3.5 h-3.5 flex-shrink-0"
                                                    />
                                                    {item.title || 'Darbas'}
                                                </span>
                                            )}
                                        </td>
                                        <td className={`px-4 py-3 font-mono font-bold w-full text-right ${item.type === 'break' ? 'text-amber-600' : item.type === 'inactive' ? 'text-ink-muted' : 'text-brand'}`}>
                                            {formatMinutesToTimeString(item.duration)}
                                        </td>
                                    </tr>
                                ))}
                                <tr className="bg-surface-sunken font-semibold">
                                    <td colSpan="2" className="px-4 py-3 text-right text-ink-strong">
                                        Viso (laikmatis + rankinis):
                                    </td>
                                    <td className="px-4 py-3 md:px-2 md:py-2 text-right text-indigo-600">
                                        {formatMinutesToTimeString(totalWorkedMinutes)}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    </>
                )}
            </div>

            {/* Removed separate Breaks Timeline as they are now integrated into the main timeline */}

            {(selectedUserId === 'all') && (
                /* Optional: Add Breaks Breakdown for Team if requested, but for now only adding for individual user as per "user has had a break today" request interpretation */
                /* Re-reading request: "create a similar table... for Breaks. Show all times a user has had a break today." 
                   This implies when viewing a specific user (or maybe all users, but individual view is clearest).
                   I will stick to Individual view first.
                */
                null
            )}
              </>
            )}


            {/* Task-confirmation sections. Hidden entirely on the hours-only surface (they move to
                the "Patvirtinimas" tab); shown plain on the full surface; and as collapsible,
                manager-scoped sections on the approval surface (today + awaiting-confirmation open
                by default, the history archive collapsed). */}
            {view !== 'hours' && (
              <>
            {shownTodayTasks.length > 0 && (
                <TaskListTable
                    tasks={shownTodayTasks}
                    title={isRange ? `Atliktos užduotys (${rangeStart} – ${rangeEnd})` : `Užduotys atliktos ${selectedDate} ${weekday}`}
                    viewMode={viewMode}
                    onToggleConfirm={handleToggleConfirm}
                    onAddComment={handleAddComment}
                    onRestore={handleRestore}
                    onTimeChange={handleTimeChange}
                    users={users}
                    userRole={userRole}
                    currentUser={currentUser}
                    expandedTasks={expandedTasks}
                    toggleExpand={toggleExpand}
                    setActiveModal={setActiveModal}
                    collapsible={view === 'approval'}
                    defaultOpen
                />
            )}

            {shownEarlierTasks.length > 0 && (
                <TaskListTable
                    tasks={shownEarlierTasks}
                    title="Užduotys atliktos anksčiau, laukia patvirtinimo"
                    viewMode={viewMode}
                    onToggleConfirm={handleToggleConfirm}
                    onAddComment={handleAddComment}
                    onRestore={handleRestore}
                    onTimeChange={handleTimeChange}
                    users={users}
                    userRole={userRole}
                    currentUser={currentUser}
                    expandedTasks={expandedTasks}
                    toggleExpand={toggleExpand}
                    setActiveModal={setActiveModal}
                    highlight={true}
                    collapsible={view === 'approval'}
                    defaultOpen
                />
            )}

            {/* Full task-history browser — omitted in the embedded calendar drill-down, which is a
                focused single-day report, not the archive browser. On the approval surface it is
                scoped to this manager's tasks (matching the lists above). */}
            {!embedded && (
                <div className="mt-8">
                    <TaskHistory
                        userId={selectedUserId}
                        users={users}
                        canExport={canExport}
                        approvalManagerUid={applyApprovalFilter ? currentUser?.uid : null}
                    />
                </div>
            )}

            {(view === 'approval'
                ? (shownTodayTasks.length === 0 && shownEarlierTasks.length === 0)
                : (todayTasks.length === 0 && earlierTasks.length === 0 && archivedTasks.length === 0)
            ) && (
                <div className="bg-surface-card p-8 rounded-card shadow-sm text-center text-ink-muted">
                    {view === 'approval'
                        ? 'Šiuo metu nėra užduočių, kurias turėtumėte patvirtinti.'
                        : (isRange ? 'Nėra atliktų užduočių šiam laikotarpiui.' : 'Nėra atliktų užduočių šiai dienai.')}
                </div>
            )}
              </>
            )}

            {/* Break log could be listed here if we stored individual breaks, 
                but we only stored total 'breakMinutes' in daily_stats for now. 
            */}
            {activeModal.type === 'comments' && activeModal.task && (
                <CommentsModal
                    isOpen={true}
                    onClose={() => setActiveModal({ type: null, taskId: null, task: null })}
                    comments={activeModal.task.comments}
                    onAddComment={handleAddComment}
                />
            )}

            {/* Restore confirmation (replaces window.confirm — §8) */}
            {restoreTarget && (
                <ConfirmDialog
                    open
                    title="Grąžinti užduotį?"
                    message="Užduotis bus iš naujo pridėta į aktyvius sąrašus."
                    confirmLabel="Grąžinti"
                    cancelLabel="Atšaukti"
                    variant="primary"
                    loading={restoring}
                    onConfirm={confirmRestore}
                    onCancel={() => setRestoreTarget(null)}
                />
            )}

            {/* Per-worker drill-down: every work segment that worker logged on the selected day,
                finished or still running. Sourced from the same timeline that feeds the summary
                row, so the numbers always reconcile. */}
            {workerDetail && (
                <WorkerDayDetailModal
                    worker={workerDetail}
                    date={selectedDate}
                    items={combinedTimelineItems.filter(i => i.userId === workerDetail.userId)}
                    tasks={finishedTasks}
                    onOpenTask={(task) => { setWorkerDetail(null); setOpenTaskDetail(task); }}
                    onClose={() => setWorkerDetail(null)}
                />
            )}

            {/* Full task window opened from a worker's day-detail card. */}
            {openTaskDetail && (
                <TaskModal
                    isOpen
                    task={openTaskDetail}
                    role={userRole}
                    onClose={() => setOpenTaskDetail(null)}
                />
            )}
        </div>
    );
}

// Worker day drill-down — chronological list of everything one worker did on the selected
// day: tasks and quick-work/calls (finished or still running) plus breaks. Opened from a row
// in the team "Darbo valandos" summary so a manager never has to switch the user filter just
// to inspect one person.
function WorkerDayDetailModal({ worker, date, items, tasks = [], onOpenTask, onClose }) {
    // Map a timeline item back to its task so each card can show the same confirmation status
    // (Patvirtinta / Nepatvirtinta / Ištrinta) the task carries everywhere else, and so clicking
    // it can open the full task. Sessions key by taskId; manual-task items key by their own id.
    const taskById = new Map(tasks.map(t => [t.id, t]));
    const taskForItem = (item) => taskById.get(item.taskId) || taskById.get(item.id) || null;

    // One chronological timeline — work segments and breaks interleaved in the order they
    // happened (items arrive sorted by startTime); inactive gaps are not shown. The day's work
    // and break totals sit in the header so the per-row breaks don't need a separate summary.
    const timeline = items.filter(i => i.type !== 'inactive');
    const dayWorkMinutes = timeline.filter(i => i.type !== 'break').reduce((a, i) => a + (i.duration || 0), 0);
    const dayBreakMinutes = timeline.filter(i => i.type === 'break').reduce((a, i) => a + (i.duration || 0), 0);

    return (
        <Modal open onClose={onClose} size="lg" title={worker.name}>
            {/* Day header: the date plus this worker's work and break totals for the day. */}
            <div className="-mt-2 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line pb-3 text-caption">
                <span className="font-mono text-ink-muted">{date}</span>
                <span className="text-ink-muted">Darbas <span className="font-mono font-bold text-ink-strong">{formatMinutesToTimeString(dayWorkMinutes)}</span></span>
                <span className="text-ink-muted">Pertraukos <span className="font-mono font-bold text-amber-700">{formatMinutesToTimeString(dayBreakMinutes)}</span></span>
            </div>

            {timeline.length === 0 ? (
                <p className="py-6 text-center text-ink-muted">Šią dieną įrašų nefiksuota.</p>
            ) : (
                <ul className="space-y-2">
                    {timeline.map((item, idx) => {
                        if (item.type === 'break') {
                            return (
                                <li key={item.id || idx}>
                                    <div className="flex items-start justify-between gap-3 rounded-control border border-line bg-amber-50/40 p-3 text-amber-700">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-1.5 font-medium">
                                                <Coffee className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                                                Pertrauka
                                            </div>
                                            <p className="mt-0.5 font-mono text-caption">
                                                {formatTime(item.startTime)} – {formatTime(item.endTime)}
                                            </p>
                                        </div>
                                        <span className="font-mono text-body font-bold whitespace-nowrap">
                                            {formatMinutesToTimeString(item.duration)}
                                        </span>
                                    </div>
                                </li>
                            );
                        }

                        const task = taskForItem(item);
                        const isDeleted = task && (task.isDeleted || task.status === 'deleted');

                        // The same card body for clickable (task resolved) and static rows.
                        const body = (
                            <>
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-1.5 text-body text-ink-strong">
                                        <SessionTypeIcon
                                            type={item.isSystemTask ? 'call' : (item.isQuickWork ? 'quickWork' : 'task')}
                                            className="w-3.5 h-3.5 flex-shrink-0"
                                            aria-hidden="true"
                                        />
                                        <span className="break-words font-medium">{item.title || 'Darbas'}</span>
                                        {task?.priority && <PriorityBadge priority={task.priority} />}
                                    </div>
                                    <p className="mt-0.5 font-mono text-caption text-ink-muted">
                                        {formatTime(item.startTime)} – {formatTime(item.endTime)}
                                    </p>
                                    {/* Status: running work reads "Vykdoma"; finished work shows the same
                                        Patvirtinta / Nepatvirtinta / Ištrinta the task carries elsewhere. */}
                                    <div className="mt-1">
                                        {item.isActive ? (
                                            <span className="inline-block rounded bg-feedback-success/10 px-1.5 py-0.5 text-caption font-semibold text-feedback-success">
                                                Vykdoma
                                            </span>
                                        ) : isDeleted ? (
                                            <DeletedBadge />
                                        ) : task ? (
                                            <TaskStatusPill task={task} />
                                        ) : null}
                                    </div>
                                </div>
                                <span className="font-mono text-body font-bold text-brand whitespace-nowrap">
                                    {formatMinutesToTimeString(item.duration)}
                                </span>
                            </>
                        );

                        return (
                            <li key={item.id || idx}>
                                {task ? (
                                    <button
                                        type="button"
                                        onClick={() => onOpenTask?.(task)}
                                        aria-label={`Atidaryti užduotį: ${item.title || 'Darbas'}`}
                                        className="flex w-full items-start justify-between gap-3 rounded-control border border-line p-3 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                                    >
                                        {body}
                                    </button>
                                ) : (
                                    <div className="flex items-start justify-between gap-3 rounded-control border border-line p-3">
                                        {body}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </Modal>
    );
}

// Mobile Stats Card Component
function MobileStatsCard({ task, onToggleConfirm, onAddComment: _onAddComment, onRestore, users, userRole, setActiveModal, onTimeChange, currentUser: _currentUser }) {
    const isConfirmed = task.status === 'confirmed';
    const worker = users.find(u => u.id === task.assignedUserId);
    const userName = worker ? (worker.displayName || worker.email) : (task.assignedUserName || '—');
    const [editingTime, setEditingTime] = useState(false);
    const [editHours, setEditHours] = useState(0);
    const [editMins, setEditMins] = useState(0);
    const [editReason, setEditReason] = useState('');
    const canEditTime = (userRole === 'admin');

    const startTimeEdit = () => {
        const totalMins = Math.round(calculateCurrentTotalMinutes(task));
        setEditHours(Math.floor(totalMins / 60));
        setEditMins(totalMins % 60);
        setEditReason('');
        setEditingTime(true);
    };

    const saveTimeEdit = () => {
        const newTotal = (editHours * 60) + editMins;
        onTimeChange(task, newTotal, editReason);
        setEditingTime(false);
        setEditReason('');
    };

    return (
        <div className={clsx(
            "p-3 rounded-control border mb-3 shadow-sm",
            isConfirmed ? "bg-surface-sunken border-line" : "bg-surface-card border-line"
        )}>
            <div className="flex justify-between items-start mb-2">
                <div className="flex-1">
                    <div className={clsx(
                        "font-bold text-body",
                        task.isDeleted && "line-through text-ink-muted"
                    )}>
                        {task.title}
                    </div>
                    {task.isDeleted && <DeletedBadge />}
                </div>

                <PriorityBadge priority={task.priority} className="ml-2" />
            </div>

            {task.description && (
                <div className="text-xs text-ink-muted mb-2 whitespace-pre-wrap break-words">
                    {task.description}
                </div>
            )}

            {(task.managerName || task.creatorName) && (
                <div className="text-caption text-ink-muted mb-2 flex items-center gap-1">
                    <User className="w-3 h-3" />
                    <span>Vadovas: {formatDisplayName(task.managerName || task.creatorName)}</span>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2 mb-2 text-caption text-ink-muted">
                <div className="bg-surface-sunken px-1.5 py-0.5 rounded flex items-center gap-1">
                    <User className="w-3 h-3" />
                    <span className="font-medium">{formatDisplayName(userName)}</span>
                </div>
                <div className="bg-surface-sunken px-1.5 py-0.5 rounded font-mono">
                    {editingTime ? (
                        <div className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1">
                                <input type="number" min="0" max="99" value={editHours} onChange={(e) => setEditHours(parseInt(e.target.value) || 0)} aria-label="Valandos" className="w-12 min-h-touch px-2 border rounded text-center text-caption" />h
                                <input type="number" min="0" max="59" value={editMins} onChange={(e) => setEditMins(parseInt(e.target.value) || 0)} aria-label="Minutės" className="w-12 min-h-touch px-2 border rounded text-center text-caption" />m
                            </div>
                            <input
                                type="text"
                                value={editReason}
                                onChange={(e) => setEditReason(e.target.value)}
                                aria-label="Laiko keitimo priežastis"
                                placeholder="Keitimo priežastis (privaloma)"
                                className="w-40 min-h-touch px-2 border border-line rounded text-caption font-sans"
                            />
                            <div className="flex items-center gap-1">
                                <IconButton icon={Check} label="Išsaugoti laiką" variant="primary" disabled={!editReason.trim()} onClick={saveTimeEdit} />
                                <IconButton icon={X} label="Atšaukti redagavimą" onClick={() => { setEditingTime(false); setEditReason(''); }} />
                            </div>
                        </div>
                    ) : (
                        <span className="flex items-center gap-1">
                            {task.estimatedTime || '-'} / {calculateCurrentTotalMinutes(task) !== 0 ? formatMinutesToTimeString(calculateCurrentTotalMinutes(task)) : '-'}
                            {canEditTime && (
                                <IconButton
                                    icon={Pencil}
                                    label="Keisti darbo laiką"
                                    title="Keisti laiką"
                                    onClick={startTimeEdit}
                                />
                            )}
                        </span>
                    )}
                    <TimeChangedWarning task={task} />
                </div>
                {task.deadline && (
                    <div className="bg-orange-50 text-orange-700 border border-orange-100 px-1.5 py-0.5 rounded flex items-center gap-1">
                        <Calendar className="w-3 h-3 text-orange-500" />
                        {task.deadline}
                    </div>
                )}
                {task.completedAt && (
                    <div className="bg-green-50 text-green-700 border border-green-100 px-1.5 py-0.5 rounded flex items-center gap-1">
                        <Check className="w-3 h-3 text-green-500" />
                        {new Date(task.completedAt).toLocaleString('lt-LT', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                )}
            </div>

            <div className="flex items-center justify-between mt-3 pt-2 border-t border-line">
                <div className="flex items-center gap-2">
                    {(isManagerRole(userRole)) ? (
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={isConfirmed}
                                onChange={() => onToggleConfirm(task)}
                                disabled={task.archivedAt}
                                className="w-4 h-4 rounded border-line text-feedback-success focus:ring-feedback-success"
                            />
                            <span className={clsx("text-xs font-medium", isConfirmed ? "text-feedback-success" : "text-ink-muted")}>
                                {isConfirmed ? "Patvirtinta" : "Nepatvirtinta"}
                            </span>
                        </label>
                    ) : (
                        <span className={clsx("text-xs font-medium", isConfirmed ? "text-feedback-success" : "text-ink-muted")}>
                            {isConfirmed ? "Būsena: Patvirtinta" : "Būsena: Laukiama patvirtinimo"}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-1">
                    <IconButton
                        icon={RotateCcw}
                        label="Grąžinti užduotį"
                        title="Grąžinti"
                        onClick={(e) => {
                            e.stopPropagation();
                            onRestore(task);
                        }}
                    />
                    <IconButton
                        label={`Komentarai (${task.comments?.length || 0})`}
                        title="Komentarai"
                        onClick={(e) => {
                            e.stopPropagation();
                            setActiveModal({ type: 'comments', taskId: task.id, task: task });
                        }}
                    >
                        <span className="flex items-center gap-1">
                            <MessageSquare className="w-4 h-4" aria-hidden="true" />
                            <span className="text-xs font-bold">{task.comments?.length || 0}</span>
                        </span>
                    </IconButton>
                </div>
            </div>

            {task.comments && task.comments.length > 0 && (
                <div className="mt-2 bg-surface-sunken rounded p-2 text-xs text-ink-muted">
                    {task.comments.slice(-2).map((c, i) => (
                        <div key={i} className="mb-1 last:mb-0">
                            <span className="font-bold">{c.user}:</span> {c.text}
                        </div>
                    ))}
                    {task.comments.length > 2 && (
                        <div className="text-caption text-ink-muted italic mt-1">
                            + dar {task.comments.length - 2} komentarai...
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// Task List Helper Component
function TaskListTable({ tasks, title, viewMode, onToggleConfirm, onAddComment, onRestore, onTimeChange, users, userRole, currentUser, expandedTasks, toggleExpand, setActiveModal, highlight = false, collapsible = false, defaultOpen = true }) {
    const [editingTimeTaskId, setEditingTimeTaskId] = useState(null);
    const [editHours, setEditHours] = useState(0);
    const [editMins, setEditMins] = useState(0);
    const [editReason, setEditReason] = useState('');
    // The header doubles as an accordion toggle on the approval surface (collapsible); elsewhere
    // the body is always shown.
    const [open, setOpen] = useState(defaultOpen);
    const canEditTime = (userRole === 'admin');

    const startTimeEdit = (task) => {
        const totalMins = Math.round(calculateCurrentTotalMinutes(task));
        setEditHours(Math.floor(totalMins / 60));
        setEditMins(totalMins % 60);
        setEditReason('');
        setEditingTimeTaskId(task.id);
    };

    const saveTimeEdit = (task) => {
        const newTotal = (editHours * 60) + editMins;
        onTimeChange(task, newTotal, editReason);
        setEditingTimeTaskId(null);
        setEditReason('');
    };

    return (
        <div className={clsx("rounded-card shadow-sm border border-line overflow-hidden mb-6", viewMode === 'mobile' ? "bg-transparent border-0 shadow-none" : "bg-surface-card")}>
            <div className={clsx(
                "px-4 border-b border-line",
                highlight ? "bg-brand text-white py-6" : "py-3 bg-surface-sunken text-ink",
                viewMode === 'mobile' && "rounded-control mb-2 border"
            )}>
                {collapsible ? (
                    <button
                        type="button"
                        onClick={() => setOpen((o) => !o)}
                        aria-expanded={open}
                        className={clsx(
                            "w-full min-h-touch flex items-center justify-between gap-2 text-left rounded focus-visible:outline-none focus-visible:ring-2",
                            // The highlighted (bg-brand) header needs a white focus ring — an indigo
                            // ring-brand on the indigo fill is invisible (WCAG 2.4.7 Focus Visible).
                            highlight ? "focus-visible:ring-white" : "focus-visible:ring-brand"
                        )}
                    >
                        <h3 className={clsx("font-bold transition-all", highlight ? "text-h3 md:text-h2" : "text-body")}>{title} ({tasks.length})</h3>
                        {open
                            ? <ChevronUp className={clsx("w-5 h-5 shrink-0", highlight ? "text-white" : "text-ink-muted")} aria-hidden="true" />
                            : <ChevronDown className={clsx("w-5 h-5 shrink-0", highlight ? "text-white" : "text-ink-muted")} aria-hidden="true" />}
                    </button>
                ) : (
                    <h3 className={clsx("font-bold transition-all", highlight ? "text-h3 md:text-h2" : "text-body")}>{title} ({tasks.length})</h3>
                )}
            </div>

            {(!collapsible || open) && (viewMode === 'mobile' ? (
                <div className="space-y-1">
                    {tasks.map(task => (
                        <MobileStatsCard
                            key={task.id}
                            task={task}
                            onToggleConfirm={onToggleConfirm}
                            onAddComment={onAddComment}
                            onRestore={onRestore}
                            onTimeChange={onTimeChange}
                            users={users}
                            userRole={userRole}
                            currentUser={currentUser}
                            setActiveModal={setActiveModal}
                        />
                    ))}
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full md:w-auto divide-y divide-line text-sm md:table-auto table-fixed">
                        <thead className="bg-surface-sunken">
                            <tr>
                                {(isManagerRole(userRole)) && <th scope="col" className="px-2 py-2 text-center w-8 text-caption font-bold text-ink-muted uppercase tracking-wider">OK</th>}
                                <th scope="col" className="px-2 py-2 md:px-2 md:py-1 text-left text-caption font-bold text-ink-muted uppercase tracking-wider min-w-[200px] md:w-auto">UŽDUOTIS</th>
                                <th scope="col" className="px-1 py-2 md:px-2 md:py-1 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-16 md:w-auto">DARB.</th>
                                <th scope="col" className="px-1 py-2 md:px-2 md:py-1 text-right text-caption font-bold text-ink-muted uppercase tracking-wider w-28 md:w-auto">PLAN. / TIKRAS</th>
                                <th scope="col" className="px-1 py-2 md:px-2 md:py-1 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-24 md:w-auto">ATLIKTA</th>
                                <th scope="col" className="px-1 py-2 md:px-2 md:py-1 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-16 md:w-auto">PRIO</th>
                                <th scope="col" className="px-1 py-2 md:px-2 md:py-1 text-left text-caption font-bold text-ink-muted uppercase tracking-wider w-16 md:w-auto">BŪSENA</th>
                                <th scope="col" className="px-1 py-2 md:px-2 md:py-1 text-center text-caption font-bold text-ink-muted uppercase tracking-wider w-10 md:w-auto">KOM.</th>
                                <th scope="col" className="px-1 py-2 md:px-2 md:py-1 text-center text-caption font-bold text-ink-muted uppercase tracking-wider w-10 md:w-auto"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                            {tasks.length === 0 ? (
                                <tr>
                                    <td colSpan="7" className="px-6 py-8 text-center text-ink-muted">
                                        Nėra užduočių.
                                    </td>
                                </tr>
                            ) : (
                                tasks.map((task) => {
                                    const isConfirmed = task.status === 'confirmed';
                                    const worker = users.find(u => u.id === task.assignedUserId);
                                    const userName = worker ? (worker.displayName || worker.email) : (task.assignedUserName || '—');

                                    return (
                                        <TaskRow
                                            key={task.id}
                                            task={task}
                                            rowClassName={clsx(
                                                "group transition-colors",
                                                isConfirmed ? "bg-surface-sunken" : "bg-surface-card hover:bg-surface-sunken"
                                            )}
                                            showConfirm={isManagerRole(userRole)}
                                            confirmChecked={isConfirmed}
                                            confirmDisabled={!!task.archivedAt}
                                            onToggleConfirm={onToggleConfirm}
                                            confirmAriaLabel="Patvirtinti atlikimą"
                                            assigneeName={userName}
                                            showCompletedAt
                                            completedAtCell={task.completedAt ? new Date(task.completedAt).toLocaleString('lt-LT', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}
                                            commentCount={task.comments?.length || 0}
                                            onOpenComments={() => setActiveModal({ type: 'comments', taskId: task.id, task: task })}
                                            titleCell={
                                                <>
                                                    <div
                                                        role="button"
                                                        tabIndex={0}
                                                        aria-expanded={expandedTasks.has(task.id)}
                                                        onClick={(e) => { e.stopPropagation(); toggleExpand(task.id); }}
                                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(task.id); } }}
                                                        className={clsx(
                                                        "text-sm font-bold text-ink-strong whitespace-normal break-words cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                                                        (task.isDeleted || task.status === 'deleted') && "line-through text-ink-muted"
                                                    )}>
                                                        {task.title}
                                                    </div>
                                                    {task.deadline && (
                                                        <div className="text-caption text-ink-muted flex items-center gap-1 mt-0.5 whitespace-nowrap">
                                                            <Calendar className="w-2.5 h-2.5" />
                                                            {task.deadline}
                                                        </div>
                                                    )}
                                                    <div className={clsx(
                                                        "text-caption text-ink-muted mt-0.5 flex items-start gap-1 cursor-pointer hover:text-ink whitespace-normal break-words",
                                                        expandedTasks.has(task.id) ? "whitespace-pre-wrap" : ""
                                                    )}>
                                                        <SessionTypeIcon
                                                            type={task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : 'task')}
                                                            className="w-3.5 h-3.5 flex-shrink-0 mt-0.5"
                                                        />
                                                        {task.description}
                                                    </div>
                                                    {expandedTasks.has(task.id) && task.comments && task.comments.length > 0 && (
                                                        <div className="mt-2 pl-4 border-l-2 border-line">
                                                            <div className="text-caption font-semibold text-ink-muted mb-1">Komentarai:</div>
                                                            {task.comments.map((comment, idx) => (
                                                                <div key={idx} className="text-caption text-ink-muted mb-1">
                                                                    <span className="font-medium">{comment.user}:</span> {comment.text}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {(task.managerName || task.creatorName) && (
                                                        <div className="text-caption text-ink-muted mt-1 flex items-center gap-1">
                                                            <User className="w-2.5 h-2.5" />
                                                            <span>Vadovas: {formatDisplayName(task.managerName || task.creatorName)}</span>
                                                        </div>
                                                    )}
                                                </>
                                            }
                                            timeCell={
                                                <>
                                                    {editingTimeTaskId === task.id ? (
                                                        <div className="flex flex-col items-end gap-1" onClick={(e) => e.stopPropagation()}>
                                                            <div className="flex items-center gap-1">
                                                                <input type="number" min="0" max="99" value={editHours} onChange={(e) => setEditHours(parseInt(e.target.value) || 0)} aria-label="Valandos" className="w-10 px-1 py-0.5 border rounded text-center text-caption" autoFocus />h
                                                                <input type="number" min="0" max="59" value={editMins} onChange={(e) => setEditMins(parseInt(e.target.value) || 0)} aria-label="Minutės" className="w-10 px-1 py-0.5 border rounded text-center text-caption" />m
                                                            </div>
                                                            <input
                                                                type="text"
                                                                value={editReason}
                                                                onChange={(e) => setEditReason(e.target.value)}
                                                                aria-label="Laiko keitimo priežastis"
                                                                placeholder="Keitimo priežastis (privaloma)"
                                                                className="w-44 px-1.5 py-0.5 border border-line rounded text-caption font-sans text-left"
                                                            />
                                                            <div className="flex items-center gap-1">
                                                                <IconButton icon={Check} label="Išsaugoti laiką" variant="primary" disabled={!editReason.trim()} onClick={() => saveTimeEdit(task)} />
                                                                <IconButton icon={X} label="Atšaukti redagavimą" onClick={() => { setEditingTimeTaskId(null); setEditReason(''); }} />
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <>
                                                            <span className="text-brand">{task.estimatedTime || '-'}</span>
                                                            <span className="text-ink-muted mx-1">/</span>
                                                            <span>{calculateCurrentTotalMinutes(task) !== 0 ? formatMinutesToTimeString(calculateCurrentTotalMinutes(task)) : '-'}</span>
                                                            {canEditTime && (
                                                                <IconButton
                                                                    icon={Pencil}
                                                                    label="Keisti darbo laiką"
                                                                    title="Keisti laiką"
                                                                    className="ml-1 align-middle"
                                                                    onClick={(e) => { e.stopPropagation(); startTimeEdit(task); }}
                                                                />
                                                            )}
                                                        </>
                                                    )}
                                                    <TimeChangedWarning task={task} alignEnd />
                                                </>
                                            }
                                            actions={
                                                <IconButton
                                                    icon={RotateCcw}
                                                    label="Grąžinti užduotį"
                                                    title="Grąžinti"
                                                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onRestore(task);
                                                    }}
                                                />
                                            }
                                        />
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            ))}
        </div>
    );
}
