import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, getDoc, orderBy, updateDoc } from 'firebase/firestore';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { formatDisplayName } from '../utils/formatters';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import { Calendar, Clock, Coffee, User, Briefcase, ChevronLeft, ChevronRight, Zap, Phone } from 'lucide-react';
import clsx from 'clsx';

export default function DailyStatistics({ currentUser, userRole, users = [] }) {
    // Managers can see everyone, Workers only themselves
    const [selectedUserId, setSelectedUserId] = useState(currentUser?.uid);
    const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
    const [loading, setLoading] = useState(false);

    // Data states
    const [dailyStats, setDailyStats] = useState(null); // From daily_stats collection
    const [sessions, setSessions] = useState([]); // From work_sessions collection
    const [scheduledTasks, setScheduledTasks] = useState([]); // Tasks planned for this weekday
    const [finishedTasks, setFinishedTasks] = useState([]); // Tasks finished on this specific date

    // Calculate previous/next day
    const handleDateChange = (offset) => {
        const date = new Date(selectedDate);
        date.setDate(date.getDate() + offset);
        setSelectedDate(date.toISOString().split('T')[0]);
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
        const daysMap = ['Sekmadienis', 'Pirmadienis', 'Antradienis', 'Trečiadienis', 'Ketvirtadienis', 'Penktadienis', 'Šeštadienis'];
        const weekday = daysMap[new Date(selectedDate).getDay()];

        // Clear previous data to avoid stale state
        setDailyStats(null);
        setSessions([]);
        setScheduledTasks([]);
        setFinishedTasks([]);


        // 1. Listen to Daily Stats (Breaks)
        let unsubStats;
        if (selectedUserId === 'all') {
            const statsQ = query(collection(db, 'daily_stats'), where('date', '==', selectedDate));
            unsubStats = onSnapshot(statsQ, (snap) => {
                const statsMap = {};
                snap.docs.forEach(d => {
                    const data = d.data();
                    const userId = d.id.split('_')[0]; // Document ID is userId_date
                    statsMap[userId] = data;
                });
                setDailyStats(statsMap);
            }, (error) => {
                console.error("Error fetching daily stats (all):", error);
                setLoading(false);
            });
        } else {
            const statsId = `${selectedUserId}_${selectedDate}`;
            unsubStats = onSnapshot(doc(db, 'daily_stats', statsId), (snap) => {
                setDailyStats(snap.exists() ? snap.data() : null);
            }, (error) => {
                console.error("Error fetching daily stats (single):", error);
                setLoading(false);
            });
        }

        // 2. Listen to Work Sessions
        const sessionsBaseQ = collection(db, 'work_sessions');
        let sessionsQ;
        if (selectedUserId === 'all') {
            sessionsQ = query(sessionsBaseQ, where('date', '==', selectedDate), orderBy('startTime', 'asc'));
        } else {
            sessionsQ = query(sessionsBaseQ, where('workerId', '==', selectedUserId), where('date', '==', selectedDate), orderBy('startTime', 'asc'));
        }

        const unsubSessions = onSnapshot(sessionsQ, (snap) => {
            setSessions(snap.docs.map(d => ({ id: d.id, ...d.data() })));
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

        const updateAggregatedTasks = () => {
            const allRelevantTasks = [...activeTasks, ...archivedTasks];

            // Filter for scheduled (planned for this weekday) - Only if single user? 
            // In Team mode, "Scheduled" might be confusing, user asked for "done tasks" specifically.
            const scheduled = allRelevantTasks.filter(t => t.dayOfWeek === weekday);
            setScheduledTasks(scheduled);

            // Filter for finished today
            const finishedToday = allRelevantTasks.filter(t => {
                const compDate = t.completedAt?.split('T')[0];
                const archDate = t.archivedAt?.split('T')[0];
                return compDate === selectedDate || archDate === selectedDate;
            });
            setFinishedTasks(finishedToday);
            setLoading(false);
        };

        const unsubActive = onSnapshot(activeQ, (snap) => {
            activeTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            activeTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            updateAggregatedTasks();
        }, (error) => {
            console.error("Error fetching active tasks:", error);
            setLoading(false);
        });

        const unsubArchived = onSnapshot(archivedQ, (snap) => {
            archivedTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            archivedTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            updateAggregatedTasks();
        }, (error) => {
            console.error("Error fetching archived tasks:", error);
            setLoading(false);
        });

        return () => {
            unsubStats();
            unsubSessions();
            unsubActive();
            unsubArchived();
        };
    }, [selectedUserId, selectedDate]);

    // Aggregations
    const totalTimerMinutes = sessions.reduce((acc, s) => acc + (s.durationMinutes || 0), 0);
    const totalBreakMinutes = selectedUserId === 'all'
        ? Object.values(dailyStats || {}).reduce((acc, s) => acc + (s.breakMinutes || 0), 0)
        : (dailyStats?.breakMinutes || 0);

    // Filter tasks that have manual minutes (Quick Work, Calls, or Manual Logs)
    const manualTasks = finishedTasks.filter(t => t.manualMinutes && t.manualMinutes > 0);
    const totalManualMinutes = manualTasks.reduce((acc, t) => acc + (t.manualMinutes || 0), 0);

    // Sum from actualTime in tasks (including manual entries)
    // We strictly use calculated values now to ensure consistency
    const totalWorkedMinutes = totalTimerMinutes + totalManualMinutes;

    // Helper to format ISO time to HH:MM
    const formatTime = (isoString) => {
        if (!isoString) return '-';
        return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    // Merge sessions and manual tasks for Timeline
    const combinedTimelineItems = useMemo(() => {
        const items = sessions.map(s => ({
            id: s.id,
            type: 'session',
            startTime: s.startTime,
            endTime: s.endTime,
            title: s.taskTitle,
            duration: s.durationMinutes,
            workerId: s.workerId,
            workerName: s.workerName
        }));

        manualTasks.forEach(t => {
            // For manual tasks, we infer start time from completedAt - duration
            // This is an approximation for visual timeline
            const end = new Date(t.completedAt);
            const start = new Date(end.getTime() - (t.manualMinutes * 60000));

            items.push({
                id: t.id,
                type: 'task',
                startTime: start.toISOString(),
                endTime: t.completedAt,
                title: t.title,
                duration: t.manualMinutes,
                workerId: t.assignedWorkerId,
                workerName: t.assignedWorkerName,
                isSystemTask: t.isSystemTask,
                isQuickWork: t.isQuickWork
            });
        });

        // Sort by start time
        return items.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    }, [sessions, manualTasks]);


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
                breakMinutes: dailyStats?.[s.workerId]?.breakMinutes || 0,
                breaks: dailyStats?.[s.workerId]?.breaks || []
            };
        }
        acc[s.workerId].taskTimeMinutes += (s.duration || 0);
        if (s.startTime < acc[s.workerId].earliestStart) acc[s.workerId].earliestStart = s.startTime;
        if (s.endTime > acc[s.workerId].latestEnd) acc[s.workerId].latestEnd = s.endTime;

        return acc;
    }, {}) : null;

    const workerList = workerSummaries ? Object.entries(workerSummaries) : [];

    const handleConfirmTask = async (task, isConfirmed) => {
        try {
            // Determine collection based on whether it's already archived
            // If it's today's task, it should be in 'tasks'
            // If it's an old task (viewing history), it might be in 'archived_tasks'
            const collectionName = task.archivedAt ? 'archived_tasks' : 'tasks';
            const status = isConfirmed ? 'confirmed' : 'completed';

            await updateDoc(doc(db, collectionName, task.id), {
                status: status,
                confirmedAt: isConfirmed ? new Date().toISOString() : null,
                confirmedBy: isConfirmed ? currentUser.uid : null,
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            console.error("Error confirming task:", err);
            alert("Klaida keičiant statusą: " + err.message);
        }
    };

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
                    <div className="flex items-center gap-3 mb-2 text-gray-500 text-sm font-medium">
                        <Briefcase className="w-4 h-4" />
                        Atliktos užduotys
                    </div>
                    <div className="text-2xl font-bold text-green-600">
                        {finishedTasks.length}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                        Užbaigta šią dieną
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
                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-4 py-3 text-left font-medium text-gray-500">Darbuotojas</th>
                                    <th className="px-4 py-3 text-center font-medium text-gray-500">Pradžia</th>
                                    <th className="px-4 py-3 text-center font-medium text-gray-500">Pabaiga</th>
                                    <th className="px-4 py-3 text-right font-medium text-gray-500">Pertraukos</th>
                                    <th className="px-4 py-3 text-right font-medium text-gray-500">Užduotims</th>
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
                                    <td className="px-4 py-3 text-right text-amber-700">
                                        {formatMinutesToTimeString(totalBreakMinutes)}
                                    </td>
                                    <td className="px-4 py-3 text-right text-indigo-700">
                                        {formatMinutesToTimeString(totalWorkedMinutes)}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                ) : (
                    /* INDIVIDUAL MODE TIMELINE TABLE */
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-4 py-3 text-left font-medium text-gray-500 w-24">Laikas</th>
                                    <th className="px-4 py-3 text-left font-medium text-gray-500">Užduotis</th>
                                    <th className="px-4 py-3 text-right font-medium text-gray-500 w-32">Trukmė</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {combinedTimelineItems.map((item) => (
                                    <tr key={item.id} className={clsx("hover:bg-gray-50", item.type === 'task' ? 'bg-blue-50/30' : '')}>
                                        <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                                            {formatTime(item.startTime)} - {formatTime(item.endTime)}
                                        </td>
                                        <td className="px-4 py-3 text-gray-900 font-medium flex items-center gap-2">
                                            {item.type === 'task' && item.isSystemTask && <Phone className="w-3 h-3 text-sky-500" />}
                                            {item.type === 'task' && item.isQuickWork && <Zap className="w-3 h-3 text-red-500" />}
                                            {item.title}
                                        </td>
                                        <td className="px-4 py-3 text-right text-gray-900 font-mono">
                                            {item.duration?.toFixed(1)}m
                                        </td>
                                    </tr>
                                ))}
                                <tr className="bg-gray-50 font-semibold">
                                    <td colSpan="2" className="px-4 py-3 text-right text-gray-900">
                                        Viso (Timer + Manual):
                                    </td>
                                    <td className="px-4 py-3 text-right text-indigo-600">
                                        {formatMinutesToTimeString(totalWorkedMinutes)}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Breaks Timeline */}
            {(selectedUserId !== 'all' && dailyStats?.breaks && dailyStats.breaks.length > 0) && (
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200 bg-gray-50 text-gray-900">
                        <h3 className="font-semibold">Pertraukos ({dailyStats.breaks.length})</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-4 py-3 text-left font-medium text-gray-500 w-24">Laikas</th>
                                    <th className="px-4 py-3 text-left font-medium text-gray-500">Aprašymas</th>
                                    <th className="px-4 py-3 text-right font-medium text-gray-500 w-32">Trukmė</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {dailyStats.breaks.sort((a, b) => new Date(a.startTime) - new Date(b.startTime)).map((brk, idx) => (
                                    <tr key={idx} className="hover:bg-gray-50">
                                        <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                                            {formatTime(brk.startTime)} - {formatTime(brk.endTime)}
                                        </td>
                                        <td className="px-4 py-3 text-gray-900 font-medium">
                                            Pertrauka #{idx + 1}
                                        </td>
                                        <td className="px-4 py-3 text-right text-amber-600 font-mono">
                                            {brk.durationMinutes?.toFixed(1)}m
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


            {/* Completed Tasks List for Confirmation */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200 bg-gray-50 text-gray-900">
                    <h3 className="font-semibold">Atliktos užduotys ({finishedTasks.length})</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-sm table-fixed">
                        <thead className="bg-gray-50">
                            <tr>
                                {(userRole === 'manager' || userRole === 'admin') && (
                                    <th className="px-4 py-3 text-center w-10">
                                        ✓
                                    </th>
                                )}
                                <th className="px-3 py-3 text-left font-medium text-gray-500 uppercase tracking-wider w-[35%]">Užduotis</th>
                                <th className="px-2 py-3 text-left font-medium text-gray-500 uppercase tracking-wider w-24">Darb.</th>
                                <th className="px-2 py-3 text-left font-medium text-gray-500 uppercase tracking-wider w-20">Prior.</th>
                                <th className="px-2 py-3 text-left font-medium text-gray-500 uppercase tracking-wider w-20">Būsena</th>
                                <th className="px-2 py-3 text-right font-medium text-gray-500 uppercase tracking-wider w-24">Laikas</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {finishedTasks.length === 0 ? (
                                <tr>
                                    <td colSpan="6" className="px-6 py-8 text-center text-gray-500">
                                        Nėra atliktų užduočių šiai dienai.
                                    </td>
                                </tr>
                            ) : (
                                finishedTasks.map((task) => {
                                    const isConfirmed = task.status === 'confirmed';
                                    const worker = users.find(u => u.id === task.assignedWorkerId);
                                    const workerName = worker ? (worker.displayName || worker.email) : (task.assignedWorkerName || '—');

                                    return (
                                        <tr
                                            key={task.id}
                                            className={clsx(
                                                "transition-colors",
                                                isConfirmed ? "bg-green-50" : "bg-white hover:bg-gray-50"
                                            )}
                                        >
                                            {(userRole === 'manager' || userRole === 'admin') && (
                                                <td className="px-4 py-3 text-center">
                                                    <input
                                                        type="checkbox"
                                                        checked={isConfirmed}
                                                        onChange={(e) => handleConfirmTask(task, e.target.checked)}
                                                        className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500 cursor-pointer"
                                                    />
                                                </td>
                                            )}
                                            <td className="px-3 py-3" onClick={() => toggleExpand(task.id)}>
                                                <div className="text-sm font-medium text-gray-900 truncate">
                                                    {task.title}
                                                </div>
                                                {task.estimatedTime && (
                                                    <div className="text-[10px] text-blue-600 font-medium mt-0.5">
                                                        Planuota: {task.estimatedTime}
                                                    </div>
                                                )}
                                                {task.deadline && (
                                                    <div className="text-[10px] text-gray-500 flex items-center gap-1 mt-0.5">
                                                        <Calendar className="w-3 h-3" />
                                                        {task.deadline}
                                                    </div>
                                                )}
                                                {task.description && (
                                                    <div className={clsx(
                                                        "text-xs text-gray-500 mt-0.5 flex items-start gap-1 cursor-pointer hover:text-gray-700",
                                                        expandedTasks.has(task.id) ? "whitespace-pre-wrap" : "line-clamp-1"
                                                    )}>
                                                        <Briefcase className="w-3 h-3 flex-shrink-0 mt-0.5" />
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
                                            </td>
                                            <td className="px-2 py-3 whitespace-nowrap">
                                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-800 border border-gray-200 truncate max-w-[80px] inline-block">
                                                    {formatDisplayName(workerName).split(' ')[0]}
                                                </span>
                                            </td>
                                            <td className="px-2 py-3 whitespace-nowrap">
                                                <span
                                                    className={clsx(
                                                        "px-1.5 py-0.5 inline-flex text-[10px] leading-4 font-semibold rounded-md border border-black/5"
                                                    )}
                                                    style={{
                                                        backgroundColor: getPriorityColor(task.priority),
                                                        color: getPriorityTextColor(task.priority)
                                                    }}
                                                >
                                                    {getPriorityLabel(task.priority)}
                                                </span>
                                            </td>
                                            <td className="px-2 py-3 whitespace-nowrap">
                                                {isConfirmed ? (
                                                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                                                        OK
                                                    </span>
                                                ) : (
                                                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">
                                                        Atlikta
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-2 py-3 text-right text-gray-900 font-mono text-xs">
                                                {task.actualTime || (task.manualMinutes ? `${task.manualMinutes.toFixed(1)}m` : '-')}
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Break log could be listed here if we stored individual breaks, 
                but we only stored total 'breakMinutes' in daily_stats for now. 
            */}
        </div>
    );
}
