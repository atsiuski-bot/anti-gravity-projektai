import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, orderBy, doc, updateDoc } from 'firebase/firestore';
import { formatMinutesToTimeString, getLithuanianDateString, getLithuanian3AMCutoff } from '../utils/timeUtils';
import { formatDisplayName, formatTime } from '../utils/formatters';
import { BarChart, Calendar, Filter, Download, ChevronDown, ChevronUp, Clock, Tag, Briefcase, MessageSquare, RotateCcw, Coffee } from 'lucide-react';



import DailyStatistics from './DailyStatistics';
import { CommentsModal } from './TaskDetailsModals';
import { useAuth } from '../context/AuthContext';
import { TASK_TAGS } from '../utils/taskUtils';

// Force rebuild
export default function Reports({ users }) {
    const { currentUser, userRole } = useAuth();
    const [activeTab, setActiveTab] = useState((userRole === 'manager' || userRole === 'admin') ? 'daily-stats' : 'hours');
    const [loading, setLoading] = useState(false);

    // --- HOURS REPORT STATE ---
    const [selectedMonth, setSelectedMonth] = useState(getLithuanianDateString().slice(0, 7)); // YYYY-MM
    const [workData, setWorkData] = useState([]); // Array of { userId, name, totalMinutes, days: { date: minutes } }
    const [expandedUser, setExpandedUser] = useState(null);

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
    }, [activeTab, taskFilters, taskSort]); // Refetch when filters or sort change

    const [expandedDays, setExpandedDays] = useState({}); // { userId: { dateString: boolean } }

    const toggleDayExpand = (userId, date) => {
        setExpandedDays(prev => ({
            ...prev,
            [userId]: {
                ...prev[userId],
                [date]: !prev[userId]?.[date]
            }
        }));
    };

    const fetchWorkHours = async () => {
        setLoading(true);
        try {
            let startStr = `${selectedMonth}-01`;
            // Special exception for January 2026: Start from 19th
            if (selectedMonth === '2026-01') {
                startStr = '2026-01-19';
            }
            const endStr = `${selectedMonth}-31`;

            // NOTE: We are fetching ALL data for the date range and filtering client-side
            // because adding 'where(workerId == ...)' with 'where(date >= ...)' requires a composite index
            // which we cannot easily create for the user right now.

            const workQ = query(
                collection(db, 'work_sessions'),
                where('date', '>=', startStr),
                where('date', '<=', endStr)
            );

            // break_sessions uses 'startTime' field, not 'date'
            // Query by startTime range (ISO datetime strings)
            const breakQ = query(
                collection(db, 'break_sessions'),
                where('startTime', '>=', `${startStr}T00:00:00`),
                where('startTime', '<=', `${endStr}T23:59:59`)
            );

            const [workSnap, breakSnap] = await Promise.all([
                getDocs(workQ),
                getDocs(breakQ)
            ]);

            const workSessions = workSnap.docs.map(d => ({ ...d.data(), id: d.id, _type: 'work' }));
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
                        days: {} // { date: { totalWork: 0, totalBreak: 0, sessions: [] } }
                    };
                }
            };

            const isManager = userRole === 'manager' || userRole === 'admin';

            // Helper to check for duplicates
            const isDuplicate = (existingSessions, newSession) => {
                return existingSessions.some(existing =>
                    existing.startTime === newSession.startTime &&
                    existing._type === newSession._type
                );
            };

            // Process Work
            workSessions.forEach(s => {
                const uid = s.workerId;
                if (!isManager && uid !== currentUser.uid) return;

                initUser(uid, s.workerName);

                if (!userMap[uid].days[s.date]) {
                    userMap[uid].days[s.date] = { totalWork: 0, totalBreak: 0, sessions: [] };
                }

                // Deduplicate work sessions
                if (isDuplicate(userMap[uid].days[s.date].sessions, s)) {
                    return;
                }

                userMap[uid].totalMinutes += (s.durationMinutes || 0);
                userMap[uid].days[s.date].totalWork += (s.durationMinutes || 0);
                userMap[uid].days[s.date].sessions.push(s);
            });

            // Process Breaks
            breakSessions.forEach(s => {
                const uid = s.userId;
                if (!isManager && uid !== currentUser.uid) return;

                // Only add breaks if user exists (or should we create? usually user has work too)
                // Let's create if missing to be safe
                if (!userMap[uid]) {
                    initUser(uid, s.userName);
                }

                if (!userMap[uid].days[s.date]) {
                    userMap[uid].days[s.date] = { totalWork: 0, totalBreak: 0, sessions: [] };
                }

                // Deduplicate break sessions
                if (isDuplicate(userMap[uid].days[s.date].sessions, s)) {
                    return;
                }

                userMap[uid].days[s.date].totalBreak += (s.durationMinutes || 0);
                userMap[uid].days[s.date].sessions.push(s);
            });

            // Post-process: Sort sessions by time for each day
            Object.values(userMap).forEach(user => {
                Object.values(user.days).forEach(dayData => {
                    dayData.sessions.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

                    if (dayData.sessions.length > 0) {
                        dayData.dayStart = dayData.sessions[0].startTime;
                        // Find the latest end time (usually the last session, but let's be safe if sorting is by start)
                        // Actually, sorting by start is enough if we assume no huge overlaps where an earlier task ends later than a later task.
                        // But for correctness, let's find the max end time.
                        const maxEnd = dayData.sessions.reduce((max, s) => {
                            return new Date(s.endTime) > new Date(max) ? s.endTime : max;
                        }, dayData.sessions[0].endTime);
                        dayData.dayEnd = maxEnd;
                    }
                });
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
            const isManager = userRole === 'manager' || userRole === 'admin';

            // Query 1: Archived - Respects date filter
            const archivedQ = query(
                collection(db, 'archived_tasks'),
                where('archivedAt', '>=', new Date(taskFilters.startDate).toISOString())
            );

            // Query 2: Active - Completed or Confirmed
            // We fetch ALL 'completed' (unconfirmed) tasks to ensure "Done Earlier" list is complete
            // And all recent tasks based on update time
            // NOTE: Client-side filtering handles the 'assignedWorkerId' check for non-managers

            const activeUnconfirmedQ = query(
                collection(db, 'tasks'),
                where('status', '==', 'completed')
            );

            // Also get confirmed ones that match date filter
            const activeRecentQ = query(
                collection(db, 'tasks'),
                where('updatedAt', '>=', new Date(taskFilters.startDate).toISOString())
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

                if (taskFilters.userId !== 'all' && t.assignedWorkerId !== taskFilters.userId) return false;
                if (taskFilters.tag !== 'all' && t.tag !== taskFilters.tag) return false;

                // Security: Force filter by user for non-managers
                if (!isManager && t.assignedWorkerId !== currentUser.uid) return false;

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

            // DEBUG: Log complete task data to see what fields deleted tasks have
            console.log('FULL TASK DATA (first 3):', sortedTasks.slice(0, 3).map(t => ({
                title: t.title,
                status: t.status,
                isDeleted: t.isDeleted,
                deletedAt: t.deletedAt,
                completed: t.completed,
                completedAt: t.completedAt,
                isArchived: t.isArchived
            })));

        } catch (error) {
            console.error("Error fetching tasks:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleToggleConfirm = async (task) => {
        try {
            if (task.isArchived) {
                alert("Negalima keisti archyvuotų užduočių būsenos.");
                return;
            }

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

            // Also update the activeModal task so the modal shows the new comment immediately
            setActiveModal(prev => ({
                ...prev,
                task: { ...prev.task, comments: updatedComments }
            }));

            // Determine collection based on archival status
            const collectionName = task.isArchived ? 'archived_tasks' : 'tasks';
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

    const handleRevert = async (task) => {
        // Check permissions: manager or the user who completed the task
        const isManager = userRole === 'manager' || userRole === 'admin';
        const isCompleter = task.completedBy === currentUser.uid;

        if (!isManager && !isCompleter) {
            alert("Neturite teisių grąžinti šios užduoties.");
            return;
        }

        if (!window.confirm('Ar norite grąžinti užduotį į aktyvių sąrašą?')) return;

        try {
            if (task.isArchived) {
                alert("Negalima grąžinti archyvuotos užduoties. Naudokite užduočių istoriją.");
                return;
            }

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

        } catch (error) {
            console.error("Error reverting task:", error);
            alert("Klaida grąžinant užduotį: " + error.message);
            fetchTasks(); // Refresh on error
        }
    };

    const get3AMCutoff = () => {
        return getLithuanian3AMCutoff(getLithuanianDateString());
    };

    const getAvg = (totalMins, daysObj) => {
        const daysCount = Object.keys(daysObj).length;
        if (daysCount === 0) return 0;
        return Math.round(totalMins / daysCount);
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
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden mb-6">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                <h3 className="text-sm font-bold text-gray-700">{title} ({tasks.length})</h3>
            </div>
            <table className="min-w-full divide-y divide-gray-200 table-fixed">
                <thead className="bg-gray-50">
                    <tr>
                        <th className="px-2 py-2 text-center w-8 text-[10px] font-bold text-gray-500 uppercase tracking-wider">OK</th>
                        <th className="px-2 py-2 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider">UŽDUOTIS</th>
                        <th className="px-1 py-2 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider w-12">DARB.</th>
                        <th className="px-1 py-2 text-right text-[10px] font-bold text-gray-500 uppercase tracking-wider w-24">LAIKAS</th>
                        <th className="px-1 py-2 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider w-16">PRIO</th>
                        <th className="px-1 py-2 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider w-16">BŪSENA</th>
                        <th className="px-1 py-2 text-center text-[10px] font-bold text-gray-500 uppercase tracking-wider w-10">KOM.</th>
                        <th className="px-1 py-2 text-right text-[10px] font-bold text-gray-500 uppercase tracking-wider w-16"></th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                    {tasks.map((task) => {
                        const dateStr = task.completedAt || task.archivedAt || task.updatedAt;
                        const worker = users?.find(u => u.id === task.assignedWorkerId);
                        const workerName = worker ? (worker.displayName || worker.email) : (task.assignedWorkerName || '-');
                        const isConfirmed = task.status === 'confirmed';

                        // Check permissions for revert button
                        const isManager = userRole === 'manager' || userRole === 'admin';
                        const isCompleter = task.completedBy === currentUser?.uid;
                        const canRevert = (isManager || isCompleter) && !task.isArchived;

                        return (
                            <tr
                                key={task.id}
                                className={`border-b border-gray-100 last:border-0 hover:bg-opacity-80 transition-colors ${isConfirmed ? 'bg-white' : 'bg-blue-50'}`}
                            >
                                <td className="px-2 py-2 text-center">
                                    <input
                                        type="checkbox"
                                        checked={isConfirmed}
                                        onChange={() => handleToggleConfirm(task)}
                                        disabled={task.isArchived}
                                        className="w-3.5 h-3.5 rounded border-gray-300 text-green-600 focus:ring-green-500 cursor-pointer"
                                    />
                                </td>
                                <td className="px-2 py-2">
                                    <div className="flex items-center gap-2">
                                        <div className={`text-sm font-bold text-gray-900 whitespace-normal break-words ${(task.isDeleted || task.status === 'deleted') ? 'line-through text-gray-500' : ''}`}>
                                            {task.title}
                                        </div>
                                        {(task.isDeleted || task.status === 'deleted') && (
                                            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-100 text-red-800 border border-red-200 uppercase whitespace-nowrap">
                                                Ištrinta
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-[10px] text-gray-500 mt-0.5 flex items-start gap-1">
                                        <Briefcase className="w-3 h-3 text-gray-400 flex-shrink-0 mt-0.5" />
                                        <span className="whitespace-normal break-words">{task.description || (task.tag ? `${task.tag}` : 'Užduotis')}</span>
                                    </div>
                                    {dateStr && (
                                        <div className="text-[9px] text-gray-400 mt-1">
                                            {new Date(dateStr).toLocaleString()}
                                        </div>
                                    )}
                                </td>
                                <td className="px-1 py-2 whitespace-nowrap">
                                    <span className="px-2 py-1 rounded-full text-[10px] font-medium bg-gray-100 text-gray-700 border border-gray-200">
                                        {formatDisplayName(workerName).split(' ')[0]}
                                    </span>
                                </td>
                                <td className="px-1 py-2 whitespace-nowrap text-right text-[10px] font-medium font-mono">
                                    <span className="text-blue-600">{task.estimatedTime || '-'}</span>
                                    <span className="text-gray-400 mx-1">/</span>
                                    <span className="text-gray-900">{formatMinutesToTimeString(task.timerMinutes || 0)}</span>
                                </td>
                                <td className="px-1 py-2 whitespace-nowrap">
                                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600 font-medium border border-gray-200 uppercase">
                                        {task.priority || 'Vidut.'}
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
                                        <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-white text-gray-800 border border-gray-200 shadow-sm">
                                            Nepatv.
                                        </span>
                                    )}
                                </td>
                                <td className="px-1 py-2 text-center">
                                    <button
                                        onClick={() => setActiveModal({ type: 'comments', taskId: task.id, task: task })}
                                        className="inline-flex items-center justify-center text-gray-400 hover:text-blue-600 transition-colors p-1"
                                        title="Komentarai"
                                    >
                                        <MessageSquare className="w-4 h-4" />
                                        {task.comments?.length > 0 && (
                                            <span className="ml-0.5 text-[10px] font-bold">{task.comments.length}</span>
                                        )}
                                    </button>
                                </td>
                                <td className="px-1 py-2 text-right">
                                    {canRevert && (
                                        <button
                                            onClick={() => handleRevert(task)}
                                            className="p-1 text-blue-600 hover:bg-blue-50 rounded transition-colors"
                                            title="Grąžinti užduotį"
                                        >
                                            <RotateCcw className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );

    return (
        <div className="space-y-6">
            <h2 className="text-xl font-bold text-gray-900">Ataskaitos ir Duomenys</h2>

            {/* TABS */}
            <div className="flex border-b border-gray-200 overflow-x-auto">

                <button
                    onClick={() => setActiveTab('daily-stats')}
                    className={`px-4 py-2 font-medium text-sm transition-colors whitespace-nowrap border-b-2 ${activeTab === 'daily-stats' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}
                >
                    Dienos Ataskaita
                </button>
                <button
                    onClick={() => setActiveTab('hours')}
                    className={`px-4 py-2 font-medium text-sm transition-colors whitespace-nowrap border-b-2 ${activeTab === 'hours' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}
                >
                    Detali Darbo Suvestinė
                </button>
                <button
                    onClick={() => setActiveTab('tasks')}
                    className={`px-4 py-2 font-medium text-sm transition-colors border-b-2 ${activeTab === 'tasks' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}
                >
                    Užduočių Analizė
                </button>

            </div>



            {/* --- DAILY STATISTICS TAB CONTENT --- */}
            {activeTab === 'daily-stats' && (
                <DailyStatistics
                    currentUser={currentUser}
                    userRole={userRole}
                    users={users}
                />
            )}

            {/* --- HOURS TAB CONTENT --- */}
            {activeTab === 'hours' && (
                <div className="space-y-4">
                    {/* (MonthlyHours removed from here to separate tab) */}

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

                    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-1 py-2 text-left text-[10px] uppercase tracking-wider font-bold text-gray-500 md:px-6 md:py-3 md:text-xs">Darb.</th>
                                    <th className="px-1 py-2 text-right text-[10px] uppercase tracking-wider font-bold text-gray-500 md:px-6 md:py-3 md:text-xs">Viso</th>
                                    <th className="px-1 py-2 text-right text-[10px] uppercase tracking-wider font-bold text-gray-500 md:px-6 md:py-3 md:text-xs">Dienų</th>
                                    <th className="px-1 py-2 text-right text-[10px] uppercase tracking-wider font-bold text-gray-500 md:px-6 md:py-3 md:text-xs">Vid.</th>
                                    <th className="px-1 py-2 w-6 md:px-6 md:py-3 md:w-10"></th>
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
                                            <td className="px-1 py-2 whitespace-nowrap text-[11px] font-bold text-gray-900 md:px-6 md:py-4 md:text-sm md:font-medium">
                                                {formatDisplayName(userStats.name).split(' ')[0]}
                                            </td>
                                            <td className="px-1 py-2 whitespace-nowrap text-[11px] text-right text-blue-600 font-bold md:px-6 md:py-4 md:text-sm">
                                                {formatMinutesToTimeString(userStats.totalMinutes)}
                                            </td>
                                            <td className="px-1 py-2 whitespace-nowrap text-[11px] text-right text-gray-600 md:px-6 md:py-4 md:text-sm">
                                                {Object.keys(userStats.days).length} d.
                                            </td>
                                            <td className="px-1 py-2 whitespace-nowrap text-[11px] text-right text-gray-500 md:px-6 md:py-4 md:text-sm">
                                                {formatMinutesToTimeString(getAvg(userStats.totalMinutes, userStats.days))}
                                            </td>
                                            <td className="px-1 py-2 text-right text-gray-400 md:px-6 md:py-4">
                                                {expandedUser === userStats.userId ? <ChevronUp className="w-3 h-3 md:w-4 md:h-4" /> : <ChevronDown className="w-3 h-3 md:w-4 md:h-4" />}
                                            </td>
                                        </tr>
                                        {expandedUser === userStats.userId && (
                                            <tr className="bg-gray-50/50">
                                                <td colSpan="5" className="px-4 py-4 md:px-6">
                                                    <div className="bg-white border rounded-lg overflow-hidden">
                                                        <div className="px-4 py-2 bg-gray-50 border-b flex justify-between items-center">
                                                            <h4 className="text-sm font-bold text-gray-700">Dienos Išklotinė</h4>
                                                            <span className="text-xs text-gray-500">Spauskite ant dienos detalesnei informacijai</span>
                                                        </div>
                                                        <div className="divide-y divide-gray-100">
                                                            {Object.entries(userStats.days)
                                                                .sort((a, b) => new Date(b[0]) - new Date(a[0])) // Descending date
                                                                .map(([date, dayData]) => {
                                                                    const isDayExpanded = expandedDays[userStats.userId]?.[date];

                                                                    return (
                                                                        <div key={date} className="group">
                                                                            {/* Day Header Row */}
                                                                            <div
                                                                                onClick={() => toggleDayExpand(userStats.userId, date)}
                                                                                className={`p-2 flex items-center justify-between cursor-pointer hover:bg-blue-50 transition-colors border-b border-gray-100 last:border-0 ${isDayExpanded ? 'bg-blue-50/50' : ''}`}
                                                                            >
                                                                                <div className="flex items-center gap-2">
                                                                                    <div className="p-1.5 bg-white border rounded text-gray-400 group-hover:text-blue-500 group-hover:border-blue-200 transition-colors">
                                                                                        {isDayExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                                                                    </div>
                                                                                    <span className="text-xs font-bold text-gray-700">{date}</span>
                                                                                </div>

                                                                                <div className="flex items-center gap-2 text-[10px] font-mono">
                                                                                    {dayData.dayStart && dayData.dayEnd && (
                                                                                        <div className="text-gray-500 mr-2 hidden sm:block">
                                                                                            <span className="text-gray-400 mr-1">Laikas:</span>
                                                                                            <span className="font-medium text-gray-700">{formatTime(dayData.dayStart)} - {formatTime(dayData.dayEnd)}</span>
                                                                                        </div>
                                                                                    )}
                                                                                    {dayData.totalBreak > 0 && (
                                                                                        <div className="text-amber-600 flex items-center gap-1" title="Pertraukos">
                                                                                            <Coffee className="w-3 h-3" />
                                                                                            <span className="font-bold">{formatMinutesToTimeString(dayData.totalBreak)}</span>
                                                                                        </div>
                                                                                    )}
                                                                                    <div className="text-blue-700 flex items-center gap-1">
                                                                                        <Briefcase className="w-3 h-3" />
                                                                                        <span className="font-bold">{formatMinutesToTimeString(dayData.totalWork)}</span>
                                                                                    </div>
                                                                                </div>
                                                                            </div>

                                                                            {/* Expanded Sessions List */}
                                                                            {isDayExpanded && (
                                                                                <div className="bg-gray-50 px-4 py-2 border-t border-gray-100 shadow-inner">
                                                                                    <div className="space-y-1 pl-2 md:pl-10">
                                                                                        {dayData.sessions.map((session, idx) => {
                                                                                            const isBreak = session._type === 'break';

                                                                                            return ( // Display each session
                                                                                                <div key={session.id || idx} className={`text-xs flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0 ${isBreak ? 'text-amber-700' : 'text-gray-600'}`}>
                                                                                                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isBreak ? 'bg-amber-400' : 'bg-blue-400'}`}></div>
                                                                                                    <div className="font-mono text-gray-500 w-24 flex-shrink-0">
                                                                                                        {formatTime(session.startTime)} - {formatTime(session.endTime)}
                                                                                                    </div>
                                                                                                    <div className="font-medium flex-grow truncate">
                                                                                                        {isBreak ? (
                                                                                                            <span className="flex items-center gap-1.5">
                                                                                                                <Coffee className="w-3 h-3" /> Pertrauka
                                                                                                            </span>
                                                                                                        ) : (
                                                                                                            session.taskTitle || 'Darbas'
                                                                                                        )}
                                                                                                    </div>
                                                                                                    <div className={`font-mono font-bold w-12 text-right ${isBreak ? 'text-amber-600' : 'text-blue-600'}`}>
                                                                                                        {formatMinutesToTimeString(session.durationMinutes)}
                                                                                                    </div>
                                                                                                </div>
                                                                                            );
                                                                                        })}
                                                                                        {dayData.sessions.length === 0 && (
                                                                                            <div className="text-xs text-gray-400 italic py-1">Nėra detalių įrašų.</div>
                                                                                        )}
                                                                                    </div>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })}
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
                                {TASK_TAGS.map(tag => (
                                    <option key={tag} value={tag}>{tag}</option>
                                ))}
                            </select>
                        </div>
                        {(userRole === 'manager' || userRole === 'admin') && (
                            <div>
                                <label className="block text-xs font-semibold text-gray-500 mb-1">Filtruoti pagal Darbuotoją</label>
                                <select
                                    value={taskFilters.userId}
                                    onChange={(e) => setTaskFilters(prev => ({ ...prev, userId: e.target.value }))}
                                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                                >
                                    <option value="all">Visi Darbuotojai</option>
                                    {users?.filter(u => !u.isDisabled).map(u => (
                                        <option key={u.id} value={u.id}>{formatDisplayName(u.displayName || u.email)}</option>
                                    ))}
                                </select>
                            </div>
                        )}
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

                    {loading ? (
                        <div className="bg-white p-8 rounded-xl shadow-sm text-center text-gray-500">Kraunami duomenys...</div>
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
                                <div className="bg-white p-8 rounded-xl shadow-sm text-center text-gray-500">
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
        </div>
    );
}
