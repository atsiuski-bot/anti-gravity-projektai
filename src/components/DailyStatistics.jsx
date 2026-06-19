import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, getDoc, orderBy, updateDoc, setDoc, deleteDoc, addDoc } from 'firebase/firestore';
import { formatMinutesToTimeString, getLithuanianDateString, getLithuanianWeekday, getLithuanian3AMCutoff, calculateCurrentTotalMinutes } from '../utils/timeUtils';
import { formatDisplayName, formatTime, isManagerRole, resolveUserId, resolveUserName } from '../utils/formatters';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import { addComment } from '../utils/commentActions';
import { STATUS_COLORS, STATUS_LABELS } from '../utils/taskConstants';
import { Calendar, Clock, Coffee, User, Briefcase, ChevronLeft, ChevronRight, Zap, Phone, MessageSquare, Check, Filter, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { CommentsModal } from './TaskDetailsModals';
import TaskHistory from './TaskHistory';
import SessionTypeIcon from './SessionTypeIcon';

export default function DailyStatistics({ currentUser, userRole, users = [] }) {
    // Managers can see everyone, Workers only themselves
    const [selectedUserId, setSelectedUserId] = useState(isManagerRole(userRole) ? 'all' : currentUser?.uid);
    const [selectedDate, setSelectedDate] = useState(getLithuanianDateString());
    const [loading, setLoading] = useState(false);

    // Data states
    const [dailyStats, setDailyStats] = useState(null); // From daily_stats collection (legacy/ref for other stats if any)
    const [breakSessions, setBreakSessions] = useState([]); // from break_sessions collection
    const [sessions, setSessions] = useState([]); // From work_sessions collection
    const [scheduledTasks, setScheduledTasks] = useState([]); // Tasks planned for this weekday
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



        // 1. Listen to Break Sessions (New Logic: Query by startTime range for robustness)
        // This ensures we catch historical sessions that might lack the 'date' field
        const startOfDay = `${selectedDate}T00:00:00`;
        const endOfDay = `${selectedDate}T23:59:59`;

        const breaksQ = query(collection(db, 'break_sessions'),
            where('startTime', '>=', startOfDay),
            where('startTime', '<=', endOfDay),
            orderBy('startTime', 'asc'));

        const unsubBreaks = onSnapshot(breaksQ, (snap) => {
            const breaksData = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(brk => {
                const brkUserId = resolveUserId(brk);
                if (selectedUserId !== 'all' && brkUserId !== selectedUserId) return false;
                return true;
            });
            setBreakSessions(breaksData);
        }, (error) => {
            console.error("Error fetching break sessions:", error);
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
            console.error("Error fetching sessions:", error);
            setLoading(false);
        });

        // 3. Listen to Tasks (Active & Archived)
        let activeQ, archivedQ;

        // Limit query to selectedDate + 2 days to capture anything archived shortly after completion
        const rangeStartDate = new Date(selectedDate);
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
        // nextDayCutoff is exactly 24 hours after current cutoff
        const nextDayCutoff = new Date(cutoff.getTime() + 24 * 60 * 60 * 1000);

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
    }, [finishedTasks, selectedDate, sortBy]);

    const { todayTasks, earlierTasks, archivedTasks } = splitTasks;

    // ALL sessions go into the timeline — Quick Work and Calls are regular work sessions,
    // they were previously excluded to avoid double-count with manualTasks but that caused them to vanish.
    const validSessions = useMemo(() => sessions, [sessions]);

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
        const nextDayCutoff = new Date(cutoff.getTime() + 24 * 60 * 60 * 1000);

        // Build a set of taskIds that already have explicit work_sessions
        const taskIdsWithSessions = new Set(sessions.map(s => s.taskId).filter(Boolean));

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
            // Try to recover - maybe it's in the other collection?
            if (err.code === 'not-found') {
                alert("Klaida: Dokumentas nerastas. Pabandykite perkrauti puslapį.");
            } else {
                alert("Klaida keičiant statusą: " + err.message);
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
            alert("Nepavyko pridėti komentaro.");
        }
    };

    const handleRestore = async (task) => {
        if (!window.confirm('Ar norite grąžinti užduotį į aktyvių sąrašą?')) return;
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
        } catch (err) {
            console.error("Error restoring task:", err);
            alert("Klaida grąžinant užduotį: " + err.message);
        }
    };

    const handleTimeChange = async (task, newTotalMinutes) => {
        try {
            const collectionName = (task.archivedAt || task.isDeleted || task.status === 'deleted') ? 'archived_tasks' : 'tasks';
            
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
                timeChangedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            
            if (!task.id) throw new Error("Missing task ID");
            await updateDoc(doc(db, collectionName, task.id), updates);

            // True database update to ensure time goes to statistics
            const currentTotal = Math.round(calculateCurrentTotalMinutes(task)) || 0;
            const difference = (newTotalMinutes || 0) - currentTotal;

            if (difference !== 0) {
                const completedDateDate = task.completedAt ? new Date(task.completedAt) : new Date();
                
                // Construct payload explicitly removing undefined to prevent Firestore assertions
                const payload = {
                    taskId: task.id || 'unknown_id',
                    taskTitle: `🕒 Laiko korekcija: ${task.title || 'Užduotis'}`,
                    userId: task.assignedUserId || task.creatorId || 'unknown',
                    userName: task.assignedUserName || task.creatorName || 'Nežinomas darbuotojas',
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
        } catch (err) {
            console.error('Error changing task time:', err);
            alert('Nepavyko pakeisti laiko: ' + err.message);
        }
    };

    // View mode state for responsive design
    const [viewMode, setViewMode] = useState('desktop');

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
            {/* Header Controls */}
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 flex flex-col md:flex-row gap-4 items-center justify-between">

                <div className="flex items-center gap-4 bg-gray-50 p-1.5 rounded-lg border border-gray-200">
                    <button onClick={() => handleDateChange(-1)} className="p-2 hover:bg-white rounded-md transition-colors text-gray-600">
                        <ChevronLeft className="w-5 h-5" />
                    </button>
                    <div className="flex items-center gap-2 px-2 min-w-[140px] justify-center font-medium text-gray-900">
                        <Calendar className="w-4 h-4 text-gray-500" />
                        {selectedDate}
                    </div>
                    <button onClick={() => handleDateChange(1)} className="p-2 hover:bg-white rounded-md transition-colors text-gray-600">
                        <ChevronRight className="w-5 h-5" />
                    </button>
                </div>

                {(isManagerRole(userRole)) && users.length > 0 && (
                    <div className="relative">
                        <select
                            value={selectedUserId}
                            onChange={(e) => setSelectedUserId(e.target.value)}
                            className="pl-9 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm bg-white min-w-[200px]"
                        >
                            <option value="all">Už visą komandą</option>
                            {users.map(u => (
                                <option key={u.id} value={u.id}>
                                    {formatDisplayName(u.displayName || u.email)}
                                </option>
                            ))}
                        </select>
                        <User className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 transform -translate-y-1/2" />
                    </div>
                )}

                <div className="relative">
                    <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value)}
                        className="pl-9 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm bg-white"
                    >
                        <option value="time">Pagal laiką</option>
                        <option value="status">Pagal būseną</option>
                    </select>
                    <Filter className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 transform -translate-y-1/2" />
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {selectedUserId !== 'all' && (
                    <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-200">
                        <div className="flex items-center gap-3 mb-2 text-gray-500 text-sm font-medium">
                            <Clock className="w-4 h-4" />
                            Dienos Pradžia/Pabaiga
                        </div>
                        <div className="text-lg font-semibold text-gray-900">
                            {firstActivity ? formatTime(firstActivity) : '--:--'} - {lastActivity ? formatTime(lastActivity) : '--:--'}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                            Pagal pirmą/paskutinį įrašą
                        </div>
                    </div>
                )}

                <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-200">
                    <div className="flex items-center gap-3 mb-2 text-gray-500 text-sm font-medium">
                        <Clock className="w-4 h-4" />
                        Darbo laikas
                    </div>
                    <div className="text-2xl font-bold text-gray-900">
                        {formatMinutesToTimeString(totalWorkedMinutes)}
                    </div>
                </div>


                <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-200">
                    <div className="flex items-center gap-3 mb-2 text-gray-500 text-sm font-medium">
                        <Coffee className="w-4 h-4" />
                        Pertraukos
                    </div>
                    <div className="text-2xl font-bold text-amber-600">
                        {formatMinutesToTimeString(totalBreakMinutes)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                        Viso pertraukų laikas
                    </div>
                </div>

                <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-200">
                    <div className="flex items-center gap-3 mb-2 text-blue-600 text-sm font-medium">
                        <Zap className="w-4 h-4" />
                        Viso (D+P)
                    </div>
                    <div className="text-2xl font-bold text-blue-700">
                        {formatMinutesToTimeString(totalWorkedMinutes + totalBreakMinutes)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                        Darbas + Pertraukos
                    </div>
                </div>



            </div>

            {/* Timeline Table or Worker Summary */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200 bg-gray-50 text-gray-900">
                    <h3 className="font-semibold">{selectedUserId === 'all' ? 'Darbo valandos' : 'Darbų eiga (Timeline)'}</h3>
                </div>

                {combinedTimelineItems.length === 0 ? (
                    <div className="p-12 text-center text-gray-500">
                        <p>Šią dieną darbo sesijų nefiksuota.</p>
                    </div>
                ) : selectedUserId === 'all' ? (
                    /* TEAM MODE SUMMARY TABLE */
                    <div className="overflow-x-auto">
                        <table className="w-full md:w-auto divide-y divide-gray-200 text-sm">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-left font-medium text-gray-500">Darbuotojas</th>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-center font-medium text-gray-500">Pradžia</th>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-center font-medium text-gray-500">Pabaiga</th>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-right font-medium text-gray-500">Pertraukos</th>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-right font-medium text-gray-500">Užduotims</th>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-right font-medium text-gray-900">Viso(D+P)</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {workerList.map(([userId, summary]) => (
                                    <tr key={userId} className="hover:bg-gray-50">
                                        <td className="px-4 py-3 text-gray-900 font-medium">
                                            {summary.name}
                                        </td>
                                        <td className="px-4 py-3 text-center text-gray-600 font-mono text-xs">
                                            {formatTime(summary.earliestStart)}
                                        </td>
                                        <td className="px-4 py-3 text-center text-gray-600 font-mono text-xs">
                                            {formatTime(summary.latestEnd)}
                                        </td>
                                        <td className="px-4 py-3 text-right text-amber-600 font-mono">
                                            {formatMinutesToTimeString(summary.breakMinutes)}
                                        </td>
                                        <td className="px-4 py-3 text-right text-indigo-600 font-mono font-semibold">
                                            {formatMinutesToTimeString(summary.taskTimeMinutes)}
                                        </td>
                                        <td className="px-4 py-3 md:px-2 md:py-2 text-right text-gray-900 font-mono font-bold bg-blue-50/10">
                                            {formatMinutesToTimeString(summary.taskTimeMinutes + summary.breakMinutes)}
                                        </td>
                                    </tr>
                                ))}
                                <tr className="bg-gray-50 font-bold">
                                    <td colSpan="3" className="px-4 py-3 text-right text-gray-900">
                                        Viso komanda:
                                    </td>
                                    <td className="px-4 py-3 md:px-2 md:py-2 text-right text-amber-700">
                                        {formatMinutesToTimeString(totalBreakMinutes)}
                                    </td>
                                    <td className="px-4 py-3 md:px-2 md:py-2 text-right text-indigo-700">
                                        {formatMinutesToTimeString(totalWorkedMinutes)}
                                    </td>
                                    <td className="px-4 py-3 md:px-2 md:py-2 text-right text-gray-900 font-bold bg-blue-50/30">
                                        {formatMinutesToTimeString(totalWorkedMinutes + totalBreakMinutes)}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                ) : (
                    /* INDIVIDUAL MODE TIMELINE TABLE */
                    <div className="overflow-x-auto">
                        <table className="w-full md:w-auto divide-y divide-gray-200 text-sm">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-left font-medium text-gray-500 w-24">Laikas</th>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-left font-medium text-gray-500">Užduotis</th>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-right font-medium text-gray-500 w-32">Trukmė</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {combinedTimelineItems.map((item, idx) => (
                                    <tr key={item.id || idx} className={`text-xs hover:bg-gray-50 border-b border-gray-100 last:border-0 ${item.type === 'break' ? 'text-amber-700 bg-amber-50/10' : item.type === 'inactive' ? 'text-gray-400 italic' : 'text-gray-600'}`}>
                                        <td className="px-4 py-3 font-mono text-gray-500 w-24">
                                            {formatTime(item.startTime)} - {formatTime(item.endTime)}
                                        </td>
                                        <td className="px-4 py-3 font-medium flex-grow truncate">
                                            {item.type === 'break' ? (
                                                <span className="flex items-center gap-1.5"><SessionTypeIcon type="break" className="w-3.5 h-3.5" /> Pertrauka</span>
                                            ) : item.type === 'inactive' ? (
                                                <span className="flex items-center gap-1.5 text-gray-400">{item.title || 'Neaktyvus'}</span>
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
                                        <td className={`px-4 py-3 font-mono font-bold w-full text-right ${item.type === 'break' ? 'text-amber-600' : item.type === 'inactive' ? 'text-gray-400' : 'text-blue-600'}`}>
                                            {formatMinutesToTimeString(item.duration)}
                                        </td>
                                    </tr>
                                ))}
                                <tr className="bg-gray-50 font-semibold">
                                    <td colSpan="2" className="px-4 py-3 text-right text-gray-900">
                                        Viso (Timer + Manual):
                                    </td>
                                    <td className="px-4 py-3 md:px-2 md:py-2 text-right text-indigo-600">
                                        {formatMinutesToTimeString(totalWorkedMinutes)}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
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
                <TaskHistory userId={selectedUserId} users={users} />
            </div>

            {todayTasks.length === 0 && earlierTasks.length === 0 && archivedTasks.length === 0 && (
                <div className="bg-white p-8 rounded-xl shadow-sm text-center text-gray-500">
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
        </div>
    );
}

// Mobile Stats Card Component
function MobileStatsCard({ task, onToggleConfirm, onAddComment, onRestore, users, userRole, setActiveModal, onTimeChange, currentUser }) {
    const isConfirmed = task.status === 'confirmed';
    const worker = users.find(u => u.id === task.assignedUserId);
    const userName = worker ? (worker.displayName || worker.email) : (task.assignedUserName || '—');
    const [editingTime, setEditingTime] = useState(false);
    const [editHours, setEditHours] = useState(0);
    const [editMins, setEditMins] = useState(0);
    const canEditTime = (userRole === 'admin');

    const startTimeEdit = () => {
        const totalMins = Math.round(calculateCurrentTotalMinutes(task));
        setEditHours(Math.floor(totalMins / 60));
        setEditMins(totalMins % 60);
        setEditingTime(true);
    };

    const saveTimeEdit = () => {
        const newTotal = (editHours * 60) + editMins;
        onTimeChange(task, newTotal);
        setEditingTime(false);
    };

    return (
        <div className={clsx(
            "p-3 rounded-lg border mb-3 shadow-sm",
            isConfirmed ? "bg-gray-100 border-gray-200" : "bg-white border-gray-200"
        )}>
            <div className="flex justify-between items-start mb-2">
                <div className="flex-1">
                    <div className={clsx(
                        "font-bold text-sm",
                        task.isDeleted && "line-through text-gray-500"
                    )}>
                        {task.title}
                    </div>
                    {task.isDeleted && (
                        <span className="text-[9px] font-bold text-red-600 uppercase bg-red-50 px-1 py-0.5 rounded">Ištrinta</span>
                    )}
                </div>

                <span
                    className={clsx(
                        "px-1.5 py-0.5 text-[10px] font-bold rounded-md border border-black/5 uppercase whitespace-nowrap ml-2"
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
                <div className="text-xs text-gray-600 mb-2 whitespace-pre-wrap break-words">
                    {task.description}
                </div>
            )}

            {(task.managerName || task.creatorName) && (
                <div className="text-[10px] text-gray-500 mb-2 flex items-center gap-1">
                    <User className="w-3 h-3" />
                    <span>Vadovas: {formatDisplayName(task.managerName || task.creatorName)}</span>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2 mb-2 text-[10px] text-gray-500">
                <div className="bg-gray-100 px-1.5 py-0.5 rounded flex items-center gap-1">
                    <User className="w-3 h-3" />
                    <span className="font-medium">{formatDisplayName(userName)}</span>
                </div>
                <div className="bg-gray-100 px-1.5 py-0.5 rounded font-mono">
                    {editingTime ? (
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <input type="number" min="0" max="99" value={editHours} onChange={(e) => setEditHours(parseInt(e.target.value) || 0)} className="w-10 px-1 py-0.5 border rounded text-center text-[10px]" />h
                            <input type="number" min="0" max="59" value={editMins} onChange={(e) => setEditMins(parseInt(e.target.value) || 0)} className="w-10 px-1 py-0.5 border rounded text-center text-[10px]" />m
                            <button onClick={saveTimeEdit} className="px-1.5 py-0.5 text-[9px] bg-green-600 text-white rounded hover:bg-green-700">✓</button>
                            <button onClick={() => setEditingTime(false)} className="px-1.5 py-0.5 text-[9px] bg-gray-400 text-white rounded hover:bg-gray-500">✗</button>
                        </div>
                    ) : (
                        <span className="flex items-center gap-1">
                            {task.estimatedTime || '-'} / {calculateCurrentTotalMinutes(task) !== 0 ? formatMinutesToTimeString(calculateCurrentTotalMinutes(task)) : '-'}
                            {canEditTime && (
                                <button onClick={startTimeEdit} className="text-blue-500 hover:text-blue-700 ml-0.5" title="Keisti laiką">
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                </button>
                            )}
                        </span>
                    )}
                    {task.timeChanged && (
                        <span className="block text-red-600 font-bold text-[10px] uppercase tracking-wide mt-0.5">⚠ Pakeistas laikas</span>
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

            <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-100">
                <div className="flex items-center gap-2">
                    {(isManagerRole(userRole)) ? (
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={isConfirmed}
                                onChange={() => onToggleConfirm(task)}
                                disabled={task.archivedAt}
                                className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                            />
                            <span className={clsx("text-xs font-medium", isConfirmed ? "text-green-700" : "text-gray-600")}>
                                {isConfirmed ? "Patvirtinta" : "Nepatvirtinta"}
                            </span>
                        </label>
                    ) : (
                        <span className={clsx("text-xs font-medium", isConfirmed ? "text-green-700" : "text-gray-500")}>
                            {isConfirmed ? "Būsena: Patvirtinta" : "Būsena: Laukiama patvirtinimo"}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-1">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onRestore(task);
                        }}
                        className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                        title="Grąžinti"
                    >
                        <RotateCcw className="w-4 h-4" />
                    </button>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            setActiveModal({ type: 'comments', taskId: task.id, task: task });
                        }}
                        className="flex items-center gap-1 text-gray-500 hover:text-blue-600 p-1.5 hover:bg-gray-50 rounded"
                    >
                        <MessageSquare className="w-4 h-4" />
                        <span className="text-xs font-bold">{task.comments?.length || 0}</span>
                    </button>
                </div>
            </div>

            {task.comments && task.comments.length > 0 && (
                <div className="mt-2 bg-gray-50 rounded p-2 text-xs text-gray-600">
                    {task.comments.slice(-2).map((c, i) => (
                        <div key={i} className="mb-1 last:mb-0">
                            <span className="font-bold">{c.user}:</span> {c.text}
                        </div>
                    ))}
                    {task.comments.length > 2 && (
                        <div className="text-[10px] text-gray-400 italic mt-1">
                            + dar {task.comments.length - 2} komentarai...
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// Task List Helper Component
function TaskListTable({ tasks, title, viewMode, onToggleConfirm, onAddComment, onRestore, onTimeChange, users, userRole, currentUser, expandedTasks, toggleExpand, setActiveModal, highlight = false }) {
    const [editingTimeTaskId, setEditingTimeTaskId] = useState(null);
    const [editHours, setEditHours] = useState(0);
    const [editMins, setEditMins] = useState(0);
    const canEditTime = (userRole === 'admin');

    const startTimeEdit = (task) => {
        const totalMins = Math.round(calculateCurrentTotalMinutes(task));
        setEditHours(Math.floor(totalMins / 60));
        setEditMins(totalMins % 60);
        setEditingTimeTaskId(task.id);
    };

    const saveTimeEdit = (task) => {
        const newTotal = (editHours * 60) + editMins;
        onTimeChange(task, newTotal);
        setEditingTimeTaskId(null);
    };

    return (
        <div className={clsx("rounded-xl shadow-sm border border-gray-200 overflow-hidden mb-6", viewMode === 'mobile' ? "bg-transparent border-0 shadow-none" : "bg-white")}>
            <div className={clsx(
                "px-4 border-b border-gray-200",
                highlight ? "bg-blue-600 text-white py-6" : "py-3 bg-gray-50 text-gray-700",
                viewMode === 'mobile' && "rounded-lg mb-2 border"
            )}>
                <h3 className={clsx("font-bold transition-all", highlight ? "text-xl md:text-2xl" : "text-sm")}>{title} ({tasks.length})</h3>
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
                    <table className="w-full md:w-auto divide-y divide-gray-200 text-sm md:table-auto table-fixed">
                        <thead className="bg-gray-50">
                            <tr>
                                {(isManagerRole(userRole)) && <th className="px-2 py-2 text-center w-8 text-[10px] font-bold text-gray-500 uppercase tracking-wider">OK</th>}
                                <th className="px-2 py-2 md:px-2 md:py-1 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider min-w-[200px] md:w-auto">UŽDUOTIS</th>
                                <th className="px-1 py-2 md:px-2 md:py-1 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider w-16 md:w-auto">DARB.</th>
                                <th className="px-1 py-2 md:px-2 md:py-1 text-right text-[10px] font-bold text-gray-500 uppercase tracking-wider w-28 md:w-auto">PLAN. / TIKRAS</th>
                                <th className="px-1 py-2 md:px-2 md:py-1 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider w-24 md:w-auto">ATLIKTA</th>
                                <th className="px-1 py-2 md:px-2 md:py-1 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider w-16 md:w-auto">PRIO</th>
                                <th className="px-1 py-2 md:px-2 md:py-1 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider w-16 md:w-auto">BŪSENA</th>
                                <th className="px-1 py-2 md:px-2 md:py-1 text-center text-[10px] font-bold text-gray-500 uppercase tracking-wider w-10 md:w-auto">KOM.</th>
                                <th className="px-1 py-2 md:px-2 md:py-1 text-center text-[10px] font-bold text-gray-500 uppercase tracking-wider w-10 md:w-auto"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {tasks.length === 0 ? (
                                <tr>
                                    <td colSpan="7" className="px-6 py-8 text-center text-gray-500">
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
                                                isConfirmed ? "bg-gray-100" : "bg-white hover:bg-gray-50"
                                            )}
                                        >
                                            {(isManagerRole(userRole)) && (
                                                <td className="px-2 py-2 text-center">
                                                    <input
                                                        type="checkbox"
                                                        checked={isConfirmed}
                                                        onChange={() => onToggleConfirm(task)}
                                                        disabled={task.archivedAt}
                                                        className="w-3.5 h-3.5 rounded border-gray-300 text-green-600 focus:ring-green-500 cursor-pointer"
                                                    />
                                                </td>
                                            )}
                                            <td className="px-2 py-2" onClick={() => toggleExpand(task.id)}>
                                                <div className={clsx(
                                                    "text-sm font-bold text-gray-900 whitespace-normal break-words",
                                                    (task.isDeleted || task.status === 'deleted') && "line-through text-gray-500"
                                                )}>
                                                    {task.title}
                                                </div>
                                                {task.deadline && (
                                                    <div className="text-[9px] text-gray-500 flex items-center gap-1 mt-0.5 whitespace-nowrap">
                                                        <Calendar className="w-2.5 h-2.5" />
                                                        {task.deadline}
                                                    </div>
                                                )}
                                                <div className={clsx(
                                                    "text-[10px] text-gray-500 mt-0.5 flex items-start gap-1 cursor-pointer hover:text-gray-700 whitespace-normal break-words",
                                                    expandedTasks.has(task.id) ? "whitespace-pre-wrap" : ""
                                                )}>
                                                    <SessionTypeIcon
                                                        type={task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : 'task')}
                                                        className="w-3.5 h-3.5 flex-shrink-0 mt-0.5"
                                                    />
                                                    {task.description}
                                                </div>
                                                {expandedTasks.has(task.id) && task.comments && task.comments.length > 0 && (
                                                    <div className="mt-2 pl-4 border-l-2 border-gray-200">
                                                        <div className="text-[10px] font-semibold text-gray-500 mb-1">Komentarai:</div>
                                                        {task.comments.map((comment, idx) => (
                                                            <div key={idx} className="text-[10px] text-gray-600 mb-1">
                                                                <span className="font-medium">{comment.user}:</span> {comment.text}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                                {(task.managerName || task.creatorName) && (
                                                    <div className="text-[10px] text-gray-500 mt-1 flex items-center gap-1">
                                                        <User className="w-2.5 h-2.5" />
                                                        <span>Vadovas: {formatDisplayName(task.managerName || task.creatorName)}</span>
                                                    </div>
                                                )}
                                            </td>
                                            <td className="px-1 py-2 whitespace-nowrap">
                                                <span className="px-2 py-1 rounded-full text-[10px] font-medium bg-gray-100 text-gray-700 border border-gray-200">
                                                    {formatDisplayName(userName).split(' ')[0]}
                                                </span>
                                            </td>
                                            <td className="px-1 py-2 text-right text-gray-900 font-mono text-[10px] whitespace-nowrap">
                                                {editingTimeTaskId === task.id ? (
                                                    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                                                        <input type="number" min="0" max="99" value={editHours} onChange={(e) => setEditHours(parseInt(e.target.value) || 0)} className="w-10 px-1 py-0.5 border rounded text-center text-[10px]" autoFocus />h
                                                        <input type="number" min="0" max="59" value={editMins} onChange={(e) => setEditMins(parseInt(e.target.value) || 0)} className="w-10 px-1 py-0.5 border rounded text-center text-[10px]" />m
                                                        <button onClick={() => saveTimeEdit(task)} className="px-1.5 py-0.5 text-[9px] bg-green-600 text-white rounded hover:bg-green-700">✓</button>
                                                        <button onClick={() => setEditingTimeTaskId(null)} className="px-1.5 py-0.5 text-[9px] bg-gray-400 text-white rounded hover:bg-gray-500">✗</button>
                                                    </div>
                                                ) : (
                                                    <>
                                                        <span className="text-blue-600">{task.estimatedTime || '-'}</span>
                                                        <span className="text-gray-400 mx-1">/</span>
                                                        <span>{calculateCurrentTotalMinutes(task) !== 0 ? formatMinutesToTimeString(calculateCurrentTotalMinutes(task)) : '-'}</span>
                                                        {canEditTime && (
                                                            <button onClick={(e) => { e.stopPropagation(); startTimeEdit(task); }} className="text-blue-500 hover:text-blue-700 ml-1 inline-flex" title="Keisti laiką">
                                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                            </button>
                                                        )}
                                                    </>
                                                )}
                                                {task.timeChanged && (
                                                    <div className="text-red-600 font-bold text-[10px] uppercase tracking-wide mt-0.5">⚠ Pakeistas laikas</div>
                                                )}
                                            </td>
                                            <td className="px-1 py-2 whitespace-nowrap text-[10px] text-gray-600">
                                                {task.completedAt ? new Date(task.completedAt).toLocaleString('lt-LT', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}
                                            </td>
                                            <td className="px-1 py-2 whitespace-nowrap">
                                                <span
                                                    className={clsx(
                                                        "px-1.5 py-0.5 inline-flex text-[10px] leading-3 font-semibold rounded-md border border-black/5 uppercase"
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
                                                    <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800 border border-red-200">
                                                        Ištrinta
                                                    </span>
                                                ) : isConfirmed ? (
                                                    <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-800 border border-green-200">
                                                        Patvirt.
                                                    </span>
                                                ) : (
                                                    <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-800">
                                                        Nepatv.
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-1 py-2 text-center whitespace-nowrap">
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setActiveModal({ type: 'comments', taskId: task.id, task: task });
                                                    }}
                                                    className="inline-flex items-center justify-center text-gray-400 hover:text-blue-600 transition-colors p-1"
                                                    title="Komentarai"
                                                >
                                                    <MessageSquare className="w-4 h-4" />
                                                    {task.comments?.length > 0 && (
                                                        <span className="ml-0.5 text-[10px] font-bold">{task.comments.length}</span>
                                                    )}
                                                </button>
                                            </td>
                                            <td className="px-1 py-2 text-center whitespace-nowrap">
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onRestore(task);
                                                    }}
                                                    className="p-1 text-blue-600 hover:bg-blue-50 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                                                    title="Grąžinti"
                                                >
                                                    <RotateCcw className="w-3.5 h-3.5" />
                                                </button>
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
