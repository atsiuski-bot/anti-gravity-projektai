import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, orderBy, onSnapshot, deleteDoc, doc, setDoc, where } from 'firebase/firestore';
import { FileText, Download, Trash2, RotateCcw, Calendar, UserCheck, CheckCircle2, Briefcase, ChevronDown } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { updateDoc } from 'firebase/firestore';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import clsx from 'clsx';
import { startOfWeek, subWeeks, startOfDay } from 'date-fns';

export default function TaskHistory({ userId }) {
    const { userRole } = useAuth();
    const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin';
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedTasks, setExpandedTasks] = useState(new Set());

    // Pagination state: Default to 2 weeks (Current + Last)
    const [weeksToShow, setWeeksToShow] = useState(2);
    const [startDate, setStartDate] = useState(null);

    const toggleExpand = (taskId) => {
        const newExpanded = new Set(expandedTasks);
        if (newExpanded.has(taskId)) {
            newExpanded.delete(taskId);
        } else {
            newExpanded.add(taskId);
        }
        setExpandedTasks(newExpanded);
    };

    // Calculate start date when weeksToShow changes
    useEffect(() => {
        const now = new Date();
        // Start of current week (Monday)
        const startOfCurrentWeek = startOfWeek(now, { weekStartsOn: 1 });
        // Subtract weeks to get the start date window
        // weeksToShow = 2 -> Current Week + 1 Previous Week
        // So we subtract 1 week from startOfCurrentWeek
        const start = subWeeks(startOfCurrentWeek, weeksToShow - 1);

        // Ensure we set time to 00:00:00 explicitly if not already (startOfWeek returns Date at 00:00 usually, but checking `startOfDay` is safer)
        const startDay = startOfDay(start);

        // Use ISO String for Firestore comparison (assuming archivedAt is stored as ISO string)
        setStartDate(startDay.toISOString());
    }, [weeksToShow]);

    useEffect(() => {
        if (!startDate) return;

        setLoading(true);
        // Query tasks archived AFTER the calculated start date
        // Note: Filters by 'archivedAt'. 
        const q = userId && userId !== 'all'
            ? query(
                collection(db, 'archived_tasks'),
                where('archivedAt', '>=', startDate),
                where('assignedWorkerId', '==', userId),
                orderBy('archivedAt', 'desc')
            )
            : query(
                collection(db, 'archived_tasks'),
                where('archivedAt', '>=', startDate),
                orderBy('archivedAt', 'desc')
            );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const tasksData = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            // Sort manually just in case
            const sortedTasks = [...tasksData].sort((a, b) => {
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
    }, [startDate, userId]);

    const handleLoadMore = () => {
        setWeeksToShow(prev => prev + 1);
    };

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
        link.download = `task_history_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleDelete = async (taskId) => {
        if (!window.confirm('Ar tikrai norite ištrinti šį įrašą?')) return;
        try {
            const taskToDelete = tasks.find(t => t.id === taskId);
            if (taskToDelete) {
                const { id, ...taskData } = taskToDelete;
                await setDoc(doc(db, 'deleted_tasks', taskId), {
                    ...taskData,
                    deletedAt: new Date().toISOString(),
                    deletedFromHistory: true,
                    originalCollection: 'archived_tasks'
                });
            }
            await deleteDoc(doc(db, 'archived_tasks', taskId));
        } catch (err) {
            console.error("Error deleting archived task:", err);
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

    if (loading && tasks.length === 0) {
        return <div className="p-8 text-center text-gray-500">Kraunama istorija...</div>;
    }

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold text-gray-900">Užduočių istorija ({tasks.length})</h2>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">
                        {weeksToShow === 1 ? 'Ši savaitė' : `Paskutinės ${weeksToShow} savaitės`}
                    </span>
                    <button
                        onClick={handleExport}
                        className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                    >
                        <Download className="w-4 h-4" />
                        Atsisiųsti AI analizei (JSON)
                    </button>
                </div>
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
                                    </td>
                                    <td className="px-1 py-2 whitespace-nowrap align-top">
                                        {task.assignedWorkerName && (
                                            <span className="px-2 py-1 rounded-full text-[10px] font-medium bg-gray-100 text-gray-700 border border-gray-200">
                                                {task.assignedWorkerName.split(' ')[0]}
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
                                            <button
                                                onClick={() => handleDelete(task.id)}
                                                className="p-1 text-red-600 hover:bg-red-50 rounded"
                                                title="Ištrinti negrįžtamai"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {tasks.length === 0 && (
                                <tr>
                                    <td colSpan="7" className="px-6 py-12 text-center text-gray-500 text-sm">
                                        {weeksToShow > 5 ? (
                                            <span>Istorija tuščia (rodome {weeksToShow} sav.)</span>
                                        ) : (
                                            <span>Istorija tuščia. Pabandykite "Rodyti daugiau" jei ieškote senesnių užduočių.</span>
                                        )}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Show More Button - Styled for Mobile Visibility */}
            <div className="flex justify-start pt-4 pb-[250px]">
                <button
                    onClick={handleLoadMore}
                    disabled={loading}
                    className="flex items-center gap-2 px-6 py-3 bg-white border border-gray-300 shadow-md text-gray-700 font-bold rounded-xl hover:bg-gray-50 hover:shadow-lg active:scale-95 transition-all text-sm group"
                >
                    {loading ? (
                        <span>Kraunama...</span>
                    ) : (
                        <>
                            <span>Rodyti daugiau</span>
                            <ChevronDown className="w-5 h-5 text-gray-400 group-hover:text-gray-600 transition-colors" />
                        </>
                    )}
                </button>
                <div className="text-xs text-gray-400 ml-4 mt-3">
                    (+1 savaitė)
                </div>
            </div>
        </div>
    );
}
