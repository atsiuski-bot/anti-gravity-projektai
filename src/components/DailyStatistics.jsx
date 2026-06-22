import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, orderBy, updateDoc, setDoc, deleteDoc, addDoc } from 'firebase/firestore';
import { formatMinutesToTimeString, getLithuanianDateString, getLithuanianWeekday, getLithuanian3AMCutoff, addDaysToDateString, calculateCurrentTotalMinutes } from '../utils/timeUtils';
import { formatDisplayName, formatTime, isManagerRole, resolveUserId, resolveUserName } from '../utils/formatters';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import { addComment } from '../utils/commentActions';
import { logError } from '../utils/errorLog';
import { Calendar, Clock, Coffee, User, ChevronLeft, ChevronRight, Zap, MessageSquare, Check, Filter, RotateCcw, X, Pencil } from 'lucide-react';
import clsx from 'clsx';
import { CommentsModal } from './TaskDetailsModals';
import TaskHistory from './TaskHistory';
import SessionTypeIcon from './SessionTypeIcon';
import IconButton from './ui/IconButton';
import ConfirmDialog from './ui/ConfirmDialog';

export default function DailyStatistics({ currentUser, userRole, users = [], canExport = false }) {
    // Managers can see everyone, Workers only themselves
    const [selectedUserId, setSelectedUserId] = useState(isManagerRole(userRole) ? 'all' : currentUser?.uid);
    const [selectedDate, setSelectedDate] = useState(getLithuanianDateString());
    const [, setLoading] = useState(false);

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
        if (!selectedUserId || !selectedDate) return;

        setLoading(true);
        const weekday = getLithuanianWeekday(selectedDate);

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
        // has no firestore.indexes.json to declare).
        const breaksQ = query(collection(db, 'break_sessions'),
            where('date', '==', selectedDate));

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


        // 2. Listen to Work Sessions
        const sessionsBaseQ = collection(db, 'work_sessions');
        const sessionsQ = query(sessionsBaseQ, where('date', '==', selectedDate), orderBy('startTime', 'asc'));

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

        // Limit query to selectedDate + 2 days to capture anything archived shortly after completion
        // Start from beginning of selected day
        const startIso = `${selectedDate}T00:00:00`;

        // End 2 days later at end of day (handles weekend archives or delayed archiving)
        const rangeEndDate = new Date(selectedDate);
        rangeEndDate.setDate(rangeEndDate.getDate() + 2);
        const endIso = `${rangeEndDate.toISOString().split('T')[0]}T23:59:59`;

        activeQ = collection(db, 'tasks');
        archivedQ = query(
            collection(db, 'archived_tasks'),
            where('archivedAt', '>=', startIso),
            where('archivedAt', '<=', endIso)
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

            // Filter for finished OR deleted today OR unconfirmed (status === 'completed' and active)
            const finishedToday = allRelevantTasks.filter(t => {
                const compDate = t.completedAt?.split('T')[0];
                const archDate = t.archivedAt?.split('T')[0];
                const delDate = t.deletedAt?.split('T')[0];

                const isRelevantDate = compDate === selectedDate || archDate === selectedDate || delDate === selectedDate;

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
        const deletedQ = collection(db, 'deleted_tasks');

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
    }, [selectedUserId, selectedDate]);

    // Helper to get 3AM cutoff for "today"
    const get3AMCutoff = () => {
        return getLithuanian3AMCutoff(selectedDate);
    };

    // Sorting state
    const [sortBy, setSortBy] = useState('time'); // 'time' or 'status'

    // Split finished tasks into Today, Earlier, and Archived
    const splitTasks = useMemo(() => {
        const cutoff = get3AMCutoff();
        // End the window at the NEXT calendar day's 03:00 cutoff, not "cutoff + 24h":
        // across a DST switch a fixed +24h drifts the boundary by an hour, dropping or
        // double-counting work done in that hour.
        const nextDayCutoff = getLithuanian3AMCutoff(addDaysToDateString(selectedDate, 1));

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
        // eslint-disable-next-line react-hooks/exhaustive-deps -- get3AMCutoff only reads selectedDate, already listed
    }, [finishedTasks, selectedDate, sortBy]);

    const { todayTasks, earlierTasks, archivedTasks } = splitTasks;

    // ALL sessions go into the timeline — Quick Work and Calls are regular work sessions,
    // they were previously excluded to avoid double-count with manualTasks but that caused them to vanish.
    const validSessions = sessions;

    // Active Sessions Integration
    const activeTaskSessionsForToday = useMemo(() => {
        const active = [];
        if (selectedDate !== getLithuanianDateString()) return active;
        
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
    }, [users, selectedDate, selectedUserId, currentTime]);

    const activeBreaksForToday = useMemo(() => {
        const active = [];
        if (selectedDate !== getLithuanianDateString()) return active;
        
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
    }, [users, selectedDate, selectedUserId, currentTime]);

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
        const nextDayCutoff = getLithuanian3AMCutoff(addDaysToDateString(selectedDate, 1));

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
        // eslint-disable-next-line react-hooks/exhaustive-deps -- get3AMCutoff only reads selectedDate, already listed
    }, [finishedTasks, sessions, selectedDate]);

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
                type: 'session',
                startTime: s.startTime,
                endTime: s.endTime,
                title: title,
                duration: s.durationMinutes,
                userId: resolveUserId(s),
                userName: resolveUserName(s) || 'Nežinomas',
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

        // Inject inactive gaps for individual mode (matches Reports.jsx logic)
        if (selectedUserId !== 'all' && sortedItems.length > 0) {
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
    }, [allValidSessions, manualTasks, allBreakSessions, selectedUserId]);


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
                    userName: task.assignedUserName || task.creatorName || 'Nežinomas darbuotojas',
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
        <div className="space-y-6">
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

            {/* Header Controls — kept to a single compact row on every viewport (no column
                stacking on mobile) so the date stepper + filters take minimal vertical space. */}
            <div className="bg-surface-card p-2 rounded-card shadow-sm border border-line flex flex-row flex-wrap gap-2 items-center justify-between">

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

                {(isManagerRole(userRole)) && users.length > 0 && (
                    <div className="relative">
                        <select
                            value={selectedUserId}
                            onChange={(e) => setSelectedUserId(e.target.value)}
                            aria-label="Darbuotojas"
                            className="pl-8 pr-3 py-1.5 border border-line rounded-control focus:ring-2 focus:ring-brand text-caption bg-surface-card"
                        >
                            <option value="all">Už visą komandą</option>
                            {users.map(u => (
                                <option key={u.id} value={u.id}>
                                    {formatDisplayName(u.displayName || u.email)}
                                </option>
                            ))}
                        </select>
                        <User className="w-3.5 h-3.5 text-ink-muted absolute left-2.5 top-1/2 transform -translate-y-1/2" />
                    </div>
                )}

                {/* Sort filter — a vertical two-option segmented control (Pagal laiką above
                    Pagal būseną) rather than a dropdown, so both choices are visible at once. */}
                <div
                    className="flex flex-col bg-surface-sunken rounded-control overflow-hidden border border-line"
                    role="group"
                    aria-label="Rūšiuoti"
                >
                    <button
                        type="button"
                        onClick={() => setSortBy('time')}
                        aria-pressed={sortBy === 'time'}
                        className={clsx(
                            "flex items-center gap-1.5 px-3 py-1.5 text-caption font-semibold transition-colors text-left",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
                            sortBy === 'time' ? "bg-brand text-white" : "text-ink hover:bg-surface-card"
                        )}
                    >
                        <Filter className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        Pagal laiką
                    </button>
                    <div className="h-px bg-line" aria-hidden="true" />
                    <button
                        type="button"
                        onClick={() => setSortBy('status')}
                        aria-pressed={sortBy === 'status'}
                        className={clsx(
                            "flex items-center gap-1.5 px-3 py-1.5 text-caption font-semibold transition-colors text-left",
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
                {selectedUserId !== 'all' && (
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

            {/* Desktop: the spacious four-card grid (unchanged). */}
            <div className="hidden md:grid grid-cols-4 gap-4">
                {selectedUserId !== 'all' && (
                    <div className="bg-surface-card p-5 rounded-card shadow-sm border border-line">
                        <div className="flex items-center gap-3 mb-2 text-ink-muted text-body font-medium">
                            <Clock className="w-4 h-4" />
                            Dienos Pradžia/Pabaiga
                        </div>
                        <div className="text-body-lg font-semibold text-ink-strong">
                            {firstActivity ? formatTime(firstActivity) : '--:--'} - {lastActivity ? formatTime(lastActivity) : '--:--'}
                        </div>
                        <div className="text-caption text-ink-muted mt-1">
                            Pagal pirmą/paskutinį įrašą
                        </div>
                    </div>
                )}

                <div className="bg-surface-card p-5 rounded-card shadow-sm border border-line">
                    <div className="flex items-center gap-3 mb-2 text-ink-muted text-body font-medium">
                        <Clock className="w-4 h-4" />
                        Darbo laikas
                    </div>
                    <div className="text-h2 font-bold text-ink-strong">
                        {formatMinutesToTimeString(totalWorkedMinutes)}
                    </div>
                </div>


                <div className="bg-surface-card p-5 rounded-card shadow-sm border border-line">
                    <div className="flex items-center gap-3 mb-2 text-ink-muted text-body font-medium">
                        <Coffee className="w-4 h-4" />
                        Pertraukos
                    </div>
                    <div className="text-h2 font-bold text-amber-600">
                        {formatMinutesToTimeString(totalBreakMinutes)}
                    </div>
                    <div className="text-caption text-ink-muted mt-1">
                        Viso pertraukų laikas
                    </div>
                </div>

                <div className="bg-surface-card p-5 rounded-card shadow-sm border border-line">
                    <div className="flex items-center gap-3 mb-2 text-brand text-body font-medium">
                        <Zap className="w-4 h-4" />
                        Viso (D+P)
                    </div>
                    <div className="text-h2 font-bold text-brand">
                        {formatMinutesToTimeString(totalWorkedMinutes + totalBreakMinutes)}
                    </div>
                    <div className="text-caption text-ink-muted mt-1">
                        Darbas + Pertraukos
                    </div>
                </div>



            </div>

            {/* Timeline Table or Worker Summary */}
            <div className="bg-surface-card rounded-card shadow-sm border border-line overflow-hidden">
                <div className="px-6 py-4 border-b border-line bg-surface-sunken text-ink-strong">
                    <h3 className="font-semibold">{selectedUserId === 'all' ? 'Darbo valandos' : 'Darbų eiga (Timeline)'}</h3>
                </div>

                {combinedTimelineItems.length === 0 ? (
                    <div className="p-12 text-center text-ink-muted">
                        <p>Šią dieną darbo sesijų nefiksuota.</p>
                    </div>
                ) : selectedUserId === 'all' ? (
                    <>
                        {/* Mobile: one card per worker — never a horizontal table on a phone (§9) */}
                        <ul className="divide-y divide-line md:hidden">
                            {workerList.map(([userId, summary]) => (
                                <li key={userId} className="p-4">
                                    <p className="text-body font-semibold text-ink-strong">{summary.name}</p>
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

                        {/* Desktop: dense team summary table */}
                        <div className="hidden overflow-x-auto md:block">
                        <table className="w-full md:w-auto divide-y divide-line text-sm">
                            <thead className="bg-surface-sunken">
                                <tr>
                                    <th scope="col" className="px-4 py-3 md:px-2 md:py-2 text-left font-medium text-ink-muted">Darbuotojas</th>
                                    <th scope="col" className="px-4 py-3 md:px-2 md:py-2 text-center font-medium text-ink-muted">Pradžia</th>
                                    <th scope="col" className="px-4 py-3 md:px-2 md:py-2 text-center font-medium text-ink-muted">Pabaiga</th>
                                    <th scope="col" className="px-4 py-3 md:px-2 md:py-2 text-right font-medium text-ink-muted">Pertraukos</th>
                                    <th scope="col" className="px-4 py-3 md:px-2 md:py-2 text-right font-medium text-ink-muted">Užduotims</th>
                                    <th scope="col" className="px-4 py-3 md:px-2 md:py-2 text-right font-medium text-ink-strong" title="Bendras laikas: darbas ir pertraukos — ne tik darbo valandos.">Bendras laikas</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-line">
                                {workerList.map(([userId, summary]) => (
                                    <tr key={userId} className="hover:bg-surface-sunken">
                                        <td className="px-4 py-3 text-ink-strong font-medium">
                                            {summary.name}
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
                                        <td className="px-4 py-3 md:px-2 md:py-2 text-right text-ink-strong font-mono font-bold bg-blue-50/10">
                                            {formatMinutesToTimeString(summary.taskTimeMinutes + summary.breakMinutes)}
                                        </td>
                                    </tr>
                                ))}
                                <tr className="bg-surface-sunken font-bold">
                                    <td colSpan="3" className="px-4 py-3 text-right text-ink-strong">
                                        Viso komanda:
                                    </td>
                                    <td className="px-4 py-3 md:px-2 md:py-2 text-right text-amber-700">
                                        {formatMinutesToTimeString(totalBreakMinutes)}
                                    </td>
                                    <td className="px-4 py-3 md:px-2 md:py-2 text-right text-indigo-700">
                                        {formatMinutesToTimeString(totalWorkedMinutes)}
                                    </td>
                                    <td className="px-4 py-3 md:px-2 md:py-2 text-right text-ink-strong font-bold bg-blue-50/30">
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


            {todayTasks.length > 0 && (
                <TaskListTable
                    tasks={todayTasks}
                    title={`Užduotys atliktos ${selectedDate} ${weekday}`}
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
                />
            )}

            {earlierTasks.length > 0 && (
                <TaskListTable
                    tasks={earlierTasks}
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
                />
            )}

            {/* Replaced legacy archived table with full TaskHistory component */}
            <div className="mt-8">
                <TaskHistory userId={selectedUserId} users={users} canExport={canExport} />
            </div>

            {todayTasks.length === 0 && earlierTasks.length === 0 && archivedTasks.length === 0 && (
                <div className="bg-surface-card p-8 rounded-card shadow-sm text-center text-ink-muted">
                    Nėra atliktų užduočių šiai dienai.
                </div>
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
        </div>
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
                    {task.isDeleted && (
                        <span className="text-caption font-bold text-feedback-danger uppercase bg-feedback-danger/10 px-1 py-0.5 rounded">Ištrinta</span>
                    )}
                </div>

                <span
                    className={clsx(
                        "px-1.5 py-0.5 text-caption font-bold rounded-md border border-black/5 uppercase whitespace-nowrap ml-2"
                    )}
                    style={{
                        backgroundColor: getPriorityColor(task.priority),
                        color: getPriorityTextColor(task.priority)
                    }}
                >
                    {getPriorityLabel(task.priority)}
                </span>
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
                    {task.timeChanged && (
                        <span className="block mt-0.5">
                            <span className="block text-feedback-danger font-bold text-caption uppercase tracking-wide">⚠ Pakeistas laikas</span>
                            {Number.isFinite(task.timeChangedFrom) && Number.isFinite(task.timeChangedTo) && (
                                <span className="block text-caption text-ink-muted font-sans normal-case font-normal">
                                    {formatMinutesToTimeString(task.timeChangedFrom)} → {formatMinutesToTimeString(task.timeChangedTo)}
                                </span>
                            )}
                            {task.timeChangedReason && (
                                <span className="block text-caption text-ink-muted font-sans normal-case font-normal italic break-words">
                                    „{task.timeChangedReason}“{task.timeChangedByName ? ` — ${formatDisplayName(task.timeChangedByName)}` : ''}
                                </span>
                            )}
                        </span>
                    )}
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
function TaskListTable({ tasks, title, viewMode, onToggleConfirm, onAddComment, onRestore, onTimeChange, users, userRole, currentUser, expandedTasks, toggleExpand, setActiveModal, highlight = false }) {
    const [editingTimeTaskId, setEditingTimeTaskId] = useState(null);
    const [editHours, setEditHours] = useState(0);
    const [editMins, setEditMins] = useState(0);
    const [editReason, setEditReason] = useState('');
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
                <h3 className={clsx("font-bold transition-all", highlight ? "text-h3 md:text-h2" : "text-body")}>{title} ({tasks.length})</h3>
            </div>

            {viewMode === 'mobile' ? (
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
                                        <tr
                                            key={task.id}
                                            className={clsx(
                                                "group transition-colors",
                                                isConfirmed ? "bg-surface-sunken" : "bg-surface-card hover:bg-surface-sunken"
                                            )}
                                        >
                                            {(isManagerRole(userRole)) && (
                                                <td className="px-2 py-2 text-center">
                                                    <input
                                                        type="checkbox"
                                                        checked={isConfirmed}
                                                        onChange={() => onToggleConfirm(task)}
                                                        disabled={task.archivedAt}
                                                        aria-label="Patvirtinti atlikimą"
                                                        className="w-4 h-4 rounded border-line text-feedback-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-feedback-success focus-visible:ring-offset-1 cursor-pointer"
                                                    />
                                                </td>
                                            )}
                                            <td className="px-2 py-2" onClick={() => toggleExpand(task.id)}>
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
                                            </td>
                                            <td className="px-1 py-2 whitespace-nowrap">
                                                <span className="px-2 py-1 rounded-full text-caption font-medium bg-surface-sunken text-ink border border-line">
                                                    {formatDisplayName(userName).split(' ')[0]}
                                                </span>
                                            </td>
                                            <td className="px-1 py-2 text-right text-ink-strong font-mono text-sm whitespace-nowrap">
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
                                                {task.timeChanged && (
                                                    <div className="mt-0.5">
                                                        <div className="text-feedback-danger font-bold text-caption uppercase tracking-wide">⚠ Pakeistas laikas</div>
                                                        {Number.isFinite(task.timeChangedFrom) && Number.isFinite(task.timeChangedTo) && (
                                                            <div className="text-caption text-ink-muted font-sans normal-case font-normal">
                                                                {formatMinutesToTimeString(task.timeChangedFrom)} → {formatMinutesToTimeString(task.timeChangedTo)}
                                                            </div>
                                                        )}
                                                        {task.timeChangedReason && (
                                                            <div className="text-caption text-ink-muted font-sans normal-case font-normal italic break-words max-w-[12rem] ml-auto">
                                                                „{task.timeChangedReason}“{task.timeChangedByName ? ` — ${formatDisplayName(task.timeChangedByName)}` : ''}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </td>
                                            <td className="px-1 py-2 whitespace-nowrap text-caption text-ink-muted">
                                                {task.completedAt ? new Date(task.completedAt).toLocaleString('lt-LT', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}
                                            </td>
                                            <td className="px-1 py-2 whitespace-nowrap">
                                                <span
                                                    className={clsx(
                                                        "px-1.5 py-0.5 inline-flex text-caption leading-4 font-semibold rounded-md border border-black/5 uppercase"
                                                    )}
                                                    style={{
                                                        backgroundColor: getPriorityColor(task.priority),
                                                        color: getPriorityTextColor(task.priority)
                                                    }}
                                                >
                                                    {getPriorityLabel(task.priority)}
                                                </span>
                                            </td>
                                            <td className="px-1 py-2 whitespace-nowrap">
                                                {(task.isDeleted || task.status === 'deleted') ? (
                                                    <span className="px-2 py-0.5 rounded text-caption font-semibold bg-feedback-danger/10 text-feedback-danger border border-feedback-danger">
                                                        Ištrinta
                                                    </span>
                                                ) : isConfirmed ? (
                                                    <span className="px-2 py-0.5 rounded text-caption font-semibold bg-feedback-success/10 text-feedback-success border border-feedback-success">
                                                        Patvirt.
                                                    </span>
                                                ) : (
                                                    <span className="px-2 py-0.5 rounded text-caption font-medium bg-surface-sunken text-ink">
                                                        Nepatv.
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-1 py-2 text-center whitespace-nowrap">
                                                <IconButton
                                                    label={`Komentarai (${task.comments?.length || 0})`}
                                                    title="Komentarai"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setActiveModal({ type: 'comments', taskId: task.id, task: task });
                                                    }}
                                                >
                                                    <span className="inline-flex items-center">
                                                        <MessageSquare className="w-4 h-4" aria-hidden="true" />
                                                        {task.comments?.length > 0 && (
                                                            <span className="ml-0.5 text-caption font-bold">{task.comments.length}</span>
                                                        )}
                                                    </span>
                                                </IconButton>
                                            </td>
                                            <td className="px-1 py-2 text-center whitespace-nowrap">
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
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
