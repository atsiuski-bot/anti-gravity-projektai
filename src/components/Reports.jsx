import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, orderBy, doc, updateDoc } from 'firebase/firestore';
import { formatMinutesToTimeString, getLithuanianDateString, getLithuanian3AMCutoff, calculateCurrentTotalMinutes } from '../utils/timeUtils';
import { formatDisplayName, formatTime, isManagerRole, resolveUserId, resolveUserName } from '../utils/formatters';
import { addComment } from '../utils/commentActions';
import { STATUS_COLORS, STATUS_LABELS } from '../utils/taskConstants';
import { BarChart, Calendar, Filter, Download, ChevronDown, ChevronUp, Clock, Tag, Briefcase, MessageSquare, RotateCcw, Coffee } from 'lucide-react';



import DailyStatistics from './DailyStatistics';
import { CommentsModal } from './TaskDetailsModals';
import SessionTypeIcon from './SessionTypeIcon';
import { useAuth } from '../context/AuthContext';
import { TASK_TAGS } from '../utils/taskUtils';

export default function Reports({ users }) {
    const { currentUser, userRole } = useAuth();
    const [activeTab, setActiveTab] = useState((isManagerRole(userRole)) ? 'daily-stats' : 'hours');
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

    // --- CALENDAR HISTORY STATE ---
    const [historyMonth, setHistoryMonth] = useState(getLithuanianDateString().slice(0, 7));
    const [calendarHistory, setCalendarHistory] = useState([]);
    const [filteredTasks, setFilteredTasks] = useState([]);

    // Modal state
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null, task: null });

    // Fetch Work Hours Data
    useEffect(() => {
        if (activeTab === 'hours') {
            fetchWorkHours();
        }
    }, [activeTab, selectedMonth]);

    // Auto-expand when there's only one user (worker viewing own data)
    useEffect(() => {
        if (workData.length === 1 && !expandedUser) {
            setExpandedUser(workData[0].userId);
        }
    }, [workData]);

    // Fetch Calendar History
    useEffect(() => {
        if (activeTab === 'calendar-history') {
            fetchCalendarHistory();
        }
    }, [activeTab, historyMonth]);

    // Fetch Tasks Data
    useEffect(() => {
        if (activeTab === 'tasks') {
            fetchTasks();
        }
    }, [activeTab, taskFilters]); // Refetch when filters change

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
            // because adding 'where(userId == ...)' with 'where(date >= ...)' requires a composite index
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

                userMap[uid].totalMinutes += (s.durationMinutes || 0);
                userMap[uid].days[s.date].totalWork += (s.durationMinutes || 0);
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

                userMap[uid].days[s.date].totalBreak += (s.durationMinutes || 0);
                userMap[uid].totalBreakMinutes += (s.durationMinutes || 0);
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

            // Query 1: Archived - Respects date filter
            const archivedQ = query(
                collection(db, 'archived_tasks'),
                where('archivedAt', '>=', new Date(taskFilters.startDate).toISOString())
            );

            // Query 2: Active - Completed or Confirmed
            // We fetch ALL 'completed' (unconfirmed) tasks to ensure "Done Earlier" list is complete
            // And all recent tasks based on update time
            // NOTE: Client-side filtering handles the 'assignedUserId' check for non-managers

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
            const startStr = `${historyMonth}-01T00:00:00.000Z`;
            const endStr = `${historyMonth}-31T23:59:59.999Z`;

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
            alert("Nepavyko pridėti komentaro.");
        }
    };

    const handleRevert = async (task) => {
        // Check permissions: manager or the user who completed the task
        const isManager = isManagerRole(userRole);
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
                        const worker = users?.find(u => u.id === task.assignedUserId);
                        const userName = worker ? (worker.displayName || worker.email) : (task.assignedUserName || '-');
                        const isConfirmed = task.status === 'confirmed';

                        // Check permissions for revert button
                        const isManager = isManagerRole(userRole);
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
                                        {formatDisplayName(userName).split(' ')[0]}
                                    </span>
                                </td>
                                <td className="px-1 py-2 whitespace-nowrap text-right text-[10px] font-medium font-mono">
                                    <span className="text-blue-600">{task.estimatedTime || '-'}</span>
                                    <span className="text-gray-400 mx-1">/</span>
                                    <span className="text-gray-900">{formatMinutesToTimeString(calculateCurrentTotalMinutes(task))}</span>
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
                    onClick={() => setActiveTab('calendar-history')}
                    className={`px-4 py-2 font-medium text-sm transition-colors whitespace-nowrap border-b-2 ${activeTab === 'calendar-history' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}
                >
                    Kalendoriaus pakeitimų istorija
                </button>
                {/* <button
                    onClick={() => setActiveTab('tasks')}
                    className={`px-4 py-2 font-medium text-sm transition-colors border-b-2 ${activeTab === 'tasks' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                        }`}
                >
                    Užduočių Analizė
                </button> */}

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

                    {loading && (
                        <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-200 text-center text-gray-500">Kraunami duomenys...</div>
                    )}
                    {!loading && workData.length === 0 && (
                        <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-200 text-center text-gray-500">Nėra duomenų šiam mėnesiui.</div>
                    )}

                    {/* Single-user simplified view (worker viewing own data) */}
                    {!loading && workData.length === 1 && (() => {
                        const userStats = workData[0];
                        return (
                            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                                {/* Inline stats bar */}
                                <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex items-center gap-4">
                                        <div className="text-sm font-bold text-gray-900">{formatDisplayName(userStats.name).split(' ')[0]}</div>
                                    </div>
                                    <div className="flex items-center gap-4 text-xs">
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500 uppercase font-bold">Darbas:</span>
                                            <span className="text-indigo-600 font-bold">{formatMinutesToTimeString(userStats.totalMinutes)}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500 uppercase font-bold">Pertraukos:</span>
                                            <span className="text-amber-600 font-bold">{formatMinutesToTimeString(userStats.totalBreakMinutes)}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500 uppercase font-bold">Viso(D+P):</span>
                                            <span className="text-blue-600 font-bold">{formatMinutesToTimeString(userStats.totalMinutes + userStats.totalBreakMinutes)}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500 uppercase font-bold">Dienų:</span>
                                            <span className="text-gray-700 font-medium">{Object.keys(userStats.days).length} d.</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500 uppercase font-bold">Vid.:</span>
                                            <span className="text-gray-700 font-medium">{formatMinutesToTimeString(getAvg(userStats.totalMinutes, userStats.days))}</span>
                                        </div>
                                    </div>
                                </div>
                                {/* Header */}
                                <div className="px-4 py-2 bg-white border-b flex justify-between items-center">
                                    <h4 className="text-sm font-bold text-gray-700">Dienos Išklotinė</h4>
                                    <span className="text-xs text-gray-500">Spauskite ant dienos detalesnei informacijai</span>
                                </div>
                                {/* Days list */}
                                <div className="divide-y divide-gray-100">
                                    {Object.entries(userStats.days)
                                        .sort((a, b) => new Date(b[0]) - new Date(a[0]))
                                        .map(([date, dayData]) => {
                                            const isDayExpanded = expandedDays[userStats.userId]?.[date];
                                            return (
                                                <div key={date} className="group">
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
                                                    {isDayExpanded && (
                                                        <div className="bg-gray-50 px-4 py-2 border-t border-gray-100 shadow-inner">
                                                            <div className="space-y-1 pl-2 md:pl-10">
                                                                {dayData.sessions.map((session, idx) => (
                                                                    <div key={session.id || idx} className={`text-xs flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0 ${session._type === 'break' ? 'text-amber-700' : session._type === 'inactive' ? 'text-gray-400 italic' : 'text-gray-600'}`}>
                                                                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${session._type === 'break' ? 'bg-amber-400' : session._type === 'inactive' ? 'bg-gray-300' : 'bg-blue-400'}`}></div>
                                                                        <div className="font-mono text-gray-500 w-24 flex-shrink-0">
                                                                            {formatTime(session.startTime)} - {formatTime(session.endTime)}
                                                                        </div>
                                                                        <div className="font-medium flex-grow truncate">
                                                                            {session._type === 'break' ? (
                                                                                <span className="flex items-center gap-1.5"><SessionTypeIcon type="break" className="w-3.5 h-3.5" /> Pertrauka</span>
                                                                            ) : session._type === 'inactive' ? (
                                                                                <span className="flex items-center gap-1.5 text-gray-400">{session.taskTitle || 'Neaktyvus'}</span>
                                                                            ) : (
                                                                                <span className="flex items-center gap-1.5">
                                                                                    <SessionTypeIcon 
                                                                                        type={session.isSystemTask || (session.taskId && String(session.taskId).startsWith('call_')) ? 'call' : (session.isQuickWork || (session.taskId && String(session.taskId).startsWith('quick_')) ? 'quickWork' : 'task')} 
                                                                                        className="w-3.5 h-3.5" 
                                                                                    />
                                                                                    {session.taskTitle || 'Darbas'}
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                        <div className={`font-mono font-bold w-12 text-right ${session._type === 'break' ? 'text-amber-600' : session._type === 'inactive' ? 'text-gray-400' : 'text-blue-600'}`}>
                                                                            {formatMinutesToTimeString(session.durationMinutes)}
                                                                        </div>
                                                                    </div>
                                                                ))}
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
                        );
                    })()}

                    {/* Multi-user table view (manager/admin) */}
                    {!loading && workData.length > 1 && (
                        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                    <tr>
                                        <th className="px-1 py-2 text-left text-[10px] uppercase tracking-wider font-bold text-gray-500 md:px-6 md:py-3 md:text-xs">Darb.</th>
                                        <th className="px-1 py-2 text-right text-[10px] uppercase tracking-wider font-bold text-gray-500 md:px-6 md:py-3 md:text-xs">Darbas</th>
                                        <th className="px-1 py-2 text-right text-[10px] uppercase tracking-wider font-bold text-gray-500 md:px-6 md:py-3 md:text-xs">Pertraukos</th>
                                        <th className="px-1 py-2 text-right text-[10px] uppercase tracking-wider font-bold text-gray-500 md:px-6 md:py-3 md:text-xs">Viso(D+P)</th>
                                        <th className="px-1 py-2 text-right text-[10px] uppercase tracking-wider font-bold text-gray-500 md:px-6 md:py-3 md:text-xs">Dienų</th>
                                        <th className="px-1 py-2 text-right text-[10px] uppercase tracking-wider font-bold text-gray-500 md:px-6 md:py-3 md:text-xs">Vid.</th>
                                        <th className="px-1 py-2 w-6 md:px-6 md:py-3 md:w-10"></th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                    {workData.map((userStats) => (
                                        <React.Fragment key={userStats.userId}>
                                            <tr
                                                className={`hover:bg-gray-50 cursor-pointer transition-colors ${expandedUser === userStats.userId ? 'bg-blue-50' : ''}`}
                                                onClick={() => setExpandedUser(expandedUser === userStats.userId ? null : userStats.userId)}
                                            >
                                                <td className="px-1 py-2 whitespace-nowrap text-[11px] font-bold text-gray-900 md:px-6 md:py-4 md:text-sm md:font-medium">
                                                    {formatDisplayName(userStats.name).split(' ')[0]}
                                                </td>
                                                <td className="px-1 py-2 whitespace-nowrap text-[11px] text-right text-indigo-600 font-medium md:px-6 md:py-4 md:text-sm">
                                                    {formatMinutesToTimeString(userStats.totalMinutes)}
                                                </td>
                                                <td className="px-1 py-2 whitespace-nowrap text-[11px] text-right text-amber-600 font-medium md:px-6 md:py-4 md:text-sm">
                                                    {formatMinutesToTimeString(userStats.totalBreakMinutes)}
                                                </td>
                                                <td className="px-1 py-2 whitespace-nowrap text-[11px] text-right text-blue-700 font-bold bg-blue-50/10 md:px-6 md:py-4 md:text-sm">
                                                    {formatMinutesToTimeString(userStats.totalMinutes + userStats.totalBreakMinutes)}
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
                                                    <td colSpan="7" className="px-4 py-4 md:px-6">
                                                        <div className="bg-white border rounded-lg overflow-hidden">
                                                            <div className="px-4 py-2 bg-gray-50 border-b flex justify-between items-center">
                                                                <h4 className="text-sm font-bold text-gray-700">Dienos Išklotinė</h4>
                                                                <span className="text-xs text-gray-500">Spauskite ant dienos detalesnei informacijai</span>
                                                            </div>
                                                            <div className="divide-y divide-gray-100">
                                                                {Object.entries(userStats.days)
                                                                    .sort((a, b) => new Date(b[0]) - new Date(a[0]))
                                                                    .map(([date, dayData]) => {
                                                                        const isDayExpanded = expandedDays[userStats.userId]?.[date];
                                                                        return (
                                                                            <div key={date} className="group">
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
                                                                                {isDayExpanded && (
                                                                                    <div className="bg-gray-50 px-4 py-2 border-t border-gray-100 shadow-inner">
                                                                                        <div className="space-y-1 pl-2 md:pl-10">
                                                                                            {dayData.sessions.map((session, idx) => (
                                                                                                <div key={session.id || idx} className={`text-xs flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0 ${session._type === 'break' ? 'text-amber-700' : session._type === 'inactive' ? 'text-gray-400 italic' : 'text-gray-600'}`}>
                                                                                                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${session._type === 'break' ? 'bg-amber-400' : session._type === 'inactive' ? 'bg-gray-300' : 'bg-blue-400'}`}></div>
                                                                                                    <div className="font-mono text-gray-500 w-24 flex-shrink-0">
                                                                                                        {formatTime(session.startTime)} - {formatTime(session.endTime)}
                                                                                                    </div>
                                                                                                    <div className="font-medium flex-grow truncate">
                                                                                                        {session._type === 'break' ? (
                                                                                                            <span className="flex items-center gap-1.5"><SessionTypeIcon type="break" className="w-3.5 h-3.5" /> Pertrauka</span>
                                                                                                        ) : session._type === 'inactive' ? (
                                                                                                            <span className="flex items-center gap-1.5 text-gray-400">{session.taskTitle || 'Neaktyvus'}</span>
                                                                                                        ) : (
                                                                                                            <span className="flex items-center gap-1.5">
                                                                                                                <SessionTypeIcon 
                                                                                                                    type={session.isSystemTask || (session.taskId && String(session.taskId).startsWith('call_')) ? 'call' : (session.isQuickWork || (session.taskId && String(session.taskId).startsWith('quick_')) ? 'quickWork' : 'task')} 
                                                                                                                    className="w-3.5 h-3.5" 
                                                                                                                />
                                                                                                                {session.taskTitle || 'Darbas'}
                                                                                                            </span>
                                                                                                        )}
                                                                                                    </div>
                                                                                                    <div className={`font-mono font-bold w-12 text-right ${session._type === 'break' ? 'text-amber-600' : session._type === 'inactive' ? 'text-gray-400' : 'text-blue-600'}`}>
                                                                                                        {formatMinutesToTimeString(session.durationMinutes)}
                                                                                                    </div>
                                                                                                </div>
                                                                                            ))}
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
                    )}
                </div>
            )}

            {/* --- CALENDAR HISTORY TAB CONTENT --- */}
            {activeTab === 'calendar-history' && (
                <div className="space-y-4">
                    <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 flex flex-wrap gap-4 items-center">
                        <div>
                            <label className="block text-xs font-semibold text-gray-500 mb-1">Pasirinkite mėnesį</label>
                            <input
                                type="month"
                                value={historyMonth}
                                onChange={(e) => setHistoryMonth(e.target.value)}
                                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                            />
                        </div>
                    </div>

                    {loading && (
                        <div className="bg-white p-8 rounded-xl shadow-sm text-center text-gray-500">Kraunami duomenys...</div>
                    )}
                    
                    {!loading && calendarHistory.length === 0 && (
                        <div className="bg-white p-8 rounded-xl shadow-sm text-center text-gray-500">
                            Pagal pasirinktą mėnesį nėra išsaugota jokių kalendoriaus pakeitimų istorijoje.
                        </div>
                    )}

                    {!loading && calendarHistory.length > 0 && (
                        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                    <tr>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Darbuotojas</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Data ir Laikas (Kalendoriuje)</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Veiksmas / Tipas</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Keitimo Laikas (Timestamp)</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Patvirtino / Būsena</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Priežastis</th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-100">
                                    {calendarHistory.map((item) => {
                                        // User Info
                                        const workerLabel = item.userName || "Nežinomas darbuotojas";
                                        
                                        // Times
                                        const eventStart = item.requestedEvent?.start || item.originalEvent?.start || null;
                                        const eventEnd = item.requestedEvent?.end || item.originalEvent?.end || null;
                                        const formatEventTime = (timeStr) => {
                                            if (!timeStr) return '-';
                                            const d = new Date(timeStr);
                                            return `${d.toLocaleDateString('lt-LT')} ${d.toLocaleTimeString('lt-LT', { hour: '2-digit', minute:'2-digit' })}`;
                                        };
                                        const calendarTimeLabel = `${formatEventTime(eventStart)} – ${formatEventTime(eventEnd)}`;
                                        
                                        const actionTimeLabel = new Date(item.createdAt).toLocaleString('lt-LT');

                                        // Action / Type
                                        const getActionColor = (action) => {
                                            if (action === 'add') return 'text-green-600 bg-green-50 border-green-200';
                                            if (action === 'delete') return 'text-red-600 bg-red-50 border-red-200';
                                            return 'text-blue-600 bg-blue-50 border-blue-200';
                                        };
                                        const getActionText = (action) => {
                                            if (action === 'add') return 'Pridėjo';
                                            if (action === 'delete') return 'Ištrynė';
                                            return 'Redagavo';
                                        };

                                        // Work Type (Remote, Vacation, Normal)
                                        const evt = item.requestedEvent || item.originalEvent || {};
                                        let TypeIcon = Briefcase;
                                        let typeLabel = "Darbas ofise";
                                        let typeColor = "text-gray-600";
                                        if (evt.isVacation) {
                                            TypeIcon = null;
                                            typeLabel = "Atostogos";
                                            typeColor = "text-amber-500";
                                        } else if (evt.isWorkFromHome) {
                                            TypeIcon = null; 
                                            typeLabel = "Nuotolinis darbas";
                                            typeColor = "text-blue-500";
                                        }

                                        // Manager / Status
                                        let statusLabel = "Laukiama";
                                        let statusColor = "bg-yellow-100 text-yellow-800";
                                        if (item.status === 'approved') {
                                            statusLabel = "Patvirtinta";
                                            statusColor = "bg-green-100 text-green-800";
                                        } else if (item.status === 'declined') {
                                            statusLabel = "Atmesta";
                                            statusColor = "bg-red-100 text-red-800";
                                        }

                                        const getManagerName = (sysId) => {
                                            if (!sysId) return "-";
                                            if (sysId === 'system') return 'Sistema';
                                            const sysUser = users?.find(u => u.id === sysId);
                                            return sysUser ? (sysUser.displayName || sysUser.email) : sysId;
                                        };

                                        const managerLabel = item.approvedBy ? getManagerName(item.approvedBy) : "-";

                                        // Reason
                                        const reasonLabel = (item.reason === 'PlanningTime') ? "Suplanuota iš anksto" : (item.reason || "-");

                                        return (
                                            <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                                                <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                                                    {workerLabel}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-600 font-mono">
                                                    {calendarTimeLabel}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap">
                                                    <div className="flex flex-col gap-1 items-start">
                                                        <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold border ${getActionColor(item.type)}`}>
                                                            {getActionText(item.type)}
                                                        </span>
                                                        <span className={`text-[11px] font-semibold flex items-center gap-1 ${typeColor}`}>
                                                            {TypeIcon && <TypeIcon className="w-3 h-3" />}
                                                            {typeLabel}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500 font-mono">
                                                    {actionTimeLabel}
                                                </td>
                                                <td className="px-4 py-3 whitespace-nowrap">
                                                    <div className="flex flex-col gap-1 items-start">
                                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusColor}`}>
                                                            {statusLabel}
                                                        </span>
                                                        <span className="text-[11px] text-gray-500 font-medium">
                                                            {managerLabel}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 text-sm text-gray-700 italic max-w-xs break-words">
                                                    {reasonLabel}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
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
                        {(isManagerRole(userRole)) && (
                            <div>
                                <label className="block text-xs font-semibold text-gray-500 mb-1">Filtruoti pagal Darbuotoją</label>
                                <select
                                    value={taskFilters.userId}
                                    onChange={(e) => setTaskFilters(prev => ({ ...prev, userId: e.target.value }))}
                                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                                >
                                    <option value="all">Visi Darbuotojai</option>
                                    {users?.map(u => (
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
