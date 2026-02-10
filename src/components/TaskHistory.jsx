import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, orderBy, onSnapshot, deleteDoc, doc, setDoc, where } from 'firebase/firestore';
import { FileText, Download, RotateCcw, Calendar, UserCheck, CheckCircle2, Briefcase, ChevronDown, Filter, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { updateDoc } from 'firebase/firestore';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import clsx from 'clsx';
import { startOfWeek, subWeeks, startOfDay, endOfDay, format } from 'date-fns';
import { formatDisplayName } from '../utils/formatters';
import { TASK_TAGS } from '../utils/taskUtils';
import { getLithuanianDateString, getLithuanianNow } from '../utils/timeUtils';

export default function TaskHistory({ userId, users = [] }) {
    const { userRole, currentUser } = useAuth();
    const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin';
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedTasks, setExpandedTasks] = useState(new Set());

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

        if (targetUserId !== 'all') {
            constraints.splice(1, 0, where('assignedWorkerId', '==', targetUserId));
        }

        q = query(collection(db, 'archived_tasks'), ...constraints);

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const tasksData = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            // Client-side filtering for Tag (Firestore limitation on multiple inequality/array-contains with inequalities)
            // And any other refinement
            const filteredTasks = tasksData.filter(task => {
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

    const handleExport = () => {
        const exportData = tasks.map(task => ({
            Title: task.title,
            Description: task.description,
            Worker: task.assignedWorkerName,
            Priority: task.priority,
            Status: task.status,
            EstimatedTime: task.estimatedTime,
            CompletedAt: task.completedAt,
            ConfirmedAt: task.confirmedAt,
            ArchivedAt: task.archivedAt,
            Comments: task.comments ? task.comments.map(c => `${c.user}: ${c.text}`).join('; ') : ''
        }));

        const dataStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `task_history_${dateFrom}_to_${dateTo}.json`;
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

    const resetFilters = () => {
        const now = getLithuanianNow();
        const startOfCurrentWeek = startOfWeek(now, { weekStartsOn: 1 });
        const start = subWeeks(startOfCurrentWeek, 1);
        setDateFrom(getLithuanianDateString(start));
        setDateTo(getLithuanianDateString(now));
        setFilterUser('all');
        setFilterTag('all');
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
                                                <Briefcase className="w-2.5 h-2.5 flex-shrink-0 mt-0.5" />
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
                                        {task.assignedWorkerName && (
                                            <span className="px-2 py-1 rounded-full text-[10px] font-medium bg-gray-100 text-gray-700 border border-gray-200">
                                                {formatDisplayName(task.assignedWorkerName).split(' ')[0]}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap text-right text-[10px] font-medium text-gray-900 align-top font-mono">
                                        <span className="text-blue-600">{task.estimatedTime || '-'}</span>
                                        <span className="text-gray-400 mx-1">/</span>
                                        <span className="text-gray-900">{task.actualTime || '-'}</span>
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
                                                onClick={() => handleRestore(task)}
                                                className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                                                title="Grąžinti"
                                            >
                                                <RotateCcw className="w-3.5 h-3.5" />
                                            </button>

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
        </div>
    );
}
