import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, orderBy } from 'firebase/firestore';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { formatDisplayName } from '../utils/formatters';
import { BarChart, Calendar, Filter, Download, ChevronDown, ChevronUp, Clock, Tag } from 'lucide-react';

export default function Reports({ users }) {
    const [activeTab, setActiveTab] = useState('hours'); // 'hours' | 'tasks'
    const [loading, setLoading] = useState(false);

    // --- HOURS REPORT STATE ---
    const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7)); // YYYY-MM
    const [workData, setWorkData] = useState([]); // Array of { userId, name, totalMinutes, days: { date: minutes } }
    const [expandedUser, setExpandedUser] = useState(null);

    // --- TASKS REPORT STATE ---
    const [taskFilters, setTaskFilters] = useState({
        userId: 'all',
        tag: 'all',
        startDate: new Date(new Date().setDate(new Date().getDate() - 30)).toISOString().split('T')[0],
        endDate: new Date().toISOString().split('T')[0],
    });
    const [filteredTasks, setFilteredTasks] = useState([]);
    const [taskSort, setTaskSort] = useState('date_desc'); // date_desc, date_asc, time_desc, time_asc

    // Fetch Work Hours Data
    useEffect(() => {
        if (activeTab === 'hours') {
            fetchWorkHours();
        }
    }, [activeTab, selectedMonth]);

    // Fetch Tasks Data
    useEffect(() => {
        if (activeTab === 'tasks') {
            fetchTasks();
        }
    }, [activeTab, taskFilters]); // Refetch when filters change

    const fetchWorkHours = async () => {
        setLoading(true);
        try {
            // Firestore textual date search for "YYYY-MM" prefix (simple approach for yyyy-mm-dd dates)
            // Ideally we'd use range: where('date', '>=', `${selectedMonth}-01`), where('date', '<=', `${selectedMonth}-31`)
            const startStr = `${selectedMonth}-01`;
            const endStr = `${selectedMonth}-31`;

            const q = query(
                collection(db, 'work_sessions'),
                where('date', '>=', startStr),
                where('date', '<=', endStr)
            );

            const snapshot = await getDocs(q);
            const sessions = snapshot.docs.map(d => d.data());

            // Aggregation
            const userMap = {};
            sessions.forEach(session => {
                const uid = session.workerId;
                if (!userMap[uid]) {
                    const u = users.find(user => user.id === uid);
                    userMap[uid] = {
                        userId: uid,
                        name: u ? (u.displayName || u.email) : (session.workerName || 'Unknown'),
                        totalMinutes: 0,
                        days: {}
                    };
                }

                userMap[uid].totalMinutes += (session.durationMinutes || 0);

                if (!userMap[uid].days[session.date]) {
                    userMap[uid].days[session.date] = 0;
                }
                userMap[uid].days[session.date] += (session.durationMinutes || 0);
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
            // We need to fetch from both 'tasks' (active) and 'archived_tasks' to get a complete history
            // NOTE: Firestore OR queries are limited. We'll fetch broadly by date range and filter in memory if needed
            // or fetch separately.

            // For simplicity and performance, let's fetch based on date range from Archive mainly,
            // as 'Active' tasks are usually recent/not finished. But "Done" tasks can be in 'tasks' too.

            // Query 1: Archived
            const archivedQ = query(
                collection(db, 'archived_tasks'),
                where('archivedAt', '>=', new Date(taskFilters.startDate).toISOString()), // Approximate check
                // where('archivedAt', '<=', new Date(taskFilters.endDate).toISOString()) // Firestore requires strictly 1 field for range usually
            );

            // Query 2: Active (Checking 'completedAt' or 'updatedAt')
            const activeQ = query(
                collection(db, 'tasks'),
                where('updatedAt', '>=', new Date(taskFilters.startDate).toISOString())
            );

            const [archivedSnap, activeSnap] = await Promise.all([
                getDocs(archivedQ),
                getDocs(activeQ)
            ]);

            let allTasks = [
                ...archivedSnap.docs.map(d => ({ ...d.data(), id: d.id, isArchived: true })),
                ...activeSnap.docs.map(d => ({ ...d.data(), id: d.id, isArchived: false }))
            ];

            // Client-side filtering for robust "Tag" and "User" and precise "Date" logic
            const start = new Date(taskFilters.startDate);
            const end = new Date(taskFilters.endDate);
            end.setHours(23, 59, 59); // End of day

            allTasks = allTasks.filter(t => {
                // 1. Status Filter (Show only completed/confirmed stuff? User said "Done tasks")
                const isDone = t.status === 'completed' || t.status === 'confirmed';
                if (!isDone) return false;

                // 2. Date Filter
                // Use completedAt or archivedAt or updatedAt
                const dateStr = t.completedAt || t.archivedAt || t.updatedAt;
                if (!dateStr) return false;
                const d = new Date(dateStr);
                if (d < start || d > end) return false;

                // 3. User Filter
                if (taskFilters.userId !== 'all' && t.assignedWorkerId !== taskFilters.userId) return false;

                // 4. Tag Filter (Tasks often have 'tag' string field)
                if (taskFilters.tag !== 'all' && t.tag !== taskFilters.tag) return false;

                return true;
            });

            // Sorting
            allTasks.sort((a, b) => {
                const dateA = new Date(a.completedAt || a.updatedAt).getTime();
                const dateB = new Date(b.completedAt || b.updatedAt).getTime();
                const timeA = (a.actualTime ? parseFloat(a.actualTime) : 0) || (a.durationMinutes || 0); // Normalized time check needed?
                // Assuming 'actualTime' is string "1h 30m" and we want to sort by it? 
                // Or maybe we have 'timerMinutes' stored. Let's use 'timerMinutes' if available or parse 'actualTime'
                const valA = a.timerMinutes || 0;
                const valB = b.timerMinutes || 0;

                switch (taskSort) {
                    case 'date_asc': return dateA - dateB;
                    case 'date_desc': return dateB - dateA;
                    case 'time_desc': return valB - valA;
                    case 'time_asc': return valA - valB;
                    default: return 0;
                }
            });

            setFilteredTasks(allTasks);

        } catch (error) {
            console.error("Error fetching tasks:", error);
        } finally {
            setLoading(false);
        }
    };

    // Calculate daily average for a user
    const getAvg = (totalMins, daysObj) => {
        const daysCount = Object.keys(daysObj).length;
        if (daysCount === 0) return 0;
        return Math.round(totalMins / daysCount);
    };

    return (
        <div className="space-y-6">
            <h2 className="text-xl font-bold text-gray-900">Ataskaitos ir Duomenys</h2>

            {/* TABS */}
            <div className="flex border-b border-gray-200">
                <button
                    onClick={() => setActiveTab('hours')}
                    className={`px-4 py-2 font-medium text-sm transition-colors border-b-2 ${activeTab === 'hours' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}
                >
                    Darbo Valandos
                </button>
                <button
                    onClick={() => setActiveTab('tasks')}
                    className={`px-4 py-2 font-medium text-sm transition-colors border-b-2 ${activeTab === 'tasks' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}
                >
                    Užduočių Analizė
                </button>
            </div>

            {/* --- HOURS TAB CONTENT --- */}
            {activeTab === 'hours' && (
                <div className="space-y-4">
                    {/* Controls */}
                    <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 flex flex-wrap gap-4 items-center">
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 mb-1">Pasirinkite mėnesį</label>
                            <input
                                type="month"
                                value={selectedMonth}
                                onChange={(e) => setSelectedMonth(e.target.value)}
                                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                            />
                        </div>
                    </div>

                    {/* Report Table */}
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Darbuotojas</th>
                                    <th className="px-6 py-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wider">Viso Valandų (Mėn)</th>
                                    <th className="px-6 py-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wider">Dirbta Dienų</th>
                                    <th className="px-6 py-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wider">Vidut. / Diena</th>
                                    <th className="px-6 py-3 w-10"></th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {loading && (
                                    <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-500">Kraunami duomenys...</td></tr>
                                )}
                                {!loading && workData.length === 0 && (
                                    <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-500">Nėra duomenų šiam mėnesiui.</td></tr>
                                )}
                                {workData.map((userStats) => (
                                    <React.Fragment key={userStats.userId}>
                                        <tr
                                            className={`hover:bg-gray-50 cursor-pointer transition-colors ${expandedUser === userStats.userId ? 'bg-blue-50' : ''}`}
                                            onClick={() => setExpandedUser(expandedUser === userStats.userId ? null : userStats.userId)}
                                        >
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                                {formatDisplayName(userStats.name)}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-blue-600 font-bold">
                                                {formatMinutesToTimeString(userStats.totalMinutes)}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-600">
                                                {Object.keys(userStats.days).length} d.
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                                                {formatMinutesToTimeString(getAvg(userStats.totalMinutes, userStats.days))}
                                            </td>
                                            <td className="px-6 py-4 text-right text-gray-400">
                                                {expandedUser === userStats.userId ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                            </td>
                                        </tr>
                                        {expandedUser === userStats.userId && (
                                            <tr className="bg-gray-50/50">
                                                <td colSpan="5" className="px-6 py-4">
                                                    <div className="bg-white border rounded-lg p-4">
                                                        <h4 className="text-sm font-bold text-gray-700 mb-3">Dienos Išklotinė</h4>
                                                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                                                            {Object.entries(userStats.days)
                                                                .sort((a, b) => new Date(a[0]) - new Date(b[0]))
                                                                .map(([date, mins]) => (
                                                                    <div key={date} className="border border-gray-200 rounded p-2 text-center hover:shadow-sm">
                                                                        <div className="text-xs text-gray-500 mb-1">{date}</div>
                                                                        <div className="font-mono text-sm font-semibold text-blue-600">
                                                                            {formatMinutesToTimeString(mins)}
                                                                        </div>
                                                                    </div>
                                                                ))
                                                            }
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* --- TASKS TAB CONTENT --- */}
            {activeTab === 'tasks' && (
                <div className="space-y-4">
                    {/* Controls */}
                    <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 mb-1">Nuo</label>
                            <input
                                type="date"
                                value={taskFilters.startDate}
                                onChange={(e) => setTaskFilters(prev => ({ ...prev, startDate: e.target.value }))}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 mb-1">Iki</label>
                            <input
                                type="date"
                                value={taskFilters.endDate}
                                onChange={(e) => setTaskFilters(prev => ({ ...prev, endDate: e.target.value }))}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 mb-1">Filtruoti pagal Žymą</label>
                            <select
                                value={taskFilters.tag}
                                onChange={(e) => setTaskFilters(prev => ({ ...prev, tag: e.target.value }))}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                            >
                                <option value="all">Visos Žymos</option>
                                {/* Hardcoded tags for now, ideally fetch unique list */}
                                <option value="Design">Design</option>
                                <option value="Development">Development</option>
                                <option value="Marketing">Marketing</option>
                                <option value="Other">Other</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 mb-1">Filtruoti pagal Darbuotoją</label>
                            <select
                                value={taskFilters.userId}
                                onChange={(e) => setTaskFilters(prev => ({ ...prev, userId: e.target.value }))}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                            >
                                <option value="all">Visi Darbuotojai</option>
                                {users.filter(u => !u.isDisabled).map(u => (
                                    <option key={u.id} value={u.id}>{formatDisplayName(u.displayName || u.email)}</option>
                                ))}
                            </select>
                        </div>
                        <div className="col-span-2 md:col-span-4 flex justify-end">
                            <select
                                value={taskSort}
                                onChange={(e) => setTaskSort(e.target.value)}
                                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50"
                            >
                                <option value="date_desc">Naujausi viršuje</option>
                                <option value="date_asc">Seniausi viršuje</option>
                                <option value="time_desc">Ilgiausiai trukę viršuje</option>
                                <option value="time_asc">Trumpiausiai trukę viršuje</option>
                            </select>
                        </div>
                    </div>

                    {/* Task List */}
                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Baigta</th>
                                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Užduotis</th>
                                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Žyma</th>
                                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Darbuotojas</th>
                                    <th className="px-4 py-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wider">Laikas</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {loading && (
                                    <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-500">Ieškoma užduočių...</td></tr>
                                )}
                                {!loading && filteredTasks.length === 0 && (
                                    <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-500">Nerasta užduočių pagal pasirinktus filtrus.</td></tr>
                                )}
                                {filteredTasks.map((task) => {
                                    const dateStr = task.completedAt || task.archivedAt || task.updatedAt;
                                    const worker = users.find(u => u.id === task.assignedWorkerId);
                                    const workerName = worker ? (worker.displayName || worker.email) : (task.assignedWorkerName || '-');

                                    return (
                                        <tr key={task.id} className="hover:bg-gray-50">
                                            <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">
                                                {dateStr ? new Date(dateStr).toISOString().split('T')[0] : '-'}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-gray-900 font-medium">
                                                {task.title}
                                                {task.isArchived && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] bg-gray-100 text-gray-500 border">ARCHYVE</span>}
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                {task.tag ? (
                                                    <span className="px-2 py-0.5 rounded text-xs bg-purple-50 text-purple-700 border border-purple-100">
                                                        {task.tag}
                                                    </span>
                                                ) : <span className="text-gray-400 text-xs">-</span>}
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-700">
                                                {formatDisplayName(workerName)}
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap text-right text-sm font-bold text-blue-600 font-mono">
                                                {formatMinutesToTimeString(task.timerMinutes || 0)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}
