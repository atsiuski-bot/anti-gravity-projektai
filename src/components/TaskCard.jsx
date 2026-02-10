import React, { useState } from 'react';
// Force rebuild
import { Clock, AlertCircle, CheckCircle2, Circle, Link as LinkIcon, MessageCircle, FileText, Check, Calendar, Trash2, ArrowUp, ArrowDown, ImageIcon, Edit } from 'lucide-react';
import clsx from 'clsx';
import { doc, updateDoc, deleteDoc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { useSwipeable } from 'react-swipeable';
import { LinksModal, CommentsModal, DescriptionModal, ImageModal } from './TaskDetailsModals';
import { InlineEditModal } from './InlineEditModal';
import TaskTimerControls from './TaskTimerControls';
import { startTask, resumeTask, pauseTask, pauseOtherTasks, archiveTask, deleteTask } from '../utils/taskActions';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString } from '../utils/timeUtils';
import { formatDisplayName } from '../utils/formatters';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import { addComment, updateComment, deleteComment } from '../utils/commentActions';


export default function TaskCard({ task, onEdit, role, showReorderControls, onMoveUp, onMoveDown }) {
    const { currentUser, userRole } = useAuth();
    const [activeModal, setActiveModal] = useState(null);
    const [editingField, setEditingField] = useState(null);
    const [workerColor, setWorkerColor] = useState(null);
    const [lastTap, setLastTap] = useState(0);
    const [editingCommentIndex, setEditingCommentIndex] = useState(null);
    const [editCommentText, setEditCommentText] = useState('');

    const handleUpdateComment = async (index, newText) => {
        try {
            await updateComment(task.id, index, newText, task.comments);
            setEditingCommentIndex(null);
            setEditCommentText('');
        } catch (err) {
            alert("Nepavyko atnaujinti komentaro.");
        }
    };

    const handleDeleteComment = async (index) => {
        if (!window.confirm("Ar tikrai norite ištrinti komentarą?")) return;
        try {
            await deleteComment(task.id, index, task.comments);
        } catch (err) {
            // Error managed in utility or silent fail
        }
    };

    const displayColor = task.assignedWorkerColor || workerColor;
    const isWorker = role === 'worker';
    const isManager = role === 'manager' || role === 'admin' || userRole === 'manager' || userRole === 'admin';
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

    // Priority colors are now handled dynamically via utility
    /* const priorityColors = {
        Low: 'bg-gray-800 text-white',
        Medium: 'bg-gray-500 text-white',
        High: 'bg-gray-200 text-gray-800',
        Urgent: 'bg-yellow-50 text-black border border-yellow-200'
    }; */

    const statusStyles = {
        'pending': 'bg-white border-gray-200',
        'in-progress': 'bg-white border-gray-200',
        'completed': 'bg-gray-200 border-gray-300',
        'confirmed': 'bg-gray-100 border-gray-200',
        'unapproved': 'bg-amber-50 border-amber-200'
    };

    const taskStatus = task.status || 'pending';
    const isUnapproved = taskStatus === 'unapproved';


    const handleAddComment = async (text) => {
        try {
            await addComment(task.id, text, currentUser, task.comments);
        } catch (err) {
            alert("Nepavyko pridėti komentaro.");
        }
    };

    const handleDeleteTask = async () => {
        if (!window.confirm(`Ar tikrai norite ištrinti užduotį "${task.title}"?`)) {
            return;
        }

        try {
            await deleteTask(task, currentUser.uid);
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

        if (now - lastTap < DOUBLE_TAP_DELAY) {
            const canInteract = (isAssignedToMe && taskStatus !== 'confirmed') || (isManager && taskStatus === 'unapproved');

            if (canInteract) {
                // Double tap detected
                e.preventDefault();
                e.stopPropagation();

                const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin' || currentUser?.uid === task.managerId;

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
                } else if (taskStatus === 'unapproved' && isManagerOrAdmin) {
                    await updateDoc(doc(db, 'tasks', task.id), {
                        status: 'pending',
                        updatedAt: new Date().toISOString()
                    });
                }
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
            const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin' || currentUser?.uid === task.managerId;
            const taskData = {
                ...task,
                status: isManagerOrAdmin ? 'confirmed' : 'completed',
                confirmedBy: isManagerOrAdmin ? currentUser.uid : null,
                confirmedAt: isManagerOrAdmin ? new Date().toISOString() : null,
                completed: true,
                completedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            // Sanitize data to remove undefined values
            Object.keys(taskData).forEach(key => taskData[key] === undefined && delete taskData[key]);

            // Do NOT archive immediately
            await updateDoc(doc(db, 'tasks', task.id), taskData);
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
            const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin' || currentUser?.uid === task.managerId;

            const taskData = {
                ...task,
                completed: willBeCompleted,
                completedAt: willBeCompleted ? new Date().toISOString() : null,
                status: willBeCompleted ? (isManagerOrAdmin ? 'confirmed' : 'completed') : 'pending',
                confirmedBy: willBeCompleted && isManagerOrAdmin ? currentUser.uid : null,
                confirmedAt: willBeCompleted && isManagerOrAdmin ? new Date().toISOString() : null,
                updatedAt: new Date().toISOString()
            };

            // Sanitize data to remove undefined values
            Object.keys(taskData).forEach(key => taskData[key] === undefined && delete taskData[key]);

            // Do NOT archive immediately
            await updateDoc(doc(db, 'tasks', task.id), taskData);
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
                    "rounded-xl border-[3px] shadow-sm p-3 transition-all duration-200 mb-2", // Reduced padding (p-4->p-3) and margin (mb-4->mb-2)
                    statusStyles[taskStatus],
                    taskStatus !== 'confirmed' && !task.completed && "cursor-pointer hover:shadow-md",
                    task.completed && "opacity-75"
                )}
            >
                <div className="flex items-start gap-2"> {/* Reduced gap (gap-3->gap-2) */}
                    <div className="flex-1">
                        {/* Header */}
                        <div className="flex justify-between items-start mb-1.5 gap-2"> {/* Reduced margin (mb-3->mb-1.5) */}
                            {showReorderControls && (
                                <div className="flex flex-col gap-0.5 mr-1">
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onMoveUp(task.id); }}
                                        className="p-0.5 hover:bg-gray-100 rounded text-gray-500 hover:text-blue-600"
                                        title="Perkelti aukštyn"
                                    >
                                        <ArrowUp className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onMoveDown(task.id); }}
                                        className="p-0.5 hover:bg-gray-100 rounded text-gray-500 hover:text-blue-600"
                                        title="Perkelti žemyn"
                                    >
                                        <ArrowDown className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            )}
                            <div
                                className={clsx(
                                    "font-bold text-sm leading-tight text-left flex-1 px-2 py-1 rounded",
                                    task.completed ? "line-through text-gray-500" : "text-gray-900",
                                    taskStatus === 'unapproved' ? "bg-gray-200 text-gray-700" : ""
                                )}
                            >
                                {task.title}
                            </div>

                            <div className="flex items-center gap-1.5 flex-shrink-0"> {/* Reduced gap */}
                                {task.priority && (
                                    <span
                                        className={clsx(
                                            "px-1.5 py-0.5 text-[10px] font-bold rounded-full whitespace-nowrap shadow-sm border border-black/5"
                                        )}
                                        style={{
                                            backgroundColor: getPriorityColor(task.priority),
                                            color: getPriorityTextColor(task.priority)
                                        }}
                                    >
                                        {getPriorityLabel(task.priority)}
                                    </span>
                                )}
                                {(() => {
                                    const statusLabels = {
                                        'pending': 'Nepradėtas',
                                        'in-progress': 'Pradėtas',
                                        'completed': 'Užbaigtas, nepriduotas',
                                        'confirmed': 'Užbaigtas, priduotas',
                                        'unapproved': 'Laukia patvirtinimo'
                                    };
                                    const label = statusLabels[taskStatus] || taskStatus;
                                    return (
                                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-gray-100 text-gray-600 border border-gray-200 whitespace-nowrap">
                                            {label}
                                        </span>
                                    );
                                })()}
                                {isManager && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleDeleteTask();
                                        }}
                                        className="p-1.5 text-red-500 hover:bg-red-50 rounded-md transition-colors flex-shrink-0 -mr-1" // Reduced padding
                                        title="Ištrinti užduotį"
                                    >
                                        <Trash2 className="w-4 h-4" /> {/* Reduced icon size */}
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Meta Row: Worker, Deadline, Time, Manager */}
                        <div className="flex flex-wrap items-center gap-2 mb-1.5 min-h-[20px]"> {/* Reduced gap and margin */}
                            {/* Worker Pill */}
                            {task.assignedWorkerName && (isManager || !isAssignedToMe) && (
                                <div
                                    className="inline-flex items-center justify-center p-[2px] rounded-full"
                                    style={{ backgroundColor: displayColor || '#3b82f6' }}
                                >
                                    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-white text-gray-800 border border-white/50">
                                        👤 {formatDisplayName(task.assignedWorkerName)}
                                    </span>
                                </div>
                            )}

                            {/* Deadline */}
                            {task.deadline && (
                                <div className="flex items-center gap-1 text-[10px] text-orange-600 font-medium bg-orange-50 px-1.5 py-0.5 rounded border border-orange-100">
                                    <Calendar className="w-3 h-3" />
                                    {task.deadline}
                                </div>
                            )}

                            {/* Planned Time */}
                            {task.estimatedTime && (
                                <div className={clsx("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 border border-gray-200", task.completed ? "text-gray-400" : "text-gray-700")}>
                                    <Clock className="w-3 h-3" />
                                    {task.estimatedTime}
                                </div>
                            )}

                            {/* Tag */}
                            {task.tag && (
                                <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-800 border border-purple-200">
                                    <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
                                    {task.tag}
                                </div>
                            )}

                            {/* Manager Name */}
                            {(task.managerName || task.creatorName) && (
                                <div className="inline-flex items-center py-0.5 text-[9px] font-medium text-purple-600 opacity-80">
                                    Vadovas: {formatDisplayName(task.managerName || task.creatorName)}
                                </div>
                            )}
                        </div>

                        {/* Description Section */}
                        {task.description && (
                            <div className="mb-1.5"> {/* Reduced margin */}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveModal('description');
                                    }}
                                    className={clsx(
                                        "w-full text-left p-2 rounded-lg border border-gray-100 transition-all",
                                        "bg-gray-50/50 hover:bg-gray-50 hover:border-gray-200 active:scale-[0.98]",
                                        task.completed ? "opacity-60" : "opacity-100"
                                    )}
                                >
                                    <div className="flex items-start gap-1.5">
                                        <FileText className="w-3.5 h-3.5 text-blue-500 mt-0.5 flex-shrink-0" />
                                        <div className="flex-1">
                                            <p className="text-xs text-gray-700 line-clamp-2 leading-snug whitespace-pre-wrap"> {/* Reduced line clamp (5->2) and text size */}
                                                {task.description}
                                            </p>
                                        </div>
                                    </div>
                                </button>
                            </div>
                        )}

                        {/* Comments Section */}
                        {task.comments && task.comments.length > 0 && (
                            <div className="mb-2 mt-1 space-y-1.5">
                                {task.comments.map((comment, index) => {
                                    const isEditing = editingCommentIndex === index;
                                    const canEdit = isManager || comment.userId === currentUser.uid;

                                    return (
                                        <div key={index} className="bg-indigo-50/50 p-2 rounded-lg border border-indigo-100 hover:bg-indigo-50 transition-colors">
                                            <div className="flex justify-between items-start mb-0.5">
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[9px] font-bold text-indigo-700">
                                                        {formatDisplayName(comment.user)}
                                                    </span>
                                                    <span className="text-[8px] text-gray-400">
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
                                                            className="text-gray-400 hover:text-blue-600 p-2 -my-2"
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                        </button>
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleDeleteComment(index);
                                                            }}
                                                            className="text-gray-400 hover:text-red-600 p-2 -my-2"
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>

                                            {isEditing ? (
                                                <div onClick={(e) => e.stopPropagation()}>
                                                    <textarea
                                                        value={editCommentText}
                                                        onChange={(e) => setEditCommentText(e.target.value)}
                                                        className="w-full text-xs p-1.5 border rounded" // Reduced padding and text size
                                                        rows={2}
                                                    />
                                                    <div className="flex justify-end gap-2 mt-1">
                                                        <button
                                                            onClick={() => setEditingCommentIndex(null)}
                                                            className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
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
                                                    className="text-xs text-gray-700 leading-snug break-words cursor-pointer"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
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
                        <div className="flex items-center gap-3 text-xs mt-0.5">
                            {task.links && task.links.length > 0 && (
                                <div className="flex items-center gap-1.5 overflow-x-auto py-1">
                                    {(() => {
                                        const allLinks = (task.links || []).flatMap(l => l.split('\n')).filter(l => l.trim().length > 0);
                                        return allLinks.slice(0, 4).map((link, idx) => (
                                            <a
                                                key={idx}
                                                href={link.trim().startsWith('http') ? link.trim() : `https://${link.trim()}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center justify-center text-blue-600 hover:text-blue-800 transition-transform active:scale-95 min-w-[36px] min-h-[36px] bg-blue-50 rounded-lg shadow-sm border border-blue-100" // Reduced size
                                                title={link.trim()}
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <LinkIcon className="w-4 h-4" />
                                            </a>
                                        ));
                                    })()}
                                </div>
                            )}

                            {task.attachmentUrl && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveModal('image');
                                    }}
                                    className="flex items-center justify-center gap-1.5 text-pink-600 hover:text-pink-800 hover:bg-pink-50 rounded-lg transition-colors px-2 py-1.5 min-h-[36px]"
                                    title="Peržiūrėti nuotrauką"
                                >
                                    <ImageIcon className="w-4 h-4" />
                                </button>
                            )}
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveModal('comments');
                                }}
                                className="flex items-center justify-center gap-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors px-2 py-1.5 min-h-[36px]" // Reduced size
                            >
                                <MessageCircle className="w-4 h-4" />
                                <span className="text-xs font-bold">{task.comments?.length || 0}</span>
                            </button>
                            {onEdit && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEdit(task);
                                    }}
                                    className="flex items-center justify-center gap-1 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-colors ml-auto min-h-[36px]"
                                >
                                    <Edit className="w-3.5 h-3.5" />
                                    Redaguoti
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Footer Actions: Timer & Edit */}
                <div className="flex items-center justify-between mt-0.5">
                    <TaskTimerControls
                        task={task}
                        role={role}
                    />

                    {isManager && taskStatus === 'unapproved' && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                const confirmApprove = window.confirm("Patvirtinti šią užduotį?");
                                if (confirmApprove) {
                                    updateDoc(doc(db, 'tasks', task.id), {
                                        status: 'active',
                                        approvedAt: new Date().toISOString(),
                                        approvedBy: currentUser.uid,
                                        updatedAt: new Date().toISOString()
                                    });
                                }
                            }}
                            className="text-xs bg-green-500 text-white px-3 py-1.5 rounded-lg font-medium shadow-sm active:scale-95 transition-all ml-2"
                        >
                            Patvirtinti
                        </button>
                    )}


                </div>
            </div >


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

            <ImageModal
                isOpen={activeModal === 'image'}
                onClose={() => setActiveModal(null)}
                imageUrls={task.attachmentUrls && task.attachmentUrls.length > 0 ? task.attachmentUrls : (task.attachmentUrl ? [task.attachmentUrl] : [])}
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
