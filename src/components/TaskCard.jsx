import React, { useState } from 'react';
import { Clock, AlertCircle, CheckCircle2, Circle, Link as LinkIcon, MessageCircle, FileText, Check, Calendar, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { db } from '../firebase';
import { doc, updateDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useSwipeable } from 'react-swipeable';
import { LinksModal, CommentsModal, DescriptionModal } from './TaskDetailsModals';
import { InlineEditModal } from './InlineEditModal';
import TaskTimerControls from './TaskTimerControls';
import { parseTimeStringToMinutes, formatMinutesToTimeString } from '../utils/timeUtils';
import { pauseOtherTasks, archiveTask } from '../utils/taskActions';
import { formatDisplayName } from '../utils/formatters';


export default function TaskCard({ task, onEdit, role }) {
    const { currentUser, userRole } = useAuth();
    const [activeModal, setActiveModal] = useState(null);
    const [editingField, setEditingField] = useState(null);
    const [workerColor, setWorkerColor] = useState(null);
    const [lastTap, setLastTap] = useState(0);
    const [editingCommentIndex, setEditingCommentIndex] = useState(null);
    const [editCommentText, setEditCommentText] = useState('');

    const handleUpdateComment = async (index, newText) => {
        try {
            const updatedComments = [...(task.comments || [])];
            updatedComments[index] = { ...updatedComments[index], text: newText, updatedAt: new Date().toISOString() };
            await updateDoc(doc(db, 'tasks', task.id), { comments: updatedComments, updatedAt: new Date().toISOString() });
            setEditingCommentIndex(null);
            setEditCommentText('');
        } catch (err) {
            console.error("Error updating comment:", err);
            alert("Nepavyko atnaujinti komentaro.");
        }
    };

    const handleDeleteComment = async (index) => {
        if (!window.confirm("Ar tikrai norite ištrinti komentarą?")) return;
        try {
            const updatedComments = task.comments.filter((_, i) => i !== index);
            await updateDoc(doc(db, 'tasks', task.id), { comments: updatedComments, updatedAt: new Date().toISOString() });
        } catch (err) {
            console.error("Error deleting comment:", err);
        }
    };

    const displayColor = task.assignedWorkerColor || workerColor;
    const isWorker = role === 'worker';
    const isManager = role === 'manager' || role === 'admin';
    const isAssignedToMe = currentUser?.uid === task.assignedWorkerId;

    React.useEffect(() => {
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
        Low: 'bg-gray-800 text-white',
        Medium: 'bg-gray-500 text-white',
        High: 'bg-gray-200 text-gray-800',
        Urgent: 'bg-yellow-50 text-black border border-yellow-200'
    };

    const statusStyles = {
        'pending': 'bg-white border-gray-200',
        'in-progress': 'bg-white border-gray-200',
        'completed': 'bg-gray-200 border-gray-300',
        'confirmed': 'bg-green-100 border-green-300'
    };

    const taskStatus = task.status || 'pending';


    const handleAddComment = async (text) => {
        try {
            const comment = {
                text: text,
                user: currentUser.displayName || currentUser.email,
                userId: currentUser.uid,
                createdAt: new Date().toISOString()
            };

            const taskRef = doc(db, 'tasks', task.id);
            await updateDoc(taskRef, {
                comments: [...(task.comments || []), comment],
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            console.error("Error adding comment:", err);
            alert("Nepavyko pridėti komentaro.");
        }
    };

    const handleDeleteTask = async () => {
        if (!window.confirm(`Ar tikrai norite ištrinti užduotį "${task.title}"? Šis veiksmas negrįžtamas.`)) {
            return;
        }

        try {
            await deleteDoc(doc(db, 'tasks', task.id));
        } catch (err) {
            console.error("Error deleting task:", err);
            alert("Nepavyko ištrinti užduoties: " + err.message);
        }
    };

    // Double-tap handler for touch events
    const handleDoubleTap = async (e) => {
        // Only handle if it's a touch event or if we're on desktop
        if (e.type !== 'touchend' && e.type !== 'click') return;

        const now = Date.now();
        const DOUBLE_TAP_DELAY = 300;

        if (now - lastTap < DOUBLE_TAP_DELAY && isAssignedToMe && taskStatus !== 'confirmed') {
            // Double tap detected
            e.preventDefault();
            e.stopPropagation();

            if (taskStatus === 'pending') {
                await updateDoc(doc(db, 'tasks', task.id), {
                    status: 'in-progress',
                    updatedAt: new Date().toISOString()
                });
            } else if (taskStatus === 'in-progress') {
                await updateDoc(doc(db, 'tasks', task.id), {
                    status: 'pending',
                    updatedAt: new Date().toISOString()
                });
            }
        }

        setLastTap(now);
    };

    // Swipe handlers for mobile gestures
    const handleSwipeLeft = async () => {
        if (!isAssignedToMe || taskStatus === 'confirmed') return;

        if (!window.confirm("Ar tikrai norite užbaigti užduotį?")) return;

        // Swipe left: Mark as completed
        try {
            const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin';
            const taskData = {
                ...task,
                status: isManagerOrAdmin ? 'confirmed' : 'completed',
                confirmedBy: isManagerOrAdmin ? currentUser.uid : null,
                confirmedAt: isManagerOrAdmin ? new Date().toISOString() : null,
                completed: true,
                completedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            // Always archive when finished to move to history/reports
            await archiveTask(taskData, currentUser.uid);
        } catch (error) {
            console.error('Error completing task via swipe:', error);
        }
    };

    const handleSwipeRight = async () => {
        if (!isAssignedToMe || taskStatus === 'confirmed') return;

        // Swipe right: Toggle between pending and in-progress
        try {
            if (taskStatus === 'pending') {
                await updateDoc(doc(db, 'tasks', task.id), {
                    status: 'in-progress',
                    updatedAt: new Date().toISOString()
                });
            } else if (taskStatus === 'in-progress') {
                await updateDoc(doc(db, 'tasks', task.id), {
                    status: 'pending',
                    updatedAt: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error('Error updating task via swipe:', error);
        }
    };

    const swipeHandlers = useSwipeable({
        onSwipedLeft: handleSwipeLeft,
        onSwipedRight: handleSwipeRight,
        trackMouse: false,
        trackTouch: true,
        delta: 50
    });

    const handleToggleComplete = async (e) => {
        e.stopPropagation();
        if (!isAssignedToMe) return;

        const willBeCompleted = !task.completed;

        if (willBeCompleted && !window.confirm("Ar tikrai norite užbaigti užduotį?")) {
            return;
        }

        try {
            const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin';

            const taskData = {
                ...task,
                completed: willBeCompleted,
                completedAt: willBeCompleted ? new Date().toISOString() : null,
                status: willBeCompleted ? (isManagerOrAdmin ? 'confirmed' : 'completed') : 'pending',
                confirmedBy: willBeCompleted && isManagerOrAdmin ? currentUser.uid : null,
                confirmedAt: willBeCompleted && isManagerOrAdmin ? new Date().toISOString() : null,
                updatedAt: new Date().toISOString()
            };

            // Always archive when finished to move to history/reports
            if (willBeCompleted) {
                await archiveTask(taskData, currentUser.uid);
            } else {
                await updateDoc(doc(db, 'tasks', task.id), taskData);
            }
        } catch (error) {
            console.error('Error toggling completion:', error);
        }
    };

    return (
        <>
            <div
                {...(isWorker ? swipeHandlers : {})}
                onTouchEnd={isWorker ? handleDoubleTap : undefined}
                className={clsx(
                    "rounded-xl border-[3px] shadow-sm p-4 transition-all duration-200 mb-4",
                    statusStyles[taskStatus],
                    taskStatus !== 'confirmed' && !task.completed && "cursor-pointer hover:shadow-md",
                    task.completed && "opacity-75"
                )}
            >
                <div className="flex items-start gap-3">
                    <div className="flex-1" onClick={isManager || !task.completed ? onEdit : undefined}>
                        {/* Header */}
                        <div className="flex justify-between items-start mb-3 gap-2">
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    // Allow editing title inline if manager, or if not completed
                                    if (isManager || !task.completed) {
                                        setEditingField({ field: 'title', label: 'Redaguoti pavadinimą' });
                                    }
                                }}
                                className={clsx(
                                    "font-bold text-base leading-snug text-left flex-1 px-2 py-1 rounded",
                                    task.completed ? "line-through text-gray-500" : "text-gray-900",
                                    (isManager || !task.completed) && "hover:bg-gray-100"
                                )}
                            >
                                {task.title}
                            </button>

                            <div className="flex items-center gap-2 flex-shrink-0">
                                {task.priority && (
                                    <span className={clsx(
                                        "px-2 py-1 text-xs font-bold rounded-full whitespace-nowrap border border-black/5 shadow-sm",
                                        priorityColors[task.priority]
                                    )}>
                                        {task.priority === 'Low' ? 'Žemas' : task.priority === 'Medium' ? 'Vidutinis' : task.priority === 'High' ? 'Aukštas' : 'Skubus'}
                                    </span>
                                )}
                                {isManager && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleDeleteTask();
                                        }}
                                        className="p-1 text-red-500 hover:bg-red-50 rounded-md transition-colors flex-shrink-0"
                                        title="Ištrinti užduotį"
                                    >
                                        <Trash2 className="w-5 h-5" />
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Meta Row: Worker, Deadline, Time, Manager */}
                        <div className="flex flex-wrap items-center gap-3 mb-2 min-h-[24px]">
                            {/* Worker Pill */}
                            {!isAssignedToMe && task.assignedWorkerName && (
                                <div
                                    className="inline-flex items-center justify-center p-[4px] rounded-full"
                                    style={{ backgroundColor: displayColor || '#3b82f6' }}
                                >
                                    <span className="px-2 py-1 rounded-full text-xs font-bold bg-white text-gray-800 border border-white/50">
                                        👤 {formatDisplayName(task.assignedWorkerName)}
                                    </span>
                                </div>
                            )}

                            {/* Deadline */}
                            {task.deadline && (
                                <div className="flex items-center gap-1.5 text-xs text-orange-600 font-medium bg-orange-50 px-2 py-1 rounded border border-orange-100">
                                    <Calendar className="w-3 h-3" />
                                    {task.deadline}
                                </div>
                            )}

                            {/* Planned Time (Moved here) */}
                            {task.estimatedTime && (
                                <div className={clsx("inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-semibold bg-gray-100 border border-gray-200", task.completed ? "text-gray-400" : "text-gray-700")}>
                                    <Clock className="w-3.5 h-3.5" />
                                    {task.estimatedTime}
                                </div>
                            )}

                            {/* Manager Name (Moved here) */}
                            {task.creatorName && (
                                <div className="inline-flex items-center py-1 text-[10px] font-medium text-purple-600 opacity-80">
                                    Vadovas: {formatDisplayName(task.creatorName)}
                                </div>
                            )}
                        </div>

                        {/* Removed separate Deadline div */}

                        {/* Description Section */}
                        {task.description && (
                            <div className="mb-2">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveModal('description');
                                    }}
                                    className={clsx(
                                        "w-full text-left p-2.5 rounded-lg border border-gray-100 transition-all",
                                        "bg-gray-50/50 hover:bg-gray-50 hover:border-gray-200 active:scale-[0.98]",
                                        task.completed ? "opacity-60" : "opacity-100"
                                    )}
                                >
                                    <div className="flex items-start gap-2">
                                        <FileText className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
                                        <div className="flex-1">
                                            <p className="text-sm text-gray-700 line-clamp-5 leading-normal whitespace-pre-wrap">
                                                {task.description}
                                            </p>
                                            {task.description.length > 100 && (
                                                <span className="text-[10px] text-blue-500 font-medium mt-1.5 block italic">
                                                    Bakstelėkite, jei norite matyti visą tekstą...
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </button>
                            </div>
                        )}

                        {/* Comments Section */}
                        {task.comments && task.comments.length > 0 && (
                            <div className="mb-3 mt-2 space-y-2">
                                {task.comments.map((comment, index) => {
                                    const isEditing = editingCommentIndex === index;
                                    const canEdit = isManager || comment.userId === currentUser.uid;

                                    return (
                                        <div key={index} className="bg-indigo-50/50 p-2.5 rounded-lg border border-indigo-100 hover:bg-indigo-50 transition-colors">
                                            <div className="flex justify-between items-start mb-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-bold text-indigo-700">
                                                        {formatDisplayName(comment.user)}
                                                    </span>
                                                    <span className="text-[9px] text-gray-400">
                                                        {new Date(comment.createdAt).toLocaleDateString()}
                                                    </span>
                                                </div>
                                                {canEdit && !isEditing && (
                                                    <div className="flex gap-1">
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setEditingCommentIndex(index);
                                                                setEditCommentText(comment.text);
                                                            }}
                                                            className="text-gray-400 hover:text-blue-600 p-0.5"
                                                        >
                                                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                        </button>
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleDeleteComment(index);
                                                            }}
                                                            className="text-gray-400 hover:text-red-600 p-0.5"
                                                        >
                                                            <Trash2 className="w-3 h-3" />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>

                                            {isEditing ? (
                                                <div onClick={(e) => e.stopPropagation()}>
                                                    <textarea
                                                        value={editCommentText}
                                                        onChange={(e) => setEditCommentText(e.target.value)}
                                                        className="w-full text-sm p-1 border rounded"
                                                        rows={2}
                                                    />
                                                    <div className="flex justify-end gap-2 mt-1">
                                                        <button
                                                            onClick={() => setEditingCommentIndex(null)}
                                                            className="text-xs text-gray-500 hover:text-gray-700"
                                                        >
                                                            Atšaukti
                                                        </button>
                                                        <button
                                                            onClick={() => handleUpdateComment(index, editCommentText)}
                                                            className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700"
                                                        >
                                                            Išsaugoti
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <p
                                                    className="text-sm text-gray-700 leading-snug break-words cursor-pointer"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        // Optional: Expand toggle if needed, but now all comments are shown.
                                                        // Maybe just do nothing or allow selecting text.
                                                    }}
                                                >
                                                    {comment.text}
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Links and Comments */}
                        <div className="flex items-center gap-4 text-xs mt-1">
                            {task.links && task.links.length > 0 && (
                                <div className="flex items-center gap-2 overflow-x-auto py-1">
                                    {(() => {
                                        const allLinks = (task.links || []).flatMap(l => l.split('\n')).filter(l => l.trim().length > 0);
                                        return allLinks.slice(0, 4).map((link, idx) => (
                                            <a
                                                key={idx}
                                                href={link.trim().startsWith('http') ? link.trim() : `https://${link.trim()}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center justify-center text-blue-600 hover:text-blue-800 transition-transform active:scale-90 min-w-[44px] min-h-[44px] bg-blue-50 rounded-lg"
                                                title={link.trim()}
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <LinkIcon className="w-5 h-5" />
                                            </a>
                                        ));
                                    })()}
                                </div>
                            )}
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveModal('comments');
                                }}
                                className="flex items-center justify-center gap-1.5 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-md transition-colors px-2 py-1"
                            >
                                <MessageCircle className="w-5 h-5" />
                                <span className="text-sm font-bold">{task.comments?.length || 0}</span>
                            </button>
                        </div>
                    </div>
                </div>

                {/* Timer Controls - Inside task card */}
                <div className="mt-1">
                    <TaskTimerControls
                        task={task}
                        role={role}
                    />
                </div>
            </div>


            <LinksModal
                isOpen={activeModal === 'links'}
                onClose={() => setActiveModal(null)}
                links={task.links}
            />

            <CommentsModal
                isOpen={activeModal === 'comments'}
                onClose={() => setActiveModal(null)}
                comments={task.comments}
                onAddComment={handleAddComment}
            />

            <DescriptionModal
                isOpen={activeModal === 'description'}
                onClose={() => setActiveModal(null)}
                description={task.description}
            />

            <InlineEditModal
                isOpen={!!editingField}
                onClose={() => setEditingField(null)}
                task={task}
                field={editingField?.field}
                label={editingField?.label}
            />
        </>
    );
}
