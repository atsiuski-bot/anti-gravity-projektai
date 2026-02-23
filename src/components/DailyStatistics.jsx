import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, getDoc, orderBy, updateDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { formatMinutesToTimeString, getLithuanianDateString, getLithuanianWeekday, getLithuanian3AMCutoff, calculateCurrentTotalMinutes } from '../utils/timeUtils';
import { formatDisplayName, formatTime } from '../utils/formatters';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import { Calendar, Clock, Coffee, User, Briefcase, ChevronLeft, ChevronRight, Zap, Phone, MessageSquare, Check, Filter, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { CommentsModal } from './TaskDetailsModals';
import TaskHistory from './TaskHistory';
import SessionTypeIcon from './SessionTypeIcon';

export default function DailyStatistics({ currentUser, userRole, users = [] }) {
    // Managers can see everyone, Workers only themselves
    // Managers can see everyone, Workers only themselves
    const [selectedUserId, setSelectedUserId] = useState((userRole === 'manager' || userRole === 'admin') ? 'all' : currentUser?.uid);
    const [selectedDate, setSelectedDate] = useState(getLithuanianDateString());
    const [loading, setLoading] = useState(false);

    // Data states
    const [dailyStats, setDailyStats] = useState(null); // From daily_stats collection (legacy/ref for other stats if any)
    const [breakSessions, setBreakSessions] = useState([]); // from break_sessions collection
    const [sessions, setSessions] = useState([]); // From work_sessions collection
    const [scheduledTasks, setScheduledTasks] = useState([]); // Tasks planned for this weekday
    const [finishedTasks, setFinishedTasks] = useState([]); // Tasks finished on this specific date
    const [allDeletedTasks, setAllDeletedTasks] = useState([]); // Keep track of all deleted tasks for timeline lookup

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

        const breaksQ = selectedUserId === 'all'
            ? query(collection(db, 'break_sessions'),
                where('startTime', '>=', startOfDay),
                where('startTime', '<=', endOfDay),
                orderBy('startTime', 'asc'))
            : query(collection(db, 'break_sessions'),
                where('userId', '==', selectedUserId),
                where('startTime', '>=', startOfDay),
                where('startTime', '<=', endOfDay),
                orderBy('startTime', 'asc'));

        const unsubBreaks = onSnapshot(breaksQ, (snap) => {
            setBreakSessions(snap.docs.map(d => ({ id: d.id, ...d.data() })));
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
        let sessionsQ;
        if (selectedUserId === 'all') {
            sessionsQ = query(sessionsBaseQ, where('date', '==', selectedDate), orderBy('startTime', 'asc'));
        } else {
            sessionsQ = query(sessionsBaseQ, where('workerId', '==', selectedUserId), where('date', '==', selectedDate), orderBy('startTime', 'asc'));
        }

        const unsubSessions = onSnapshot(sessionsQ, (snap) => {
            const sessionsData = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(session => !session.isDeleted);
            setSessions(sessionsData);
        }, (error) => {
            console.error("Error fetching sessions:", error);
            setLoading(false);
        });

        // 3. Listen to Tasks (Active & Archived)
        let activeQ, archivedQ;
        if (selectedUserId === 'all') {
            activeQ = collection(db, 'tasks');
            archivedQ = collection(db, 'archived_tasks');
        } else {
            activeQ = query(collection(db, 'tasks'), where('assignedWorkerId', '==', selectedUserId));
            archivedQ = query(collection(db, 'archived_tasks'), where('assignedWorkerId', '==', selectedUserId));
        }

        let activeTasks = [];
        let archivedTasks = [];
        let deletedTasks = [];

        const updateAggregatedTasks = () => {
            // deduplicate tasks by ID to avoid duplicate key warnings
            const taskMap = new Map();
            [...activeTasks, ...archivedTasks, ...deletedTasks].forEach(t => {
                if (t.id) taskMap.set(t.id, t);
            });
            const allRelevantTasks = Array.from(taskMap.values());

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
        let deletedQ;
        if (selectedUserId === 'all') {
            deletedQ = collection(db, 'deleted_tasks');
        } else {
            deletedQ = query(collection(db, 'deleted_tasks'), where('assignedWorkerId', '==', selectedUserId));
        }

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

    // Filter out session records that are duplicates of manual tasks (Calls and Quick Work from legacy logging)
    const validSessions = useMemo(() => sessions.filter(s => !s.isSystemTask && !s.isQuickWork), [sessions]);

    // Aggregations
    const totalTimerMinutes = validSessions.reduce((acc, s) => acc + (s.durationMinutes || 0), 0);
    const totalBreakMinutes = breakSessions.reduce((acc, s) => acc + (s.durationMinutes || 0), 0);

    // Filter tasks that have manual minutes (Quick Work, Calls, or Manual Logs)
    // AND belong to the selected date's work day (3AM - 3AM)
    const manualTasks = useMemo(() => {
        const cutoff = get3AMCutoff();
        const nextDayCutoff = new Date(cutoff.getTime() + 24 * 60 * 60 * 1000);

        return finishedTasks.filter(t => {
            if (!t.manualMinutes || t.manualMinutes <= 0) return false;

            // Exclude updatedAt here as well
            const dateStr = t.completedAt || t.deletedAt || t.confirmedAt;
            if (!dateStr) return false;

            const finishedDate = new Date(dateStr);
            return finishedDate >= cutoff && finishedDate < nextDayCutoff;
        });
    }, [finishedTasks, selectedDate]);

    const totalManualMinutes = manualTasks.reduce((acc, t) => acc + (t.manualMinutes || 0), 0);

    // Sum from actualTime in tasks (including manual entries)
    // We strictly use calculated values now to ensure consistency
    const totalWorkedMinutes = totalTimerMinutes + totalManualMinutes;



    // Merge sessions and manual tasks for Timeline
    const combinedTimelineItems = useMemo(() => {
        const items = validSessions.map(s => {
            // Check if this session belongs to a deleted task
            const deletedTask = finishedTasks.find(t => t.id === s.taskId && t.isDeleted);
            let title = s.taskTitle;
            if (deletedTask) {
                title = `Deleted task: ${deletedTask.title}`;
            }

            return {
                id: s.id,
                type: 'session',
                startTime: s.startTime,
                endTime: s.endTime,
                title: title,
                duration: s.durationMinutes,
                workerId: s.workerId,
                workerName: s.workerName
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
                workerId: t.assignedWorkerId,
                workerName: t.assignedWorkerName,
                isSystemTask: t.isSystemTask,
                isQuickWork: t.isQuickWork
            });
        });

        // Sort by start time
        return items.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    }, [validSessions, manualTasks]);


    // Find earliest start and latest end from COMBINED items
    const firstActivity = combinedTimelineItems.length > 0 ? combinedTimelineItems[0].startTime : null;
    const lastActivity = combinedTimelineItems.length > 0 ? combinedTimelineItems[combinedTimelineItems.length - 1].endTime : null;


    // Group sessions by worker for Team mode
    const workerSummaries = selectedUserId === 'all' ? combinedTimelineItems.reduce((acc, s) => {
        if (!acc[s.workerId]) {
            const worker = users.find(u => u.id === s.workerId);
            const rawName = worker ? (worker.displayName || worker.email) : (s.workerName || 'Nežinomas');
            const displayName = formatDisplayName(rawName);

            acc[s.workerId] = {
                name: displayName,
                earliestStart: s.startTime,
                latestEnd: s.endTime,
                taskTimeMinutes: 0,
                breakMinutes: 0,
                // We'll sum breaks later
            };
        }
        acc[s.workerId].taskTimeMinutes += (s.duration || 0);
        if (s.startTime < acc[s.workerId].earliestStart) acc[s.workerId].earliestStart = s.startTime;
        if (s.endTime > acc[s.workerId].latestEnd) acc[s.workerId].latestEnd = s.endTime;

        return acc;
    }, {}) : null;

    // Helper to add breaks to worker summaries in 'all' view
    if (selectedUserId === 'all' && workerSummaries) {
        breakSessions.forEach(brk => {
            // brk has userId, we need to associate it
            const uid = brk.userId;
            if (!workerSummaries[uid]) {
                // If worker has NO work sessions but has breaks, we should probably still show them?
                // Or just skip. Usually they have work.
                // Let's create entry if missing to be safe
                const worker = users.find(u => u.id === uid);
                const rawName = worker ? (worker.displayName || worker.email) : (brk.userName || 'Nežinomas');
                workerSummaries[uid] = {
                    name: formatDisplayName(rawName),
                    earliestStart: null, // No work start
                    latestEnd: null,
                    taskTimeMinutes: 0,
                    breakMinutes: 0
                };
            }
            workerSummaries[uid].breakMinutes += (brk.durationMinutes || 0);
        });
    }

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
            // Also check if it might be a deleted task? (User probably shouldn't comment on deleted tasks, but finishedTasks usually are active/archived)

            const taskRef = doc(db, collectionName, task.id);

            await updateDoc(taskRef, {
                comments: updatedComments,
                updatedAt: new Date().toISOString()
            });

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

                {(userRole === 'manager' || userRole === 'admin') && users.length > 0 && (
                    <div className="relative">
                        <select
                            value={selectedUserId}
                            onChange={(e) => setSelectedUserId(e.target.value)}
                            className="pl-9 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm bg-white min-w-[200px]"
                        >
                            <option value="all">Už visą komandą</option>
                            {users.filter(u => !u.isDisabled).map(u => (
                                <option key={u.id} value={u.id}>
                                    {u.displayName || u.email}
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
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {workerList.map(([workerId, summary]) => (
                                    <tr key={workerId} className="hover:bg-gray-50">
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
                                {combinedTimelineItems.map((item) => (
                                    <tr key={item.id} className={clsx("hover:bg-gray-50", item.type === 'task' ? 'bg-blue-50/30' : '')}>
                                        <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                                            {formatTime(item.startTime)} - {formatTime(item.endTime)}
                                        </td>
                                        <td className="px-4 py-3 text-gray-900 font-medium flex items-center gap-2 text-xs">
                                            <SessionTypeIcon
                                                type={item.isSystemTask ? 'call' : (item.isQuickWork ? 'quick_work' : 'task')}
                                                className="w-4 h-4"
                                            />
                                            {item.title}
                                        </td>
                                        <td className="px-4 py-3 text-right text-gray-900 font-mono">
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

            {/* Breaks Timeline */}
            {(selectedUserId !== 'all' && breakSessions.length > 0) && (
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200 bg-gray-50 text-gray-900">
                        <h3 className="font-semibold">Pertraukos ({breakSessions.length})</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full md:w-auto divide-y divide-gray-200 text-sm">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-left font-medium text-gray-500 w-24">Laikas</th>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-left font-medium text-gray-500">Aprašymas</th>
                                    <th className="px-4 py-3 md:px-2 md:py-2 text-right font-medium text-gray-500 w-32">Trukmė</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {breakSessions.sort((a, b) => new Date(a.startTime) - new Date(b.startTime)).map((brk, idx) => (
                                    <tr key={brk.id || idx} className="hover:bg-gray-50">
                                        <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                                            {formatTime(brk.startTime)} - {formatTime(brk.endTime)}
                                        </td>
                                        <td className="px-4 py-3 text-gray-900 font-medium flex items-center gap-2">
                                            <SessionTypeIcon type="break" className="w-4 h-4" />
                                            Pertrauka #{idx + 1}
                                        </td>
                                        <td className="px-4 py-3 text-right text-amber-600 font-mono">
                                            {formatMinutesToTimeString(brk.durationMinutes)}
                                        </td>
                                    </tr>
                                ))}
                                <tr className="bg-gray-50 font-semibold">
                                    <td colSpan="2" className="px-4 py-3 text-right text-gray-900">
                                        Viso pertraukų:
                                    </td>
                                    <td className="px-4 py-3 text-right text-amber-600">
                                        {formatMinutesToTimeString(totalBreakMinutes)}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

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
                    users={users}
                    userRole={userRole}
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
                    users={users}
                    userRole={userRole}
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
function MobileStatsCard({ task, onToggleConfirm, onAddComment, onRestore, users, userRole, setActiveModal }) {
    const isConfirmed = task.status === 'confirmed';
    const worker = users.find(u => u.id === task.assignedWorkerId);
    const workerName = worker ? (worker.displayName || worker.email) : (task.assignedWorkerName || '—');

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
                    <span className="font-medium">{formatDisplayName(workerName)}</span>
                </div>
                <div className="bg-gray-100 px-1.5 py-0.5 rounded font-mono">
                    {task.estimatedTime || '-'} / {calculateCurrentTotalMinutes(task) > 0 ? formatMinutesToTimeString(calculateCurrentTotalMinutes(task)) : '-'}
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
                    {(userRole === 'manager' || userRole === 'admin') ? (
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
function TaskListTable({ tasks, title, viewMode, onToggleConfirm, onAddComment, onRestore, users, userRole, expandedTasks, toggleExpand, setActiveModal, highlight = false }) {
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
                            users={users}
                            userRole={userRole}
                            setActiveModal={setActiveModal}
                        />
                    ))}
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full md:w-auto divide-y divide-gray-200 text-sm md:table-auto table-fixed">
                        <thead className="bg-gray-50">
                            <tr>
                                {(userRole === 'manager' || userRole === 'admin') && <th className="px-2 py-2 text-center w-8 text-[10px] font-bold text-gray-500 uppercase tracking-wider">OK</th>}
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
                                    const worker = users.find(u => u.id === task.assignedWorkerId);
                                    const workerName = worker ? (worker.displayName || worker.email) : (task.assignedWorkerName || '—');

                                    return (
                                        <tr
                                            key={task.id}
                                            className={clsx(
                                                "group transition-colors",
                                                isConfirmed ? "bg-gray-100" : "bg-white hover:bg-gray-50"
                                            )}
                                        >
                                            {(userRole === 'manager' || userRole === 'admin') && (
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
                                                {task.description && (
                                                    <div className={clsx(
                                                        "text-[10px] text-gray-500 mt-0.5 flex items-start gap-1 cursor-pointer hover:text-gray-700 whitespace-normal break-words",
                                                        expandedTasks.has(task.id) ? "whitespace-pre-wrap" : ""
                                                    )}>
                                                        <Briefcase className="w-3 h-3 text-gray-400 flex-shrink-0 mt-0.5" />
                                                        {task.description}
                                                    </div>
                                                )}
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
                                                    {formatDisplayName(workerName).split(' ')[0]}
                                                </span>
                                            </td>
                                            <td className="px-1 py-2 text-right text-gray-900 font-mono text-[10px] whitespace-nowrap">
                                                <span className="text-blue-600">{task.estimatedTime || '-'}</span>
                                                <span className="text-gray-400 mx-1">/</span>
                                                <span>{calculateCurrentTotalMinutes(task) > 0 ? formatMinutesToTimeString(calculateCurrentTotalMinutes(task)) : '-'}</span>
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
