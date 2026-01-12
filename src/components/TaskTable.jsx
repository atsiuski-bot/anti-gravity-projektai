import React, { useState } from 'react';
import clsx from 'clsx';
import { db } from '../firebase';
import { doc, updateDoc, deleteDoc, setDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { Link as LinkIcon, MessageCircle, FileText, CheckCircle2, MessageSquare, Calendar, Archive, Trash2 } from 'lucide-react';
import { LinksModal, CommentsModal, DescriptionModal } from './TaskDetailsModals';
import TaskTimerControls from './TaskTimerControls';
import { parseTimeStringToMinutes, formatMinutesToTimeString } from '../utils/timeUtils';
import { pauseOtherTasks, archiveTask } from '../utils/taskActions';
import { formatDisplayName } from '../utils/formatters';

export default function TaskTable({ tasks, onEdit, role }) {
    const { currentUser, userRole } = useAuth();
    const [expandedComments, setExpandedComments] = useState({});
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null }); // { type: 'description'|'links'|'comments', taskId: string }

    // Comment Editing State
    const [editingComment, setEditingComment] = useState({ taskId: null, index: null });
    const [editCommentText, setEditCommentText] = useState('');

    const handleUpdateComment = async (taskId, index, newText) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            const updatedComments = [...(task.comments || [])];
            updatedComments[index] = { ...updatedComments[index], text: newText, updatedAt: new Date().toISOString() };
            await updateDoc(doc(db, 'tasks', taskId), { comments: updatedComments, updatedAt: new Date().toISOString() });
            setEditingComment({ taskId: null, index: null });
            setEditCommentText('');
        } catch (err) {
            console.error("Error updating comment:", err);
            alert("Nepavyko atnaujinti komentaro.");
        }
    };

    const handleDeleteComment = async (taskId, index) => {
        if (!window.confirm("Ar tikrai norite ištrinti komentarą?")) return;
        try {
            const task = tasks.find(t => t.id === taskId);
            const updatedComments = task.comments.filter((_, i) => i !== index);
            await updateDoc(doc(db, 'tasks', taskId), { comments: updatedComments, updatedAt: new Date().toISOString() });
        } catch (err) {
            console.error("Error deleting comment:", err);
        }
    };

    const formatDeadline = (dateStr) => {
        if (!dateStr) return '-';
        try {
            const date = new Date(dateStr);
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${month}.${day}d`;
        } catch (e) {
            return dateStr;
        }
    };

    const toggleComments = (taskId) => {
        setExpandedComments(prev => ({
            ...prev,
            [taskId]: !prev[taskId]
        }));
    };

    const priorityColors = {
        Low: 'bg-gray-800 text-white',
        Medium: 'bg-gray-500 text-white',
        High: 'bg-gray-200 text-gray-800',
        Urgent: 'bg-yellow-50 text-black border border-yellow-200'
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
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;

            const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin';
            const willBeCompleted = !currentStatus;

            if (willBeCompleted && !window.confirm("Ar tikrai norite užbaigti užduotį?")) {
                return;
            }

            const taskData = {
                ...task,
                completed: willBeCompleted,
                completedAt: willBeCompleted ? new Date().toISOString() : null,
                completedBy: willBeCompleted ? currentUser.uid : null,
                status: willBeCompleted ? (isManagerOrAdmin ? 'confirmed' : 'completed') : 'pending',
                confirmedBy: willBeCompleted && isManagerOrAdmin ? currentUser.uid : null,
                confirmedAt: willBeCompleted && isManagerOrAdmin ? new Date().toISOString() : null,
                updatedAt: new Date().toISOString()
            };

            if (willBeCompleted) {
                // Changing to completed/confirmed - do NOT archive immediately
                // Tasks will be archived by the nightly automation if they are from a previous day
                await updateDoc(doc(db, 'tasks', taskId), taskData);
            } else {
                await updateDoc(doc(db, 'tasks', taskId), taskData);
            }
        } catch (err) {
            console.error("Error toggling task completion:", err);
        }
    };

    const handleConfirmTask = async (taskId) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;

            const taskData = {
                ...task,
                status: 'confirmed',
                confirmedBy: currentUser.uid,
                confirmedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            // Do NOT archive immediately
            await updateDoc(doc(db, 'tasks', taskId), taskData);
        } catch (err) {
            console.error("Error confirming task:", err);
        }
    };

    const handleArchiveTask = async (task) => {
        if (!window.confirm('Ar tikrai norite archyvuoti šią užduotį? Ji bus perkelta į istoriją.')) return;
        try {
            await archiveTask(task, currentUser.uid);
        } catch (err) {
            console.error("Error archiving task:", err);
            alert("Nepavyko archyvuoti užduoties: " + err.message);
        }
    };

    const handleDeleteTask = async (taskId, taskTitle) => {
        if (!window.confirm(`Ar tikrai norite ištrinti užduotį "${taskTitle}"? Šis veiksmas negrįžtamas ir užduotis nebus archyvuota.`)) {
            return;
        }

        try {
            await deleteDoc(doc(db, 'tasks', taskId));
        } catch (err) {
            console.error("Error deleting task:", err);
            alert("Nepavyko ištrinti užduoties: " + err.message);
        }
    };

    const getStatusStyle = (task) => {
        const status = task.status || 'pending';
        if (status === 'confirmed') return 'bg-green-50';
        if (status === 'completed') return 'bg-gray-100';
        return 'bg-white';
    };



    const handleAddComment = async (taskId, text) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;

            const comment = {
                text: text,
                user: currentUser.displayName || currentUser.email,
                userId: currentUser.uid,
                createdAt: new Date().toISOString()
            };

            const taskRef = doc(db, 'tasks', taskId);
            await updateDoc(taskRef, {
                comments: [...(task.comments || []), comment],
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            console.error("Error adding comment:", err);
            alert("Nepavyko pridėti komentaro.");
        }
    };

    const isWorker = role === 'worker';

    return (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 table-fixed">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-2 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-10">
                                ✓
                            </th>
                            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[40%]">Užduotis</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-24">Darb.</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-20">Atlikti iki</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-20">Prior.</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-28">Būsena</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-16" title="Numatytas laikas">Num.</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-24">Nuorodos</th>
                            <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-12 text-center">Kom.</th>
                            {!isWorker && <th className="px-2 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-16">Patv.</th>}
                            <th className="px-2 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider w-20">Veik.</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {tasks.map((task) => {
                            const isAssignedToMe = currentUser?.uid === task.assignedWorkerId;
                            return (
                                <React.Fragment key={task.id}>
                                    <tr className={clsx(
                                        "transition-colors",
                                        getStatusStyle(task),
                                        !task.completed && "hover:bg-gray-50"
                                    )}>
                                        <td className="px-2 py-3 text-center">
                                            <input
                                                type="checkbox"
                                                checked={task.completed || false}
                                                onChange={() => {
                                                    if (isAssignedToMe) {
                                                        handleToggleComplete(task.id, task.completed);
                                                    }
                                                }}
                                                disabled={!isAssignedToMe}
                                                className={clsx(
                                                    "w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500",
                                                    isAssignedToMe ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                                                )}
                                            />
                                        </td>
                                        <td className="px-3 py-3">
                                            <div className={clsx(
                                                "text-sm font-medium truncate",
                                                task.completed ? "text-gray-500 line-through" : "text-gray-900"
                                            )}>
                                                {task.title}
                                            </div>
                                            {task.creatorName && (
                                                <div className="text-[9px] text-purple-600 font-medium mt-0.5 opacity-80">
                                                    Vadovas: {formatDisplayName(task.creatorName)}
                                                </div>
                                            )}
                                            {/* Deadline removed from here, moving to own column */}
                                            {task.description && (
                                                <button
                                                    onClick={() => setActiveModal({ type: 'description', taskId: task.id })}
                                                    className="text-xs text-gray-600 hover:text-blue-600 hover:bg-blue-50/50 p-1 rounded-md transition-colors line-clamp-3 text-left w-full mt-1 border border-transparent hover:border-blue-100 whitespace-pre-wrap"
                                                >
                                                    <FileText className="w-3 h-3 inline mr-1 flex-shrink-0 text-blue-500" />
                                                    {task.description}
                                                </button>
                                            )}

                                            {/* Comments List */}
                                            {task.comments && task.comments.length > 0 && (
                                                <div className="mt-2 space-y-1.5 pl-2 border-l-2 border-indigo-100">
                                                    {task.comments.map((comment, index) => {
                                                        const isEditing = editingComment.taskId === task.id && editingComment.index === index;
                                                        const canEdit = (userRole === 'manager' || userRole === 'admin') || comment.userId === currentUser.uid;

                                                        return (
                                                            <div key={index} className="text-[11px] bg-indigo-50/30 rounded p-1.5 group hover:bg-indigo-50/60 transition-colors">
                                                                <div className="flex justify-between items-start mb-0.5">
                                                                    <div className="flex items-center gap-1.5 text-[10px]">
                                                                        <MessageCircle className="w-2.5 h-2.5 text-indigo-400" />
                                                                        <span className="font-semibold text-indigo-700">{formatDisplayName(comment.user)}</span>
                                                                        <span className="text-gray-400">{new Date(comment.createdAt).toLocaleDateString()}</span>
                                                                    </div>
                                                                    {canEdit && !isEditing && (
                                                                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                            <button
                                                                                onClick={(e) => {
                                                                                    e.stopPropagation();
                                                                                    setEditingComment({ taskId: task.id, index });
                                                                                    setEditCommentText(comment.text);
                                                                                }}
                                                                                className="text-gray-400 hover:text-blue-600"
                                                                                title="Redaguoti"
                                                                            >
                                                                                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                                            </button>
                                                                            <button
                                                                                onClick={(e) => {
                                                                                    e.stopPropagation();
                                                                                    handleDeleteComment(task.id, index);
                                                                                }}
                                                                                className="text-gray-400 hover:text-red-600"
                                                                                title="Ištrinti"
                                                                            >
                                                                                <Trash2 className="w-2.5 h-2.5" />
                                                                            </button>
                                                                        </div>
                                                                    )}
                                                                </div>

                                                                {isEditing ? (
                                                                    <div onClick={(e) => e.stopPropagation()}>
                                                                        <textarea
                                                                            value={editCommentText}
                                                                            onChange={(e) => setEditCommentText(e.target.value)}
                                                                            className="w-full text-[11px] p-1 border rounded resize-none focus:ring-1 focus:ring-blue-500"
                                                                            rows={2}
                                                                            autoFocus
                                                                        />
                                                                        <div className="flex justify-end gap-1 mt-1">
                                                                            <button
                                                                                onClick={() => setEditingComment({ taskId: null, index: null })}
                                                                                className="px-1.5 py-0.5 text-[10px] text-gray-500 hover:text-gray-700 bg-white border border-gray-200 rounded"
                                                                            >
                                                                                Atšaukti
                                                                            </button>
                                                                            <button
                                                                                onClick={() => handleUpdateComment(task.id, index, editCommentText)}
                                                                                className="px-1.5 py-0.5 text-[10px] text-white bg-blue-600 hover:bg-blue-700 rounded"
                                                                            >
                                                                                Išsaugoti
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                    <div className="text-gray-600 leading-snug break-words pl-4">
                                                                        {comment.text}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
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
                                                    <span className="px-1.5 py-0.5 rounded-full text-[11px] font-bold bg-white text-gray-800 border border-white/50 max-w-[80px] truncate">
                                                        {formatDisplayName(task.assignedWorkerName)}
                                                    </span>
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-2 py-3 whitespace-nowrap text-xs text-gray-600">
                                            {formatDeadline(task.deadline)}
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
                                        <td className="px-2 py-3 text-xs">
                                            <div className="flex flex-wrap gap-1.5 min-w-[60px]">
                                                {(() => {
                                                    const allLinks = (task.links || []).flatMap(l => l.split('\n')).filter(l => l.trim().length > 0);
                                                    return allLinks.slice(0, 4).map((link, idx) => (
                                                        <a
                                                            key={idx}
                                                            href={link.trim().startsWith('http') ? link.trim() : `https://${link.trim()}`}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-blue-600 hover:text-blue-800 transition-transform active:scale-90"
                                                            title={link.trim()}
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            <LinkIcon className="w-4 h-4" />
                                                        </a>
                                                    ));
                                                })()}
                                            </div>
                                        </td>
                                        <td className="px-2 py-3 text-center">
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setActiveModal({ type: 'comments', taskId: task.id });
                                                }}
                                                className="inline-flex items-center gap-1 text-green-600 hover:text-green-800 transition-colors"
                                                title="Komentarai"
                                            >
                                                <MessageSquare className="w-4 h-4" />
                                                {task.comments?.length > 0 && (
                                                    <span className="text-[10px] font-bold">{task.comments.length}</span>
                                                )}
                                            </button>
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
                                            {!isWorker && (
                                                <button
                                                    onClick={() => onEdit(task)}
                                                    className="text-blue-600 hover:text-blue-900 block"
                                                >
                                                    Redaguoti
                                                </button>
                                            )}
                                            {!isWorker && (
                                                <button
                                                    onClick={() => handleDeleteTask(task.id, task.title)}
                                                    className="text-red-500 hover:text-red-700 block mt-1 text-[10px] flex items-center justify-end gap-1 ml-auto"
                                                    title="Ištrinti"
                                                >
                                                    <Trash2 className="w-3 h-3" />
                                                    Ištrinti
                                                </button>
                                            )}
                                            {!isWorker && task.status === 'confirmed' && (
                                                <button
                                                    onClick={() => handleArchiveTask(task)}
                                                    className="text-gray-500 hover:text-gray-700 block mt-1 text-[10px] flex items-center justify-end gap-1 ml-auto"
                                                    title="Archyvuoti"
                                                >
                                                    <Archive className="w-3 h-3" />
                                                    Archyvuoti
                                                </button>
                                            )}
                                            <div className="mt-2 text-right">
                                                <TaskTimerControls
                                                    task={task}
                                                    role={role}
                                                />
                                            </div>
                                        </td>
                                    </tr>
                                </React.Fragment>
                            );
                        })}
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
                            onAddComment={(text) => handleAddComment(task.id, text)}
                        />
                    </>
                );
            })()}

        </div >
    );
}
