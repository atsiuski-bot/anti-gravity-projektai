import React, { useState } from 'react';
import { Clock, AlertCircle, CheckCircle2, Circle, Link as LinkIcon, MessageCircle, FileText } from 'lucide-react';
import clsx from 'clsx';
import { db } from '../firebase';
import { doc, updateDoc, getDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { LinksModal, CommentsModal, DescriptionModal } from './TaskDetailsModals';

export default function TaskCard({ task, onEdit, role }) {
    const { currentUser } = useAuth();
    const [showComments, setShowComments] = useState(false);
    const [activeModal, setActiveModal] = useState(null); // 'description', 'links', 'comments'
    // Use color from props (enriched in ManagerView) or fallback to internal fetch if not present (for Worker view compatibility)
    // Note: In ManagerView, task.assignedWorkerColor is now provided.
    const displayColor = task.assignedWorkerColor || workerColor;

    React.useEffect(() => {
        // Only fetch if not provided in props and we have an ID
        if (!task.assignedWorkerColor && task.assignedWorkerId && !workerColor) {
            const fetchWorkerColor = async () => {
                try {
                    const userDoc = await getDoc(doc(db, 'users', task.assignedWorkerId));
                    if (userDoc.exists()) {
                        setWorkerColor(userDoc.data().color);
                    }
                } catch (err) {
                    console.error("Error fetching worker color:", err);
                }
            };
            fetchWorkerColor();
        }
    }, [task.assignedWorkerId, task.assignedWorkerColor]);

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

    const statusIcons = {
        'Todo': <Circle className="w-4 h-4 text-gray-400" />,
        'In Progress': <Clock className="w-4 h-4 text-blue-500" />,
        'Done': <CheckCircle2 className="w-4 h-4 text-green-500" />
    };

    const statusLabels = {
        'Todo': 'Atlikti',
        'In Progress': 'Vykdoma',
        'Done': 'Atlikta'
    };

    const handleToggleComplete = async (e) => {
        e.stopPropagation();
        try {
            const taskRef = doc(db, 'tasks', task.id);
            await updateDoc(taskRef, {
                completed: !task.completed,
                completedAt: !task.completed ? new Date().toISOString() : null,
                completedBy: !task.completed ? currentUser.uid : null
            });
        } catch (err) {
            console.error("Error toggling task completion:", err);
        }
    };

    const isWorker = role === 'worker';

    return (
        <div
            className={clsx(
                "bg-white p-4 rounded-xl shadow-sm border border-gray-200 transition-all",
                task.completed ? "bg-gray-50 opacity-75" : "active:scale-[0.99]",
                !task.completed && "cursor-pointer"
            )}
        >
            <div className="flex items-start gap-3">
                {/* Completion Checkbox (Worker only) */}
                {isWorker && (
                    <input
                        type="checkbox"
                        checked={task.completed || false}
                        onChange={handleToggleComplete}
                        className="mt-1 w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    />
                )}

                <div className="flex-1" onClick={!task.completed ? onEdit : undefined}>
                    {/* Header */}
                    <div className="flex justify-between items-start mb-3">
                        <h3
                            className={clsx(
                                "font-semibold line-clamp-1 flex-1 px-2 py-1 rounded",
                                task.completed ? "text-gray-500 line-through" : "text-gray-900"
                            )}
                            style={{
                                backgroundColor: !task.completed && displayColor ? displayColor : 'transparent',
                                color: !task.completed && displayColor ? '#fff' : undefined,
                                textShadow: !task.completed && displayColor ? '0 1px 2px rgba(0,0,0,0.3)' : 'none'
                            }}
                        >
                            {task.title}
                        </h3>
                        <span className={clsx(
                            "px-2 py-1 rounded-full text-xs font-medium ml-2",
                            priorityColors[task.priority] || priorityColors.Medium
                        )}>
                            {priorityLabels[task.priority] || task.priority}
                        </span>
                    </div>

                    {/* Day of Week Badge */}
                    <div className="flex flex-wrap gap-2 mb-2">
                        {task.dayOfWeek && (
                            <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-blue-50 text-blue-700">
                                {task.dayOfWeek}
                            </span>
                        )}
                        {task.assignedWorkerName && (
                            <div
                                className="inline-flex items-center justify-center p-[4px] rounded-full"
                                style={{ backgroundColor: displayColor || '#3b82f6' }}
                            >
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-white text-gray-800 border border-white/50">
                                    👤 {task.assignedWorkerName}
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Description */}
                    {task.description && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setActiveModal('description');
                            }}
                            className={clsx(
                                "text-sm text-left line-clamp-2 mb-3 hover:underline w-full",
                                task.completed ? "text-gray-400" : "text-gray-600"
                            )}
                        >
                            <FileText className="w-3 h-3 inline mr-1" />
                            {task.description}
                        </button>
                    )}

                    {/* Status and Time */}
                    <div className="flex items-center justify-between text-sm mb-3">
                        <div className={clsx(
                            "flex items-center gap-2",
                            task.completed ? "text-gray-400" : "text-gray-600"
                        )}>
                            {statusIcons[task.status]}
                            <span>{statusLabels[task.status] || task.status}</span>
                        </div>

                        {(task.estimatedTime || task.actualTime) && (
                            <div className="text-xs text-gray-400">
                                {task.estimatedTime && <span>Num: {task.estimatedTime}</span>}
                                {task.estimatedTime && task.actualTime && <span className="mx-1">/</span>}
                                {task.actualTime && <span>Fakt: {task.actualTime}</span>}
                            </div>
                        )}
                    </div>

                    {/* Links */}
                    {task.links && task.links.length > 0 && (
                        <div className="mb-3">
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveModal('links');
                                }}
                                className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 hover:underline"
                            >
                                <LinkIcon className="w-4 h-4" />
                                {task.links.length} {task.links.length === 1 ? 'nuoroda' : 'nuorodos'}
                            </button>
                        </div>
                    )}

                    {/* Comments */}
                    {task.comments && task.comments.length > 0 && (
                        <div className="border-t border-gray-100 pt-3">
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveModal('comments');
                                }}
                                className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 hover:underline"
                            >
                                <MessageCircle className="w-4 h-4" />
                                <span>{task.comments.length} {task.comments.length === 1 ? 'komentaras' : 'komentarai'}</span>
                            </button>
                        </div>
                    )}

                    {/* Completion Info */}
                    {task.completed && task.completedAt && (
                        <div className="mt-3 text-xs text-gray-400 border-t border-gray-100 pt-2">
                            Užbaigta: {new Date(task.completedAt).toLocaleString()}
                        </div>
                    )}
                </div>
            </div>

            {/* Modals */}
            <DescriptionModal
                isOpen={activeModal === 'description'}
                onClose={() => setActiveModal(null)}
                description={task.description}
            />
            <LinksModal
                isOpen={activeModal === 'links'}
                onClose={() => setActiveModal(null)}
                links={task.links}
            />
            <CommentsModal
                isOpen={activeModal === 'comments'}
                onClose={() => setActiveModal(null)}
                comments={task.comments}
            />
        </div>
    );
}
