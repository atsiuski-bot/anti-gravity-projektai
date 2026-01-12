import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, orderBy, onSnapshot, deleteDoc, doc, setDoc } from 'firebase/firestore';
import { FileText, Download, Trash2, RotateCcw, Calendar, UserCheck, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { updateDoc } from 'firebase/firestore';
import clsx from 'clsx';

export default function TaskHistory() {
    const { userRole } = useAuth();
    const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin';
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);

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
        if (!window.confirm('Ar tikrai norite negrįžtamai ištrinti šį įrašą?')) return;
        try {
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
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[35%]">Užduotis</th>
                                <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-24">Darb.</th>
                                <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-20">Prior.</th>
                                <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-20">Būsena</th>
                                <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-24">Archyvuota</th>
                                <th className="px-2 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider w-32">Veiksmai</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {tasks.map((task) => (
                                <tr key={task.id} className="hover:bg-gray-50 transition-colors">
                                    <td className="px-3 py-3">
                                        <div className="text-sm font-medium text-gray-900 truncate">
                                            {task.title}
                                        </div>
                                        {task.deadline && (
                                            <div className="text-[10px] text-gray-500 flex items-center gap-1 mt-0.5">
                                                <Calendar className="w-3 h-3" />
                                                {task.deadline}
                                            </div>
                                        )}
                                        {task.description && (
                                            <div className="text-xs text-gray-500 line-clamp-1 mt-0.5 flex items-center gap-1">
                                                <FileText className="w-3 h-3 flex-shrink-0" />
                                                {task.description}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap">
                                        {task.assignedWorkerName && (
                                            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-800 border border-gray-200 truncate max-w-[80px] inline-block">
                                                {task.assignedWorkerName.split(' ')[0]}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap">
                                        <span className={clsx(
                                            "px-1.5 py-0.5 inline-flex text-[10px] leading-4 font-semibold rounded-md",
                                            task.priority === 'Urgent' ? 'bg-yellow-50 text-black border border-yellow-200' :
                                                task.priority === 'High' ? 'bg-gray-200 text-gray-800' :
                                                    task.priority === 'Medium' ? 'bg-gray-500 text-white' :
                                                        'bg-gray-800 text-white'
                                        )}>
                                            {task.priority}
                                        </span>
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap">
                                        <div className="flex items-center gap-1">
                                            {task.status === 'confirmed' ? (
                                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-800 border border-green-200 flex items-center gap-1">
                                                    <CheckCircle2 className="w-2.5 h-2.5" />
                                                    OK
                                                </span>
                                            ) : (
                                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-800 border border-blue-200">
                                                    Atlikta
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap text-[10px] text-gray-500">
                                        {new Date(task.archivedAt).toLocaleDateString()}
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap text-right text-xs font-medium">
                                        <div className="flex items-center justify-end gap-2">
                                            {task.status !== 'confirmed' && (isManagerOrAdmin) && (
                                                <button
                                                    onClick={() => handleConfirm(task)}
                                                    className="text-green-600 hover:text-green-900"
                                                    title="Patvirtinti"
                                                >
                                                    <UserCheck className="w-4 h-4" />
                                                </button>
                                            )}
                                            <button
                                                onClick={() => handleRestore(task)}
                                                className="text-blue-600 hover:text-blue-900"
                                                title="Grąžinti"
                                            >
                                                <RotateCcw className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => handleDelete(task.id)}
                                                className="text-red-600 hover:text-red-900"
                                                title="Ištrinti negrįžtamai"
                                            >
                                                <Trash2 className="w-4 h-4" />
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
