import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, orderBy, onSnapshot, deleteDoc, doc, setDoc, where, addDoc, getDocs, updateDoc } from 'firebase/firestore';
import { FileText, Download, RotateCcw, Calendar, UserCheck, Filter, Trash2, MessageCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import clsx from 'clsx';
import { startOfWeek, subWeeks } from 'date-fns';
import { formatDisplayName, isManagerRole, resolveUserId, resolveUserName } from '../utils/formatters';
import { TASK_TAGS } from '../utils/taskUtils';
import { getLithuanianDateString, getLithuanianNow, calculateCurrentTotalMinutes, formatMinutesToTimeString } from '../utils/timeUtils';
import { deleteTask } from '../utils/taskActions';
import { DeleteConfirmationModal, CommentsModal, TimeAdjustmentsModal } from './TaskDetailsModals';
import SessionTypeIcon from './SessionTypeIcon';
import { addComment } from '../utils/commentActions';

export default function TaskHistory({ userId, users = [] }) {
    const { userRole, currentUser } = useAuth();
    const isManagerOrAdmin = isManagerRole(userRole);
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedTasks, setExpandedTasks] = useState(new Set());
    const [deleteModalTask, setDeleteModalTask] = useState(null);
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null });
    const [commentsModalTask, setCommentsModalTask] = useState(null);

    // Filter States
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [filterUser, setFilterUser] = useState('all');
    const [filterTag, setFilterTag] = useState('all');
    const [sortBy, setSortBy] = useState('date'); // 'date' | 'status'

    const toggleExpand = (taskId) => {
        const newExpanded = new Set(expandedTasks);
        if (newExpanded.has(taskId)) {
            newExpanded.delete(taskId);
        } else {
            newExpanded.add(taskId);
        }
        setExpandedTasks(newExpanded);
    };

    // Initialize dates on mount (Last 2 weeks)
    useEffect(() => {
        const now = getLithuanianNow();
        const startOfCurrentWeek = startOfWeek(now, { weekStartsOn: 1 });
        const start = subWeeks(startOfCurrentWeek, 1); // Current week + 1 previous

        setDateFrom(getLithuanianDateString(start));
        setDateTo(getLithuanianDateString(now));
    }, []);

    // Fetch tasks based on filters
    useEffect(() => {
        if (!dateFrom || !dateTo) return;

        setLoading(true);

        const start = new Date(dateFrom);
        start.setHours(0, 0, 0, 0); // Start of day

        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999); // End of day

        const startIso = start.toISOString();
        const endIso = end.toISOString();

        // Determine effective user ID to query
        // If explicit 'userId' prop is passed (e.g. from Worker view), use it.
        // If 'userId' prop is 'all' (Manager view), use the local 'filterUser' state.
        let targetUserId = 'all';
        if (userId && userId !== 'all') {
            targetUserId = userId; // Worker view or specific user prop
        } else {
            targetUserId = filterUser; // Manager view dropdown selection
        }

        let q;

        // Base Query constraints
        const constraints = [
            where('archivedAt', '>=', startIso),
            where('archivedAt', '<=', endIso),
            orderBy('archivedAt', 'desc')
        ];

        q = query(collection(db, 'archived_tasks'), ...constraints);

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const tasksData = snapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    ...data,
                    assignedUserId: resolveUserId(data),
                    assignedUserName: resolveUserName(data)
                };
            });

            // Client-side filtering for Tag (Firestore limitation on multiple inequality/array-contains with inequalities)
            // And any other refinement
            const filteredTasks = tasksData.filter(task => {
                if (targetUserId !== 'all' && task.assignedUserId !== targetUserId) return false;
                if (filterTag !== 'all' && task.tag !== filterTag) return false;
                return true;
            });

            // Sort manually ensuring robust timestamp handling
            const sortedTasks = filteredTasks.sort((a, b) => {
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

                const getTimestamp = (task) => {
                    const dateStr = task.completedAt || task.archivedAt || task.updatedAt;
                    if (!dateStr) return 0;
                    const timestamp = new Date(dateStr).getTime();
                    return isNaN(timestamp) ? 0 : timestamp;
                };

                const timeA = getTimestamp(a);
                const timeB = getTimestamp(b);

                return timeB - timeA;
            });

            setTasks(sortedTasks);
            setLoading(false);
        }, (error) => {
            console.error("Error subscribing to archived tasks:", error);
            setLoading(false);
        });

        return () => unsubscribe();
    }, [dateFrom, dateTo, filterUser, userId, filterTag, sortBy]);

    const handleExport = async () => {
        try {
            const exportDataPromises = tasks.map(async (task) => {
                const realTimeMinutes = calculateCurrentTotalMinutes(task);
                
                // Fetch work sessions to get session times
                const sessionsQuery = query(collection(db, 'work_sessions'), where('taskId', '==', task.id));
                const sessionsSnap = await getDocs(sessionsQuery);
                const sessionTimes = sessionsSnap.docs.map(doc => {
                    const data = doc.data();
                    return {
                        date: data.date,
                        durationMinutes: data.durationMinutes ? Math.round(data.durationMinutes) : 0,
                        formattedDuration: data.durationMinutes ? formatMinutesToTimeString(data.durationMinutes) : '0h 0m'
                    };
                }).filter(s => s.durationMinutes > 0);

                const cleanedAdjustments = (task.timeAdjustments || []).map(adj => ({
                    date: adj.date,
                    durationMinutes: adj.durationMinutes,
                    formattedDuration: adj.durationMinutes ? formatMinutesToTimeString(adj.durationMinutes) : '0h 0m',
                    reason: adj.reason || ''
                }));

                const cleanedComments = (task.comments || []).map(c => `${c.user}: ${c.text}`);

                return {
                    id: task.id,
                    title: task.title,
                    description: task.description || '',
                    priority: getPriorityLabel(task.priority),
                    tag: task.tag || '',
                    status: task.status === 'confirmed' ? 'Patvirtinta' : (task.isDeleted || task.status === 'deleted' ? 'Ištrinta' : 'Atlikta'),
                    assignedWorker: task.assignedUserName || '',
                    manager: task.managerName || '',
                    creator: task.creatorName || '',
                    deadline: task.deadline || '',
                    estimatedTime: task.estimatedTime || '0h 0m',
                    totalWorkedTimeFormatted: realTimeMinutes !== 0 ? formatMinutesToTimeString(realTimeMinutes) : '0h 0m',
                    totalWorkedMinutes: Math.round(realTimeMinutes),
                    sessionTimes: sessionTimes,
                    timeAdjustments: cleanedAdjustments,
                    comments: cleanedComments,
                    createdAt: task.createdAt ? new Date(task.createdAt).toLocaleString('lt-LT') : null,
                    assignedAt: task.assignedAt ? new Date(task.assignedAt).toLocaleString('lt-LT') : null,
                    startedAt: task.startedAt ? new Date(task.startedAt).toLocaleString('lt-LT') : null,
                    completedAt: task.completedAt ? new Date(task.completedAt).toLocaleString('lt-LT') : null,
                    approvedAt: task.approvedAt ? new Date(task.approvedAt).toLocaleString('lt-LT') : (task.confirmedAt ? new Date(task.confirmedAt).toLocaleString('lt-LT') : null)
                };
            });

            const exportData = await Promise.all(exportDataPromises);

            const dataStr = JSON.stringify(exportData, null, 2);
            const blob = new Blob([dataStr], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `ai_task_analysis_${dateFrom}_to_${dateTo}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (error) {
            console.error("Error generating AI export:", error);
            alert("Įvyko klaida generuojant AI duomenis: " + error.message);
        }
    };

    const handleExportCSV = () => {
        const escapeCSV = (str) => {
            if (str === null || str === undefined) return '""';
            const s = String(str);
            if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        };

        const formatMinutesToHHMM = (totalMinutes) => {
            if (!totalMinutes || isNaN(totalMinutes)) return "00:00";
            const hours = Math.floor(Math.abs(totalMinutes) / 60);
            const mins = Math.round(Math.abs(totalMinutes) % 60);
            const sign = totalMinutes < 0 ? "-" : "";
            return `${sign}${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        };

        const headers = [
            "Pavadinimas",
            "Aprašymas",
            "Darbuotojas",
            "Vadovas",
            "Sukūrė",
            "Būsena",
            "Prioritetas",
            "Žyma",
            "Terminas",
            "Planuotas laikas",
            "Faktinis laikas",
            "Komentarai",
            "Sukūrimo data",
            "Priskyrimo data",
            "Pradžios data",
            "Užbaigimo data",
            "Patvirtinimo data",
            "Archyvavimo data"
        ];

        const rows = tasks.map(task => {
            const realTimeMinutes = calculateCurrentTotalMinutes(task);
            const realTimeFormatted = realTimeMinutes !== 0 ? formatMinutesToHHMM(realTimeMinutes) : '00:00';
            const commentsText = task.comments ? task.comments.map(c => `${c.user}: ${c.text}`).join('; ') : '';

            return [
                escapeCSV(task.title),
                escapeCSV(task.description),
                escapeCSV(task.assignedUserName),
                escapeCSV(task.managerName),
                escapeCSV(task.creatorName),
                escapeCSV(task.status),
                escapeCSV(getPriorityLabel(task.priority)),
                escapeCSV(task.tag),
                escapeCSV(task.deadline),
                escapeCSV(task.estimatedTime),
                escapeCSV(realTimeFormatted),
                escapeCSV(commentsText),
                escapeCSV(task.createdAt ? new Date(task.createdAt).toLocaleString('lt-LT') : ''),
                escapeCSV(task.assignedAt ? new Date(task.assignedAt).toLocaleString('lt-LT') : ''),
                escapeCSV(task.startedAt ? new Date(task.startedAt).toLocaleString('lt-LT') : ''),
                escapeCSV(task.completedAt ? new Date(task.completedAt).toLocaleString('lt-LT') : ''),
                escapeCSV(task.approvedAt ? new Date(task.approvedAt).toLocaleString('lt-LT') : (task.confirmedAt ? new Date(task.confirmedAt).toLocaleString('lt-LT') : '')),
                escapeCSV(task.archivedAt ? new Date(task.archivedAt).toLocaleString('lt-LT') : '')
            ].join(',');
        });

        const csvContent = [headers.join(','), ...rows].join('\n');
        // Add BOM for Excel UTF-8 recognition
        const blob = new Blob(['\uFEFF' + csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `task_history_${dateFrom}_to_${dateTo}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
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

            await setDoc(doc(db, 'tasks', task.id), restoredTask);
            await deleteDoc(doc(db, 'archived_tasks', task.id));
        } catch (err) {
            console.error("Error restoring task:", err);
        }
    };

    const handleDelete = (task) => {
        setDeleteModalTask(task);
    };

    const confirmDelete = async ({ keepWorkHours }) => {
        if (!deleteModalTask) return;
        try {
            await deleteTask(deleteModalTask, currentUser.uid, { keepWorkHours });
            setDeleteModalTask(null);
        } catch (err) {
            console.error("Error deleting task:", err);
            alert("Nepavyko ištrinti užduoties: " + err.message);
        }
    };

    const handleConfirm = async (task) => {
        try {
            await updateDoc(doc(db, 'archived_tasks', task.id), {
                status: 'confirmed',
                timerStatus: 'stopped',
                confirmedAt: new Date().toISOString()
            });
        } catch (error) {
            console.error("Error confirming task:", error);
        }
    };

    const handleAddArchivedComment = async (text) => {
        if (!commentsModalTask) return;
        try {
            await addComment(commentsModalTask.id, text, currentUser, commentsModalTask.comments, 'archived_tasks');
            const newCommentObj = {
                text: text,
                user: currentUser.displayName || currentUser.email,
                userId: currentUser.uid,
                createdAt: new Date().toISOString()
            };

            // Update tasks array to reflect in the list immediately if expanded
            setTasks(prev => prev.map(t =>
                t.id === commentsModalTask.id
                    ? { ...t, comments: [...(t.comments || []), newCommentObj] }
                    : t
            ));

            // Update modal task so it has the new comment reference immediately
            setCommentsModalTask(prev => ({
                ...prev,
                comments: [...(prev.comments || []), newCommentObj]
            }));

        } catch (err) {
            console.error("Error adding comment to archived task:", err);
            alert("Nepavyko pridėti komentaro.");
        }
    };

    const resetFilters = () => {
        const now = getLithuanianNow();
        const startOfCurrentWeek = startOfWeek(now, { weekStartsOn: 1 });
        const start = subWeeks(startOfCurrentWeek, 1);
        setDateFrom(getLithuanianDateString(start));
        setDateTo(getLithuanianDateString(now));
        setFilterUser('all');
        setFilterTag('all');
    };

    const handleAddAdjustment = async (taskId, date, h, m, reason) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;
            const durationMinutes = (parseInt(h) || 0) * 60 + (parseInt(m) || 0);

            const now = getLithuanianNow();
            const newSessionRef = await addDoc(collection(db, 'work_sessions'), {
                taskId: task.id,
                taskTitle: `🕒 Korekcija: ${task.title}${reason ? ` - ${reason}` : ''}`,
                userId: task.assignedUserId || task.creatorId || 'unknown',
                userName: task.assignedUserName || task.creatorName || 'Nežinomas',
                startTime: new Date(date + 'T12:00:00').toISOString(),
                endTime: new Date(date + 'T12:00:00').toISOString(),
                durationMinutes: durationMinutes,
                date: date,
                createdAt: now.toISOString(),
                isManualAdjustment: true
            });

            const newAdj = {
                id: newSessionRef.id,
                date: date,
                durationMinutes: durationMinutes,
                reason: reason,
                createdAt: now.toISOString()
            };

            const collectionName = task.archivedAt ? 'archived_tasks' : 'tasks';
            await updateDoc(doc(db, collectionName, task.id), {
                timeAdjustments: [...(task.timeAdjustments || []), newAdj],
                updatedAt: new Date().toISOString()
            });

            setTasks(prev => prev.map(t =>
                t.id === task.id ? { ...t, timeAdjustments: [...(t.timeAdjustments || []), newAdj] } : t
            ));
        } catch (err) {
            console.error('Error adding adjustment:', err);
            alert('Nepavyko pridėti laiko korekcijos: ' + err.message);
        }
    };

    const handleDeleteAdjustment = async (taskId, adj) => {
        if (!window.confirm("Ar tikrai norite ištrinti šią korekciją?")) return;
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;

            await deleteDoc(doc(db, 'work_sessions', adj.id));

            const newAdjustments = (task.timeAdjustments || []).filter(a => a.id !== adj.id);
            const collectionName = task.archivedAt ? 'archived_tasks' : 'tasks';
            await updateDoc(doc(db, collectionName, task.id), {
                timeAdjustments: newAdjustments,
                updatedAt: new Date().toISOString()
            });

            setTasks(prev => prev.map(t =>
                t.id === task.id ? { ...t, timeAdjustments: newAdjustments } : t
            ));
        } catch (err) {
            console.error('Error deleting adjustment:', err);
            alert('Nepavyko ištrinti korekcijos.');
        }
    };

    if (loading && tasks.length === 0) {
        return <div className="p-8 text-center text-gray-500">Kraunama istorija...</div>;
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                    Užduočių istorija <span className="text-gray-500 text-sm font-normal">({tasks.length})</span>
                </h2>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleExportCSV}
                        className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium"
                    >
                        <FileText className="w-4 h-4" />
                        Atsisiųsti (CSV)
                    </button>
                    <button
                        onClick={handleExport}
                        className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium"
                    >
                        <Download className="w-4 h-4" />
                        Atsisiųsti AI analizei (JSON)
                    </button>
                </div>
            </div>

            {/* Filters */}
            <div className="bg-gray-50 p-4 rounded-xl border border-gray-200 flex flex-col md:flex-row gap-4 items-end md:items-center flex-wrap">

                {/* Date Range */}
                <div className="flex items-center gap-2">
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] uppercase font-bold text-gray-500">Nuo</label>
                        <input
                            type="date"
                            value={dateFrom}
                            onChange={(e) => setDateFrom(e.target.value)}
                            className="bg-white border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full px-2.5 py-1.5"
                        />
                    </div>
                    <span className="text-gray-400 mt-5">-</span>
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] uppercase font-bold text-gray-500">Iki</label>
                        <input
                            type="date"
                            value={dateTo}
                            onChange={(e) => setDateTo(e.target.value)}
                            max={getLithuanianDateString()}
                            className="bg-white border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full px-2.5 py-1.5"
                        />
                    </div>
                </div>

                {/* User Filter (Manager Only) */}
                {(isManagerOrAdmin && userId === 'all') && (
                    <div className="flex flex-col gap-1 min-w-[150px]">
                        <label className="text-[10px] uppercase font-bold text-gray-500">Darbuotojas</label>
                        <select
                            value={filterUser}
                            onChange={(e) => setFilterUser(e.target.value)}
                            className="bg-white border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full px-2.5 py-1.5"
                        >
                            <option value="all">Visi</option>
                            {users.map(u => (
                                <option key={u.id} value={u.id}>
                                    {formatDisplayName(u.displayName || u.email)}
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                {/* Tag Filter */}
                <div className="flex flex-col gap-1 min-w-[120px]">
                    <label className="text-[10px] uppercase font-bold text-gray-500">Žyma</label>
                    <select
                        value={filterTag}
                        onChange={(e) => setFilterTag(e.target.value)}
                        className="bg-white border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full px-2.5 py-1.5"
                    >
                        <option value="all">Visos</option>
                        {TASK_TAGS.map(tag => (
                            <option key={tag} value={tag}>{tag}</option>
                        ))}
                    </select>
                </div>

                {/* Sort By */}
                <div className="flex flex-col gap-1 min-w-[120px]">
                    <label className="text-[10px] uppercase font-bold text-gray-500">Rikiuoti</label>
                    <div className="relative">
                        <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value)}
                            className="bg-white border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full px-2.5 py-1.5 pl-8"
                        >
                            <option value="date">Pagal datą</option>
                            <option value="status">Pagal būseną</option>
                        </select>
                        <Filter className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 transform -translate-y-1/2" />
                    </div>
                </div>

                {/* Reset Button */}
                <button
                    onClick={resetFilters}
                    className="md:ml-auto p-2 text-gray-500 hover:text-red-500 hover:bg-gray-100 rounded-lg transition-colors"
                    title="Išvalyti filtrus"
                >
                    <RotateCcw className="w-5 h-5" />
                </button>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 table-fixed">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-2 py-2 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider min-w-[200px] w-auto">UŽDUOTIS</th>
                                <th className="px-1 py-2 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider w-16">DARB.</th>
                                <th className="px-1 py-2 text-right text-[10px] font-bold text-gray-500 uppercase tracking-wider w-24">PLAN. / TIKRAS</th>
                                <th className="px-1 py-2 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider w-16">PRIO</th>
                                <th className="px-1 py-2 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wider w-16">BŪSENA</th>
                                <th className="px-1 py-2 text-right text-[10px] font-bold text-gray-500 uppercase tracking-wider w-24"></th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {tasks.map((task) => (
                                <tr key={task.id} className="group hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-0">
                                    <td className="px-2 py-2" onClick={() => toggleExpand(task.id)}>
                                        <div className={clsx(
                                            "text-sm font-bold text-gray-900 whitespace-normal break-words",
                                            (task.isDeleted || task.status === 'deleted') && "line-through text-gray-500"
                                        )}>
                                            {task.title}
                                            {task.tag && (
                                                <span className="ml-2 inline-block px-1.5 py-0.5 text-[9px] font-medium bg-blue-50 text-blue-600 rounded border border-blue-100 align-middle">
                                                    {task.tag}
                                                </span>
                                            )}
                                        </div>
                                        {task.deadline && (
                                            <div className="text-[9px] text-gray-500 flex items-center gap-1 mt-0.5 whitespace-nowrap">
                                                <Calendar className="w-2.5 h-2.5" />
                                                <span>{task.deadline}</span>
                                                <span className="text-gray-300">|</span>
                                                <span>Archyvuota: {new Date(task.archivedAt).toLocaleDateString()}</span>
                                            </div>
                                        )}
                                        {!task.deadline && (
                                            <div className="text-[9px] text-gray-500 flex items-center gap-1 mt-0.5 whitespace-nowrap">
                                                <span>Archyvuota: {new Date(task.archivedAt).toLocaleDateString()}</span>
                                            </div>
                                        )}
                                        {task.description && (
                                            <div className={clsx(
                                                "text-[10px] text-gray-500 mt-0.5 flex items-start gap-1 cursor-pointer hover:text-gray-700 whitespace-normal break-words",
                                                expandedTasks.has(task.id) ? "whitespace-pre-wrap" : ""
                                            )}>
                                                <SessionTypeIcon
                                                    type={task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : 'task')}
                                                    className="w-3 h-3 flex-shrink-0 mt-0.5"
                                                />
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
                                                <UserCheck className="w-2.5 h-2.5" />
                                                <span>Vadovas: {formatDisplayName(task.managerName || task.creatorName)}</span>
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap align-top">
                                        {task.assignedUserName && (
                                            <span className="px-2 py-1 rounded-full text-[10px] font-medium bg-gray-100 text-gray-700 border border-gray-200">
                                                {formatDisplayName(task.assignedUserName).split(' ')[0]}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap text-right text-[10px] font-medium text-gray-900 align-top font-mono">
                                        <>
                                            <span className="text-blue-600">{task.estimatedTime || '-'}</span>
                                            <span className="text-gray-400 mx-1">/</span>
                                            <span className="text-gray-900">{calculateCurrentTotalMinutes(task) !== 0 ? formatMinutesToTimeString(calculateCurrentTotalMinutes(task)) : '-'}</span>
                                            {userRole === 'admin' && (
                                                <button onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'timeAdjustments', taskId: task.id }); }} className="text-blue-500 hover:text-blue-700 ml-1 inline-flex" title="Koreguoti laiką">
                                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                </button>
                                            )}
                                        </>
                                        {task.timeChanged && (
                                            <div className="text-red-600 font-bold text-[10px] uppercase tracking-wide mt-0.5">⚠ Pakeistas laikas</div>
                                        )}
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap align-top">
                                        <span
                                            className={clsx(
                                                "px-1.5 py-0.5 inline-flex text-[9px] leading-3 font-semibold rounded-md border border-black/5 uppercase"
                                            )}
                                            style={{
                                                backgroundColor: getPriorityColor(task.priority),
                                                color: getPriorityTextColor(task.priority)
                                            }}
                                        >
                                            {getPriorityLabel(task.priority)}
                                        </span>
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap align-top">
                                        <div className="flex items-center gap-1">
                                            {(task.isDeleted || task.status === 'deleted') ? (
                                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-800 border border-red-200">
                                                    Ištrinta
                                                </span>
                                            ) : task.status === 'confirmed' ? (
                                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-800 border border-green-200">
                                                    Patvirt.
                                                </span>
                                            ) : (
                                                <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-800">
                                                    Nepatv.
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap text-right text-xs font-medium align-top">
                                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            {task.status !== 'confirmed' && (isManagerOrAdmin) && (
                                                <button
                                                    onClick={() => handleConfirm(task)}
                                                    className="p-1 text-green-600 hover:bg-green-50 rounded"
                                                    title="Patvirtinti"
                                                >
                                                    <UserCheck className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                            <button
                                                onClick={() => setCommentsModalTask(task)}
                                                className="p-1 text-gray-600 hover:bg-gray-50 rounded relative"
                                                title="Komentarai"
                                            >
                                                <MessageCircle className="w-3.5 h-3.5" />
                                                {task.comments?.length > 0 && (
                                                    <span className="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 text-white text-[8px] font-bold flex items-center justify-center rounded-full leading-none truncate">
                                                        {task.comments.length}
                                                    </span>
                                                )}
                                            </button>
                                            <button
                                                onClick={() => handleRestore(task)}
                                                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                                                title="Grąžinti"
                                            >
                                                <RotateCcw className="w-3.5 h-3.5" />
                                            </button>
                                            {(isManagerOrAdmin) && (
                                                <button
                                                    onClick={() => handleDelete(task)}
                                                    className="p-1 text-red-600 hover:bg-red-50 rounded"
                                                    title="Ištrinti"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            )}

                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {tasks.length === 0 && (
                                <tr>
                                    <td colSpan="7" className="px-6 py-12 text-center text-gray-500 text-sm">
                                        <span>Istorija tuščia pagal pasirinktus filtrus.</span>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
            <DeleteConfirmationModal
                isOpen={!!deleteModalTask}
                onClose={() => setDeleteModalTask(null)}
                onConfirm={confirmDelete}
                taskTitle={deleteModalTask?.title}
            />
            <CommentsModal
                isOpen={!!commentsModalTask}
                onClose={() => setCommentsModalTask(null)}
                comments={commentsModalTask?.comments || []}
                onAddComment={handleAddArchivedComment}
            />
            {activeModal.taskId && (() => {
                const task = tasks.find(t => t.id === activeModal.taskId);
                if (!task) return null;
                return (
                    <TimeAdjustmentsModal
                        isOpen={activeModal.type === 'timeAdjustments'}
                        onClose={() => setActiveModal({ type: null, taskId: null })}
                        task={task}
                        onAddAdjustment={handleAddAdjustment}
                        onDeleteAdjustment={handleDeleteAdjustment}
                    />
                );
            })()}
        </div>
    );
}
