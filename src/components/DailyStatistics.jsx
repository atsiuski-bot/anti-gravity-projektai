import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, getDoc, orderBy, updateDoc } from 'firebase/firestore';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { formatDisplayName } from '../utils/formatters';
import { Calendar, Clock, Coffee, User, Briefcase, ChevronLeft, ChevronRight } from 'lucide-react';
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

    // Sum from actualTime in tasks (including manual entries)
    const totalTaskActualMinutes = finishedTasks.reduce((acc, t) => {
        const mins = t.actualTime ? (t.timerMinutes || 0) + (t.manualMinutes || 0) : 0;
        return acc + mins;
    }, 0);

    // Find earliest start and latest end
    const firstSession = sessions.length > 0 ? sessions[0].startTime : null;
    const lastSession = sessions.length > 0 ? sessions[sessions.length - 1].endTime : null;

    // Helper to format ISO time to HH:MM
    const formatTime = (isoString) => {
        if (!isoString) return '-';
        return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    // Group sessions by worker for Team mode
    const workerSummaries = selectedUserId === 'all' ? sessions.reduce((acc, s) => {
        if (!acc[s.workerId]) {
            const worker = users.find(u => u.id === s.workerId);
            const rawName = worker ? (worker.displayName || worker.email) : (s.workerName || 'Nežinomas');
            const displayName = formatDisplayName(rawName);

            acc[s.workerId] = {
                name: displayName,
                earliestStart: s.startTime,
                latestEnd: s.endTime,
                taskTimeMinutes: 0,
                breakMinutes: dailyStats?.[s.workerId]?.breakMinutes || 0
            };
        }
        acc[s.workerId].taskTimeMinutes += (s.durationMinutes || 0);
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
                            {users.map(u => (
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
                            {firstSession ? formatTime(firstSession) : '--:--'} - {lastSession ? formatTime(lastSession) : '--:--'}
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
                        {formatMinutesToTimeString(totalTimerMinutes)}
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

                {sessions.length === 0 ? (
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
                                        {formatMinutesToTimeString(totalTimerMinutes)}
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
                                {sessions.map((session) => (
                                    <tr key={session.id} className="hover:bg-gray-50">
                                        <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                                            {formatTime(session.startTime)} - {formatTime(session.endTime)}
                                        </td>
                                        <td className="px-4 py-3 text-gray-900 font-medium">
                                            {session.taskTitle}
                                        </td>
                                        <td className="px-4 py-3 text-right text-gray-900 font-mono">
                                            {session.durationMinutes?.toFixed(1)}m
                                        </td>
                                    </tr>
                                ))}
                                <tr className="bg-gray-50 font-semibold">
                                    <td colSpan="2" className="px-4 py-3 text-right text-gray-900">
                                        Viso (Timer):
                                    </td>
                                    <td className="px-4 py-3 text-right text-indigo-600">
                                        {formatMinutesToTimeString(totalTimerMinutes)}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

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
                                            <td className="px-3 py-3">
                                                <div className="text-sm font-medium text-gray-900 truncate">
                                                    {task.title}
                                                </div>
                                                {task.description && (
                                                    <div className="text-xs text-gray-500 line-clamp-1 mt-0.5 flex items-center gap-1">
                                                        <Briefcase className="w-3 h-3 flex-shrink-0" />
                                                        {task.description}
                                                    </div>
                                                )}
                                            </td>
                                            <td className="px-2 py-3 whitespace-nowrap">
                                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-800 border border-gray-200 truncate max-w-[80px] inline-block">
                                                    {formatDisplayName(workerName).split(' ')[0]}
                                                </span>
                                            </td>
                                            <td className="px-2 py-3 whitespace-nowrap">
                                                <span className={clsx(
                                                    "px-1.5 py-0.5 inline-flex text-[10px] leading-4 font-semibold rounded-md",
                                                    task.priority === 'Urgent' ? 'bg-yellow-50 text-black border border-yellow-200' :
                                                        task.priority === 'High' ? 'bg-gray-200 text-gray-800' :
                                                            task.priority === 'Medium' ? 'bg-gray-500 text-white' :
                                                                'bg-gray-800 text-white'
                                                )}>
                                                    {task.priority || 'Medium'}
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
                                                {task.actualTime || '-'}
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
