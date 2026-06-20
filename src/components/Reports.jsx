import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, orderBy, doc, updateDoc } from 'firebase/firestore';
import { formatMinutesToTimeString, getLithuanianDateString, calculateCurrentTotalMinutes } from '../utils/timeUtils';
import { formatDisplayName, formatTime, isManagerRole, resolveUserId, resolveUserName } from '../utils/formatters';
import { addComment } from '../utils/commentActions';
import { ChevronDown, ChevronUp, Briefcase, MessageSquare, RotateCcw, Coffee, Info, AlertTriangle } from 'lucide-react';

import IconButton from './ui/IconButton';
import ConfirmDialog from './ui/ConfirmDialog';

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
    const [taskSort, setTaskSort] = useState('date_desc'); // date_desc, date_asc, time_desc, time_asc

    // Modal state
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null, task: null });

    // Friendly error banner (replaces banned window.alert — §8/§10). Never holds raw err.message.
    const [error, setError] = useState('');

    // Revert confirmation (replaces window.confirm — §8). Holds the task awaiting confirmation.
    const [revertTarget, setRevertTarget] = useState(null);
    const [reverting, setReverting] = useState(false);

    // Fetch Work Hours Data
    useEffect(() => {
        if (activeTab === 'hours') {
            fetchWorkHours();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchWorkHours is recreated each render; intentionally refetch only on tab/month change
    }, [activeTab, selectedMonth]);

    // Auto-expand when there's only one user (worker viewing own data)
    useEffect(() => {
        if (workData.length === 1 && !expandedUser) {
            setExpandedUser(workData[0].userId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally auto-expand only when workData changes, not on every expandedUser update
    }, [workData]);

    // Fetch Calendar History
    useEffect(() => {
        if (activeTab === 'calendar-history') {
            fetchCalendarHistory();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchCalendarHistory is recreated each render; intentionally refetch only on tab/month change
    }, [activeTab, historyMonth]);

    // Fetch Tasks Data
    useEffect(() => {
        if (activeTab === 'tasks') {
            fetchTasks();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchTasks is recreated each render; intentionally refetch only on tab/filter change
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
                        <th className="px-2 py-2 text-center w-8 text-caption font-bold text-gray-500 uppercase tracking-wider">OK</th>
                        <th className="px-2 py-2 text-left text-caption font-bold text-gray-500 uppercase tracking-wider">UŽDUOTIS</th>
                        <th className="px-1 py-2 text-left text-caption font-bold text-gray-500 uppercase tracking-wider w-12">DARB.</th>
                        <th className="px-1 py-2 text-right text-caption font-bold text-gray-500 uppercase tracking-wider w-24">LAIKAS</th>
                        <th className="px-1 py-2 text-left text-caption font-bold text-gray-500 uppercase tracking-wider w-16">PRIO</th>
                        <th className="px-1 py-2 text-left text-caption font-bold text-gray-500 uppercase tracking-wider w-16">BŪSENA</th>
                        <th className="px-1 py-2 text-center text-caption font-bold text-gray-500 uppercase tracking-wider w-10">KOM.</th>
                        <th className="px-1 py-2 text-right text-caption font-bold text-gray-500 uppercase tracking-wider w-16"></th>
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
                                        aria-label={isConfirmed ? `Pažymėti „${task.title}“ kaip nepatvirtintą` : `Patvirtinti „${task.title}“`}
                                        className="w-5 h-5 rounded border-gray-300 text-green-600 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 cursor-pointer"
                                    />
                                </td>
                                <td className="px-2 py-2">
                                    <div className="flex items-center gap-2">
                                        <div className={`text-sm font-bold text-gray-900 whitespace-normal break-words ${(task.isDeleted || task.status === 'deleted') ? 'line-through text-gray-500' : ''}`}>
                                            {task.title}
                                        </div>
                                        {(task.isDeleted || task.status === 'deleted') && (
                                            <span className="px-1.5 py-0.5 rounded text-caption font-semibold bg-red-100 text-red-800 border border-red-200 uppercase whitespace-nowrap">
                                                Ištrinta
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-caption text-gray-500 mt-0.5 flex items-start gap-1">
                                        <Briefcase className="w-3 h-3 text-gray-400 flex-shrink-0 mt-0.5" />
                                        <span className="whitespace-normal break-words">{task.description || (task.tag ? `${task.tag}` : 'Užduotis')}</span>
                                    </div>
                                    {dateStr && (
                                        <div className="text-caption text-gray-500 mt-1">
                                            {new Date(dateStr).toLocaleString()}
                                        </div>
                                    )}
                                </td>
                                <td className="px-1 py-2 whitespace-nowrap">
                                    <span className="px-2 py-1 rounded-full text-caption font-medium bg-gray-100 text-gray-700 border border-gray-200">
                                        {formatDisplayName(userName).split(' ')[0]}
                                    </span>
                                </td>
                                <td className="px-1 py-2 whitespace-nowrap text-right text-caption font-medium font-mono">
                                    <span className="text-blue-600">{task.estimatedTime || '-'}</span>
                                    <span className="text-gray-400 mx-1">/</span>
                                    <span className="text-gray-900">{formatMinutesToTimeString(calculateCurrentTotalMinutes(task))}</span>
                                </td>
                                <td className="px-1 py-2 whitespace-nowrap">
                                    <span className="px-1.5 py-0.5 rounded text-caption bg-gray-100 text-gray-600 font-medium border border-gray-200 uppercase">
                                        {task.priority || 'Vidut.'}
                                    </span>
                                </td>
                                <td className="px-1 py-2 whitespace-nowrap">
                                    {(task.isDeleted || task.status === 'deleted') ? (
                                        <span className="px-2 py-0.5 rounded text-caption font-semibold bg-red-100 text-red-800 border border-red-200">
                                            Ištrinta
                                        </span>
                                    ) : isConfirmed ? (
                                        <span className="px-2 py-0.5 rounded text-caption font-semibold bg-green-100 text-green-800 border border-green-200">
                                            Patvirt.
                                        </span>
                                    ) : (
                                        <span className="px-2 py-0.5 rounded text-caption font-medium bg-white text-gray-800 border border-gray-200 shadow-sm">
                                            Nepatv.
                                        </span>
                                    )}
                                </td>
                                <td className="px-1 py-2 text-center">
                                    <IconButton
                                        label="Peržiūrėti komentarus"
                                        onClick={() => setActiveModal({ type: 'comments', taskId: task.id, task: task })}
                                        className="relative mx-auto"
                                    >
                                        <MessageSquare className="w-4 h-4" aria-hidden="true" />
                                        {task.comments?.length > 0 && (
                                            <span className="ml-0.5 text-caption font-bold">{task.comments.length}</span>
                                        )}
                                    </IconButton>
                                </td>
                                <td className="px-1 py-2 text-right">
                                    {canRevert && (
                                        <IconButton
                                            label="Grąžinti užduotį"
                                            variant="primary"
                                            onClick={() => handleRevert(task)}
                                            className="ml-auto bg-transparent text-blue-600 hover:bg-blue-50"
                                        >
                                            <RotateCcw className="w-4 h-4" aria-hidden="true" />
                                        </IconButton>
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );

    // Per-user "Dienos Išklotinė" panel — shared by the desktop expanded row and the mobile card
    // (keeps the day breakdown identical across both layouts instead of duplicating ~80 lines).
    const DayBreakdown = ({ userStats }) => (
        <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b flex justify-between items-center">
                <h4 className="text-body font-bold text-gray-700">Dienos Išklotinė</h4>
                <span className="text-caption text-gray-500">Spauskite ant dienos detalesnei informacijai</span>
            </div>
            <div className="divide-y divide-gray-100">
                {Object.entries(userStats.days)
                    .sort((a, b) => new Date(b[0]) - new Date(a[0]))
                    .map(([date, dayData]) => {
                        const isDayExpanded = expandedDays[userStats.userId]?.[date];
                        return (
                            <div key={date} className="group">
                                <button
                                    type="button"
                                    onClick={() => toggleDayExpand(userStats.userId, date)}
                                    aria-expanded={!!isDayExpanded}
                                    aria-label={isDayExpanded ? `Slėpti ${date} dienos detales` : `Rodyti ${date} dienos detales`}
                                    className={`w-full min-h-touch p-2 flex items-center justify-between cursor-pointer text-left hover:bg-blue-50 transition-colors border-b border-gray-100 last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset ${isDayExpanded ? 'bg-blue-50/50' : ''}`}
                                >
                                    <div className="flex items-center gap-2">
                                        <div className="inline-flex items-center justify-center w-9 h-9 bg-white border rounded text-gray-400 group-hover:text-blue-500 group-hover:border-blue-200 transition-colors">
                                            {isDayExpanded ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
                                        </div>
                                        <span className="text-caption font-bold text-gray-700">{date}</span>
                                    </div>
                                    <div className="flex items-center gap-2 text-caption font-mono">
                                        {dayData.dayStart && dayData.dayEnd && (
                                            <div className="text-gray-500 mr-2 hidden sm:block">
                                                <span className="text-gray-400 mr-1">Laikas:</span>
                                                <span className="font-medium text-gray-700">{formatTime(dayData.dayStart)} - {formatTime(dayData.dayEnd)}</span>
                                            </div>
                                        )}
                                        {dayData.totalBreak > 0 && (
                                            <div className="text-amber-600 flex items-center gap-1" title="Pertraukos">
                                                <Coffee className="w-3 h-3" aria-hidden="true" />
                                                <span className="font-bold">{formatMinutesToTimeString(dayData.totalBreak)}</span>
                                            </div>
                                        )}
                                        <div className="text-blue-700 flex items-center gap-1">
                                            <Briefcase className="w-3 h-3" aria-hidden="true" />
                                            <span className="font-bold">{formatMinutesToTimeString(dayData.totalWork)}</span>
                                        </div>
                                    </div>
                                </button>
                                {isDayExpanded && (
                                    <div className="bg-gray-50 px-4 py-2 border-t border-gray-100 shadow-inner">
                                        <div className="space-y-1 pl-2 md:pl-10">
                                            {dayData.sessions.map((session, idx) => (
                                                <div key={session.id || idx} className={`text-caption flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0 ${session._type === 'break' ? 'text-amber-700' : session._type === 'inactive' ? 'text-gray-400 italic' : 'text-gray-600'}`}>
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
                                                <div className="text-caption text-gray-400 italic py-1">Nėra detalių įrašų.</div>
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

    // Derive the display fields for one calendar-history entry. Computed once and shared by the
    // mobile card and the desktop table so both layouts stay in sync (ISSUE #17b).
    const deriveCalendarEntry = (item) => {
        const workerLabel = item.userName || "Nežinomas darbuotojas";

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
            if (action === 'add') return 'text-green-600 bg-green-50 border-green-200';
            if (action === 'delete') return 'text-red-600 bg-red-50 border-red-200';
            return 'text-blue-600 bg-blue-50 border-blue-200';
        };
        const getActionText = (action) => {
            if (action === 'add') return 'Pridėjo';
            if (action === 'delete') return 'Ištrynė';
            return 'Redagavo';
        };

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
        const reasonLabel = (item.reason === 'PlanningTime') ? "Suplanuota iš anksto" : (item.reason || "-");

        return {
            workerLabel, calendarTimeLabel, actionTimeLabel,
            actionColor: getActionColor(item.type), actionText: getActionText(item.type),
            TypeIcon, typeLabel, typeColor, statusLabel, statusColor, managerLabel, reasonLabel,
        };
    };

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

            {/* Friendly error banner — replaces banned window.alert (§8); never raw err.message (§10) */}
            {error && (
                <div
                    role="alert"
                    className="flex items-start gap-3 rounded-control border-l-4 border-feedback-danger bg-red-50 p-4"
                >
                    <AlertTriangle className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-red-700">{error}</p>
                    <button
                        type="button"
                        onClick={() => setError('')}
                        aria-label="Uždaryti pranešimą"
                        className="ml-auto text-caption font-semibold text-red-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                    >
                        Uždaryti
                    </button>
                </div>
            )}



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
                                className="border border-gray-300 rounded-lg px-3 py-2 text-body-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
                                {/* Stats header — work hours are the dominant month metric (§5/ISSUE #18) */}
                                <div className="px-4 py-4 bg-gray-50 border-b border-gray-200 space-y-3">
                                    <div className="text-body font-bold text-gray-900">{formatDisplayName(userStats.name).split(' ')[0]}</div>

                                    {/* Primary metric: actual work hours, promoted to display size */}
                                    <div>
                                        <div className="text-caption uppercase font-bold tracking-wide text-gray-500">Darbas</div>
                                        <div className="text-display font-bold text-indigo-600 leading-none">
                                            {formatMinutesToTimeString(userStats.totalMinutes)}
                                        </div>
                                    </div>

                                    {/* Secondary peers: breaks, combined time, days, average */}
                                    <div className="flex flex-wrap items-start gap-x-6 gap-y-2 text-body">
                                        <div className="flex flex-col">
                                            <span className="text-caption uppercase font-bold tracking-wide text-gray-500">Pertraukos</span>
                                            <span className="text-amber-600 font-bold">{formatMinutesToTimeString(userStats.totalBreakMinutes)}</span>
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="flex items-center gap-1 text-caption uppercase font-bold tracking-wide text-gray-500">
                                                Bendras laikas
                                                <span
                                                    className="inline-flex items-center"
                                                    title="Apima darbą ir pertraukas — tai NE tik darbo valandos."
                                                >
                                                    <Info className="w-3.5 h-3.5 text-gray-400" aria-hidden="true" />
                                                    <span className="sr-only">Apima darbą ir pertraukas, ne tik darbo valandas.</span>
                                                </span>
                                            </span>
                                            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 font-bold">
                                                <Briefcase className="w-3 h-3" aria-hidden="true" />
                                                {formatMinutesToTimeString(userStats.totalMinutes + userStats.totalBreakMinutes)}
                                            </span>
                                            <span className="text-caption text-gray-500">Darbas + Pertraukos</span>
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="text-caption uppercase font-bold tracking-wide text-gray-500">Dienų</span>
                                            <span className="text-gray-700 font-medium">{Object.keys(userStats.days).length} d.</span>
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="text-caption uppercase font-bold tracking-wide text-gray-500">Vid.</span>
                                            <span className="text-gray-700 font-medium">{formatMinutesToTimeString(getAvg(userStats.totalMinutes, userStats.days))}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="p-3">
                                    <DayBreakdown userStats={userStats} />
                                </div>
                            </div>
                        );
                    })()}

                    {/* Multi-user view (manager/admin). On a phone, data is cards — never a
                        horizontally-scrolling table (§9). The expand action is an always-visible
                        44px button, since group-hover affordances are invisible on touch. */}
                    {!loading && workData.length > 1 && (
                        <>
                            {/* Mobile / touch: one card per worker */}
                            <ul className="space-y-3 md:hidden">
                                {workData.map((userStats) => {
                                    const isExpanded = expandedUser === userStats.userId;
                                    const workerName = formatDisplayName(userStats.name).split(' ')[0];
                                    return (
                                        <li key={userStats.userId} className="bg-white rounded-card border border-line shadow-sm overflow-hidden">
                                            <div className="p-4 space-y-3">
                                                <div className="flex items-start justify-between gap-2">
                                                    <div className="min-w-0">
                                                        <div className="text-caption uppercase font-bold tracking-wide text-gray-500">Darbuotojas</div>
                                                        <div className="text-body font-bold text-gray-900 truncate">{workerName}</div>
                                                    </div>
                                                    <IconButton
                                                        icon={isExpanded ? ChevronUp : ChevronDown}
                                                        label={isExpanded ? `Slėpti ${workerName} dienų išklotinę` : `Rodyti ${workerName} dienų išklotinę`}
                                                        aria-expanded={isExpanded}
                                                        onClick={() => setExpandedUser(isExpanded ? null : userStats.userId)}
                                                    />
                                                </div>

                                                {/* Primary metric: actual work hours */}
                                                <div>
                                                    <div className="text-caption uppercase font-bold tracking-wide text-gray-500">Darbas</div>
                                                    <div className="text-h1 font-bold text-indigo-600 leading-none">
                                                        {formatMinutesToTimeString(userStats.totalMinutes)}
                                                    </div>
                                                </div>

                                                {/* Secondary peers */}
                                                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-body">
                                                    <div className="flex flex-col">
                                                        <span className="text-caption uppercase font-bold tracking-wide text-gray-500">Pertraukos</span>
                                                        <span className="text-amber-600 font-bold">{formatMinutesToTimeString(userStats.totalBreakMinutes)}</span>
                                                    </div>
                                                    <div className="flex flex-col">
                                                        <span className="flex items-center gap-1 text-caption uppercase font-bold tracking-wide text-gray-500">
                                                            Bendras laikas
                                                            <span className="inline-flex items-center" title="Apima darbą ir pertraukas — tai NE tik darbo valandos.">
                                                                <Info className="w-3.5 h-3.5 text-gray-400" aria-hidden="true" />
                                                                <span className="sr-only">Apima darbą ir pertraukas, ne tik darbo valandas.</span>
                                                            </span>
                                                        </span>
                                                        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 font-bold">
                                                            <Briefcase className="w-3 h-3" aria-hidden="true" />
                                                            {formatMinutesToTimeString(userStats.totalMinutes + userStats.totalBreakMinutes)}
                                                        </span>
                                                    </div>
                                                    <div className="flex flex-col">
                                                        <span className="text-caption uppercase font-bold tracking-wide text-gray-500">Dienų</span>
                                                        <span className="text-gray-700 font-medium">{Object.keys(userStats.days).length} d.</span>
                                                    </div>
                                                    <div className="flex flex-col">
                                                        <span className="text-caption uppercase font-bold tracking-wide text-gray-500">Vid.</span>
                                                        <span className="text-gray-700 font-medium">{formatMinutesToTimeString(getAvg(userStats.totalMinutes, userStats.days))}</span>
                                                    </div>
                                                </div>
                                            </div>
                                            {isExpanded && (
                                                <div className="bg-gray-50/50 border-t border-line p-3">
                                                    <DayBreakdown userStats={userStats} />
                                                </div>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>

                            {/* Desktop / wide: denser table is allowed (§9) */}
                            <div className="hidden bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto md:block">
                                <table className="min-w-full divide-y divide-gray-200">
                                    <thead className="bg-gray-50">
                                        <tr>
                                            <th className="px-6 py-3 text-left text-caption uppercase tracking-wider font-bold text-gray-500">Darb.</th>
                                            <th className="px-6 py-3 text-right text-caption uppercase tracking-wider font-bold text-gray-500">Darbas</th>
                                            <th className="px-6 py-3 text-right text-caption uppercase tracking-wider font-bold text-gray-500">Pertraukos</th>
                                            <th className="px-6 py-3 text-right text-caption uppercase tracking-wider font-bold text-gray-500" title="Bendras laikas: apima darbą ir pertraukas — ne tik darbo valandos.">Bendras laikas</th>
                                            <th className="px-6 py-3 text-right text-caption uppercase tracking-wider font-bold text-gray-500">Dienų</th>
                                            <th className="px-6 py-3 text-right text-caption uppercase tracking-wider font-bold text-gray-500">Vid.</th>
                                            <th className="px-6 py-3 w-10"></th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-white divide-y divide-gray-200">
                                        {workData.map((userStats) => {
                                            const isExpanded = expandedUser === userStats.userId;
                                            const workerName = formatDisplayName(userStats.name).split(' ')[0];
                                            return (
                                                <React.Fragment key={userStats.userId}>
                                                    <tr
                                                        className={`hover:bg-gray-50 cursor-pointer transition-colors ${isExpanded ? 'bg-blue-50' : ''}`}
                                                        onClick={() => setExpandedUser(isExpanded ? null : userStats.userId)}
                                                    >
                                                        <td className="px-6 py-4 whitespace-nowrap text-body font-medium text-gray-900">
                                                            {workerName}
                                                        </td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-body text-right text-indigo-600 font-medium">
                                                            {formatMinutesToTimeString(userStats.totalMinutes)}
                                                        </td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-body text-right text-amber-600 font-medium">
                                                            {formatMinutesToTimeString(userStats.totalBreakMinutes)}
                                                        </td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-body text-right text-blue-700 font-bold bg-blue-50/10">
                                                            {formatMinutesToTimeString(userStats.totalMinutes + userStats.totalBreakMinutes)}
                                                        </td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-body text-right text-gray-600">
                                                            {Object.keys(userStats.days).length} d.
                                                        </td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-body text-right text-gray-500">
                                                            {formatMinutesToTimeString(getAvg(userStats.totalMinutes, userStats.days))}
                                                        </td>
                                                        <td className="px-6 py-4 text-right text-gray-400">
                                                            {isExpanded ? <ChevronUp className="w-4 h-4" aria-hidden="true" /> : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
                                                        </td>
                                                    </tr>
                                                    {isExpanded && (
                                                        <tr className="bg-gray-50/50">
                                                            <td colSpan="7" className="px-6 py-4">
                                                                <DayBreakdown userStats={userStats} />
                                                            </td>
                                                        </tr>
                                                    )}
                                                </React.Fragment>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </>
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
                                className="border border-gray-300 rounded-lg px-3 py-2 text-body-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
                        <>
                            {/* Mobile / touch: one card per change (never a horizontally-scrolling table — §9) */}
                            <ul className="space-y-3 md:hidden">
                                {calendarHistory.map((item) => {
                                    const e = deriveCalendarEntry(item);
                                    const { TypeIcon } = e;
                                    return (
                                        <li key={item.id} className="bg-white rounded-card border border-line shadow-sm p-4 space-y-3">
                                            <div className="flex items-start justify-between gap-2">
                                                <span className="text-body font-bold text-gray-900 truncate">{e.workerLabel}</span>
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
                                                    <dt className="text-caption uppercase font-bold tracking-wide text-gray-500">Data ir laikas</dt>
                                                    <dd className="font-mono text-gray-700">{e.calendarTimeLabel}</dd>
                                                </div>
                                                <div className="flex flex-col">
                                                    <dt className="text-caption uppercase font-bold tracking-wide text-gray-500">Keitimo laikas</dt>
                                                    <dd className="font-mono text-gray-500">{e.actionTimeLabel}</dd>
                                                </div>
                                                <div className="flex flex-col">
                                                    <dt className="text-caption uppercase font-bold tracking-wide text-gray-500">Patvirtino</dt>
                                                    <dd className="text-gray-700">{e.managerLabel}</dd>
                                                </div>
                                                {e.reasonLabel !== '-' && (
                                                    <div className="flex flex-col">
                                                        <dt className="text-caption uppercase font-bold tracking-wide text-gray-500">Priežastis</dt>
                                                        <dd className="italic text-gray-700 break-words">{e.reasonLabel}</dd>
                                                    </div>
                                                )}
                                            </dl>
                                        </li>
                                    );
                                })}
                            </ul>

                            {/* Desktop / wide: denser table is allowed (§9) */}
                            <div className="hidden bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto md:block">
                                <table className="min-w-full divide-y divide-gray-200">
                                    <thead className="bg-gray-50">
                                        <tr>
                                            <th className="px-4 py-3 text-left text-caption font-bold text-gray-500 uppercase tracking-wider">Darbuotojas</th>
                                            <th className="px-4 py-3 text-left text-caption font-bold text-gray-500 uppercase tracking-wider">Data ir laikas (kalendoriuje)</th>
                                            <th className="px-4 py-3 text-left text-caption font-bold text-gray-500 uppercase tracking-wider">Veiksmas / tipas</th>
                                            <th className="px-4 py-3 text-left text-caption font-bold text-gray-500 uppercase tracking-wider">Keitimo laikas</th>
                                            <th className="px-4 py-3 text-left text-caption font-bold text-gray-500 uppercase tracking-wider">Patvirtino / būsena</th>
                                            <th className="px-4 py-3 text-left text-caption font-bold text-gray-500 uppercase tracking-wider">Priežastis</th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-white divide-y divide-gray-100">
                                        {calendarHistory.map((item) => {
                                            const e = deriveCalendarEntry(item);
                                            const { TypeIcon } = e;
                                            return (
                                                <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                                                    <td className="px-4 py-3 whitespace-nowrap text-body font-medium text-gray-900">
                                                        {e.workerLabel}
                                                    </td>
                                                    <td className="px-4 py-3 whitespace-nowrap text-caption text-gray-600 font-mono">
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
                                                    <td className="px-4 py-3 whitespace-nowrap text-caption text-gray-500 font-mono">
                                                        {e.actionTimeLabel}
                                                    </td>
                                                    <td className="px-4 py-3 whitespace-nowrap">
                                                        <div className="flex flex-col gap-1 items-start">
                                                            <span className={`px-2 py-0.5 rounded-full text-caption font-bold ${e.statusColor}`}>
                                                                {e.statusLabel}
                                                            </span>
                                                            <span className="text-caption text-gray-500 font-medium">
                                                                {e.managerLabel}
                                                            </span>
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3 text-body text-gray-700 italic max-w-xs break-words">
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
