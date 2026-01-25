import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, orderBy, onSnapshot, deleteDoc, doc, setDoc } from 'firebase/firestore';
import { FileText, Download, Trash2, RotateCcw, Calendar, UserCheck, CheckCircle2, Briefcase } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { updateDoc } from 'firebase/firestore';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import clsx from 'clsx';

export default function TaskHistory() {
    const { userRole } = useAuth();
    const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin';
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);
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
        const q = query(collection(db, 'archived_tasks'), orderBy('archivedAt', 'desc'));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const tasksData = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setTasks(tasksData);
            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    const handleExport = () => {
        // Prepare data for export - remove internal IDs if needed, or keep them
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
                    // We don't have current user in this scope but we can get it from context or just leave blank/admin implication
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
            // Restore to tasks with reset status and metadata
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
                updatedAt: new Date().toISOString()
            };

            await setDoc(doc(db, 'tasks', task.id), restoredTask);

            // Delete from archived_tasks
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

    if (loading) {
        return <div className="p-8 text-center text-gray-500">Kraunama istorija...</div>;
    }

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold text-gray-900">Užduočių istorija ({tasks.length})</h2>
                <button
                    onClick={handleExport}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                >
                    <Download className="w-4 h-4" />
                    Atsisiųsti AI analizei (JSON)
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
                                        <div className="text-sm font-bold text-gray-900 whitespace-normal break-words">
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
                                            {task.status === 'confirmed' ? (
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
                                        Istorija tuščia
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
