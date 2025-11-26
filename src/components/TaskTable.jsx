import React, { useState } from 'react';
import clsx from 'clsx';
import { db } from '../firebase';
import { doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { Link as LinkIcon, MessageCircle, FileText, CheckCircle2, MessageSquare } from 'lucide-react';
import { LinksModal, CommentsModal, DescriptionModal } from './TaskDetailsModals';

export default function TaskTable({ tasks, onEdit, role }) {
    const { currentUser } = useAuth();
    const [expandedComments, setExpandedComments] = useState({});
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null }); // { type: 'description'|'links'|'comments', taskId: string }

    const priorityColors = {
        Low: 'bg-green-100 text-green-800',
        Medium: 'bg-yellow-100 text-yellow-800',
        High: 'bg-orange-100 text-orange-800',
        Urgent: 'bg-red-100 text-red-800'
    };

    const priorityLabels = {
        Low: 'Žemas',
        Medium: 'Vidutinis',
        High: 'Aukštas',
        Urgent: 'Skubus'
    };

    const statusColors = {
        'pending': 'bg-white text-gray-800 border border-gray-200',
        'in-progress': 'bg-white text-gray-800 border border-gray-200',
        'completed': 'bg-gray-200 text-gray-800',
        'confirmed': 'bg-green-100 text-gray-800'
    };

    const statusLabels = {
        'pending': 'Nepradėtas',
        'in-progress': 'Pradėtas',
        'completed': 'Užbaigtas, nepriduotas',
        'confirmed': 'Užbaigtas, priduotas'
    };

    const handleToggleComplete = async (taskId, currentStatus) => {
        try {
            const taskRef = doc(db, 'tasks', taskId);
            await updateDoc(taskRef, {
                completed: !currentStatus,
                completedAt: !currentStatus ? new Date().toISOString() : null,
                completedBy: !currentStatus ? currentUser.uid : null,
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            console.error("Error toggling task completion:", err);
        }
    };

    const handleConfirmTask = async (taskId) => {
        try {
            const taskRef = doc(db, 'tasks', taskId);
            await updateDoc(taskRef, {
                status: 'confirmed',
                confirmedBy: currentUser.uid,
                confirmedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            console.error("Error confirming task:", err);
        }
    };

    const getStatusStyle = (task) => {
        const status = task.status || 'pending';
        if (status === 'confirmed') return 'bg-green-50';
        if (status === 'completed') return 'bg-gray-100';
        return 'bg-white';
    };

    const toggleComments = (taskId) => {
        setExpandedComments(prev => ({
            ...prev,
            [taskId]: !prev[taskId]
        }));
    };

    const isWorker = role === 'worker';

    return (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 table-fixed">
                    <thead className="bg-gray-50">
                        <tr>
                            {isWorker && (
                                <th className="px-2 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-10">
                                    ✓
                                </th>
                            )}
                            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[40%]">Užduotis</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-24">Darb.</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-20">Diena</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-20">Prior.</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-28">Būsena</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Num.</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Fakt.</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-20">Info</th>
                            {!isWorker && <th className="px-2 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Patv.</th>}
                            <th className="px-2 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider w-20">Veik.</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {tasks.map((task) => (
                            <React.Fragment key={task.id}>
                                <tr className={clsx(
                                    "transition-colors",
                                    getStatusStyle(task),
                                    !task.completed && "hover:bg-gray-50"
                                )}>
                                    {isWorker && (
                                        <td className="px-2 py-3 text-center">
                                            <input
                                                type="checkbox"
                                                checked={task.completed || false}
                                                onChange={() => handleToggleComplete(task.id, task.completed)}
                                                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                                            />
                                        </td>
                                    )}
                                    <td className="px-3 py-3">
                                        <div className={clsx(
                                            "text-sm font-medium truncate",
                                            task.completed ? "text-gray-500 line-through" : "text-gray-900"
                                        )}>
                                            {task.title}
                                        </div>
                                        {task.description && (
                                            <button
                                                onClick={() => setActiveModal({ type: 'description', taskId: task.id })}
                                                className="text-xs text-gray-600 hover:text-gray-900 hover:underline line-clamp-2 text-left w-full mt-0.5"
                                            >
                                                <FileText className="w-3 h-3 inline mr-1 flex-shrink-0" />
                                                {task.description}
                                            </button>
                                        )}
                                        {task.completed && task.completedAt && (
                                            <div className="text-[10px] text-gray-400 mt-1">
                                                {new Date(task.completedAt).toLocaleDateString()}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap">
                                        {task.assignedWorkerName && (
                                            <div
                                                className="inline-flex items-center justify-center p-[3px] rounded-full"
                                                style={{ backgroundColor: task.assignedWorkerColor || '#3b82f6' }}
                                            >
                                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-white text-gray-800 border border-white/50 max-w-[80px] truncate">
                                                    {task.assignedWorkerName.split(' ')[0]}
                                                </span>
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap">
                                        {task.dayOfWeek && (
                                            <span className="px-1.5 py-0.5 inline-flex text-[10px] leading-4 font-semibold rounded-md bg-blue-50 text-blue-700">
                                                {task.dayOfWeek.substring(0, 3)}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap">
                                        <span className={clsx(
                                            "px-1.5 py-0.5 inline-flex text-[10px] leading-4 font-semibold rounded-md",
                                            priorityColors[task.priority] || priorityColors.Medium
                                        )}>
                                            {priorityLabels[task.priority] || task.priority}
                                        </span>
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap">
                                        <span className={clsx(
                                            "px-1.5 py-0.5 inline-flex text-[10px] leading-4 font-semibold rounded-full max-w-[100px] truncate",
                                            statusColors[task.status || 'pending']
                                        )}>
                                            {statusLabels[task.status || 'pending']}
                                        </span>
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap text-xs text-gray-500">
                                        {task.estimatedTime || '-'}
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap text-xs text-gray-500">
                                        {task.actualTime || '-'}
                                    </td>
                                    <td className="px-2 py-3 text-xs">
                                        <div className="flex gap-1">
                                            {task.links && task.links.length > 0 && (
                                                <button
                                                    onClick={() => setActiveModal({ type: 'links', taskId: task.id })}
                                                    className="flex items-center text-blue-600 hover:text-blue-800"
                                                    title="Nuorodos"
                                                >
                                                    <LinkIcon className="w-3 h-3" />
                                                    <span className="ml-0.5">{task.links.length}</span>
                                                </button>
                                            )}
                                            {task.comments && task.comments.length > 0 && (
                                                <button
                                                    onClick={() => setActiveModal({ type: 'comments', taskId: task.id })}
                                                    className="flex items-center text-green-600 hover:text-green-800"
                                                    title="Komentarai"
                                                >
                                                    <MessageSquare className="w-3 h-3" />
                                                    <span className="ml-0.5">{task.comments.length}</span>
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                    {!isWorker && (
                                        <td className="px-2 py-3 text-center">
                                            {task.status === 'completed' && task.status !== 'confirmed' && (
                                                <input
                                                    type="checkbox"
                                                    checked={false}
                                                    onChange={() => handleConfirmTask(task.id)}
                                                    className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500 cursor-pointer"
                                                />
                                            )}
                                            {task.status === 'confirmed' && (
                                                <span className="inline-flex items-center text-green-600">
                                                    <CheckCircle2 className="w-4 h-4" />
                                                </span>
                                            )}
                                        </td>
                                    )}
                                    <td className="px-2 py-3 whitespace-nowrap text-right text-xs font-medium">
                                        <button
                                            onClick={() => onEdit(task)}
                                            className="text-blue-600 hover:text-blue-900"
                                        >
                                            Redaguoti
                                        </button>
                                    </td>
                                </tr>
                            </React.Fragment>
                        ))}
                    </tbody>
                </table>
            </div>
            {/* Modals */}
            {activeModal.taskId && (() => {
                const task = tasks.find(t => t.id === activeModal.taskId);
                if (!task) return null;

                return (
                    <>
                        <DescriptionModal
                            isOpen={activeModal.type === 'description'}
                            onClose={() => setActiveModal({ type: null, taskId: null })}
                            description={task.description}
                        />
                        <LinksModal
                            isOpen={activeModal.type === 'links'}
                            onClose={() => setActiveModal({ type: null, taskId: null })}
                            links={task.links}
                        />
                        <CommentsModal
                            isOpen={activeModal.type === 'comments'}
                            onClose={() => setActiveModal({ type: null, taskId: null })}
                            comments={task.comments}
                        />
                    </>
                );
            })()}
        </div>
    );
}
