import React, { useState, useEffect } from 'react';
import { Clock, Link as LinkIcon, MessageCircle, FileText, Calendar, Trash2, ArrowUp, ArrowDown, ImageIcon, Edit, Undo2 } from 'lucide-react';
import clsx from 'clsx';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { useSwipeable } from 'react-swipeable';
import { LinksModal, CommentsModal, DescriptionModal, ImageModal, DeleteConfirmationModal } from './TaskDetailsModals';
import { InlineEditModal } from './InlineEditModal';
import TaskTimerControls from './TaskTimerControls';
import { deleteTask, revertTask } from '../utils/taskActions';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString, parseTimeStringToMinutes } from '../utils/timeUtils';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import ConfirmDialog from './ui/ConfirmDialog';
import { addComment, updateComment, deleteComment } from '../utils/commentActions';
import { STATUS_LABELS, STATUS_STYLES } from '../utils/taskConstants';
import { useIsTaskRunning } from '../hooks/useIsTaskRunning';


const TaskCard = ({ task, onEdit, role, showReorderControls, onMoveUp, onMoveDown }) => {
    const { currentUser, userRole } = useAuth();
    const [activeModal, setActiveModal] = useState(null);
    const [editingField, setEditingField] = useState(null);
    const [lastTap, setLastTap] = useState(0);
    const [editingCommentIndex, setEditingCommentIndex] = useState(null);
    const [editCommentText, setEditCommentText] = useState('');
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [spentMinutes, setSpentMinutes] = useState(0);
    const [confirmRevert, setConfirmRevert] = useState(false);
    const [revertError, setRevertError] = useState('');
    const [confirmApprove, setConfirmApprove] = useState(false);
    const [confirmDeleteCommentIdx, setConfirmDeleteCommentIdx] = useState(null);

    const handleUpdateComment = async (index, newText) => {
        try {
            await updateComment(task.id, index, newText, task.comments);
            setEditingCommentIndex(null);
            setEditCommentText('');
        } catch (err) {
            alert("Nepavyko atnaujinti komentaro.");
        }
    };

    const performDeleteComment = async (index) => {
        try {
            await deleteComment(task.id, index, task.comments);
        } catch (err) {
            console.error('Error deleting comment:', err);
        } finally {
            setConfirmDeleteCommentIdx(null);
        }
    };

    const performRevert = async () => {
        try {
            await revertTask(task);
            setConfirmRevert(false);
        } catch (err) {
            console.error('Error reverting task:', err);
            setRevertError('Nepavyko grąžinti užduoties. Bandykite dar kartą.');
        }
    };

    const performApprove = async () => {
        try {
            await updateDoc(doc(db, 'tasks', task.id), {
                status: 'in-progress',
                isApproved: true,
                approvedAt: new Date().toISOString(),
                approvedBy: currentUser.uid,
                updatedAt: new Date().toISOString()
            });
            setConfirmApprove(false);
        } catch (err) {
            console.error('Error approving task:', err);
        }
    };

    const displayColor = task.assignedWorkerColor;
    const isWorker = role === 'worker';
    const isManager = isManagerRole(role) || isManagerRole(userRole);
    const isAssignedToMe = currentUser?.uid === task.assignedUserId;

    const taskStatus = task.status || 'pending';

    // Strict UI logic: activeSession is the PRIMARY source of truth, workStatus is the fallback.
    const isRunning = useIsTaskRunning(task);

    useEffect(() => {
        const updateSpentTime = () => {
            setSpentMinutes(calculateCurrentTotalMinutes(task));
        };
        updateSpentTime();
        
        // Update more frequently for running tasks, but only if running
        const intervalTime = isRunning ? 1000 : 10000;
        const interval = setInterval(updateSpentTime, intervalTime);
        return () => clearInterval(interval);
    }, [task, isRunning]);


    const handleAddComment = async (text) => {
        try {
            await addComment(task.id, text, currentUser, task.comments);
        } catch (err) {
            alert("Nepavyko pridėti komentaro.");
        }
    };

    const handleDeleteTask = () => {
        setShowDeleteModal(true);
    };

    const confirmDelete = async ({ keepWorkHours }) => {
        try {
            await deleteTask(task, currentUser.uid, { keepWorkHours });
            setShowDeleteModal(false);
        } catch (err) {
            console.error("Error deleting task:", err);
            alert("Nepavyko ištrinti užduoties. Bandykite dar kartą.");
        }
    };

    // Double-tap handler for touch events
    const handleDoubleTap = async (e) => {
        // Only handle if it's a touch event or if we're on desktop
        if (e.type !== 'touchend' && e.type !== 'click') return;

        const now = Date.now();
        const DOUBLE_TAP_DELAY = 300;

        if (now - lastTap < DOUBLE_TAP_DELAY) {
            const canInteract = (isAssignedToMe && taskStatus !== 'confirmed' && taskStatus !== 'unapproved') || (isManager && taskStatus === 'unapproved');

            if (canInteract) {
                // Double tap detected
                e.preventDefault();
                e.stopPropagation();

                const isManagerOrAdmin = isManagerRole(userRole) || currentUser?.uid === task.managerId;

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

    // Swipe handler for the (reversible) status toggle. The destructive finish-by-swipe was
    // removed: finishing now happens only via the explicit, confirmed Užbaigti button, so a
    // stray horizontal swipe during a vertical scroll can never irreversibly end a task.
    const handleSwipeRight = async () => {
        if (!isAssignedToMe || taskStatus === 'confirmed' || taskStatus === 'unapproved') return;

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
        onSwipedRight: handleSwipeRight,
        trackMouse: false,
        trackTouch: true,
        delta: 80,
        swipeDuration: 500
    });

    // Compute dynamic limit state based on raw math instead of just the task.timeLimitReached flag.
    // This allows manual time reduction to instantly un-red the card without needing a flag wipe.
    const estMinutes = parseTimeStringToMinutes(task.estimatedTime || '0');
    const isLimitExceeded = estMinutes > 0 && spentMinutes >= estMinutes;

    return (
        <>
            <div
                {...(isWorker ? swipeHandlers : {})}
                onTouchEnd={isWorker ? handleDoubleTap : undefined}
                className={clsx(
                    "rounded-xl border-[3px] shadow-sm p-3 transition-all duration-200 mb-2", // Reduced padding (p-4->p-3) and margin (mb-4->mb-2)
                    isRunning ? "bg-green-200 border-green-300"
                        : task.inspectionStatus === 'inspecting' ? "bg-blue-100 border-blue-300"
                        : isLimitExceeded ? "bg-red-50 border-red-300"
                        : (STATUS_STYLES[taskStatus] || "bg-white border-gray-200"),
                    taskStatus !== 'confirmed' && taskStatus !== 'unapproved' && !task.completed && "cursor-pointer hover:shadow-md",
                    task.completed && "opacity-75"
                )}
            >
                <div className="flex items-start gap-2"> {/* Reduced gap (gap-3->gap-2) */}
                    <div className="flex-1">
                        {/* Header */}
                        <div className="flex justify-between items-start mb-1.5 gap-2"> {/* Reduced margin (mb-3->mb-1.5) */}
                            {showReorderControls && (
                                <div className="flex flex-col gap-0.5 mr-1">
                                    <IconButton
                                        icon={ArrowUp}
                                        label="Perkelti aukštyn"
                                        variant="ghost"
                                        onClick={(e) => { e.stopPropagation(); onMoveUp(task.id); }}
                                    />
                                    <IconButton
                                        icon={ArrowDown}
                                        label="Perkelti žemyn"
                                        variant="ghost"
                                        onClick={(e) => { e.stopPropagation(); onMoveDown(task.id); }}
                                    />
                                </div>
                            )}
                            <div
                                className={clsx(
                                    "font-bold text-sm leading-tight text-left flex-1 px-2 py-1 rounded",
                                    (task.completed || task.isDeleted) ? "line-through text-gray-500" : "text-gray-900",
                                    taskStatus === 'unapproved' ? "bg-gray-200 text-gray-700" : ""
                                )}
                            >
                                {task.title}
                                {task.isDeleted && (
                                    <span className="ml-2 inline-block px-1.5 py-0.5 text-caption font-bold bg-red-100 text-red-600 rounded border border-red-200 align-middle" style={{ textDecoration: 'none' }}>
                                        Ištrintas
                                    </span>
                                )}
                            </div>

                            <div className="flex items-center gap-1.5 flex-shrink-0"> {/* Reduced gap */}
                                {task.priority && (
                                    <span
                                        className={clsx(
                                            "px-1.5 py-0.5 text-caption font-bold rounded-full whitespace-nowrap shadow-sm border border-black/5"
                                        )}
                                        style={{
                                            backgroundColor: getPriorityColor(task.priority),
                                            color: getPriorityTextColor(task.priority)
                                        }}
                                    >
                                        {getPriorityLabel(task.priority)}
                                    </span>
                                )}
                                <span className="px-1.5 py-0.5 text-caption font-medium rounded-full bg-gray-100 text-gray-600 border border-gray-200 whitespace-nowrap">
                                    {STATUS_LABELS[taskStatus] || taskStatus}
                                </span>
                                {isManager && (
                                    <IconButton
                                        icon={Trash2}
                                        label="Ištrinti užduotį"
                                        variant="danger"
                                        onClick={(e) => { e.stopPropagation(); handleDeleteTask(); }}
                                        className="flex-shrink-0 -mr-1"
                                    />
                                )}
                            </div>
                        </div>

                        {/* Meta Row: Worker, Deadline, Time, Manager */}
                        <div className="flex flex-wrap items-center gap-2 mb-1.5 min-h-[20px]"> {/* Reduced gap and margin */}
                            {/* Worker Pill */}
                            {task.assignedUserName && (isManager || !isAssignedToMe) && (
                                <div
                                    className="inline-flex items-center justify-center p-[2px] rounded-full"
                                    style={{ backgroundColor: displayColor || WORKER_FALLBACK_COLOR }}
                                >
                                    <span className="px-1.5 py-0.5 rounded-full text-caption font-bold bg-white text-gray-800 border border-white/50">
                                        👤 {formatDisplayName(task.assignedUserName)}
                                    </span>
                                </div>
                            )}

                            {/* Deadline */}
                            {task.deadline && (
                                <div className="flex items-center gap-1 text-caption text-orange-600 font-medium bg-orange-50 px-1.5 py-0.5 rounded border border-orange-100">
                                    <Calendar className="w-3 h-3" />
                                    {task.deadline}
                                </div>
                            )}

                            {/* Planned Time */}
                            {task.estimatedTime && (
                                <div className={clsx("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-caption font-semibold bg-gray-100 border border-gray-200", task.completed ? "text-gray-400" : "text-gray-700")}>
                                    <Clock className="w-3 h-3" />
                                    {task.estimatedTime}
                                </div>
                            )}

                            {/* Spent Time */}
                            {(spentMinutes > 0 || (task.status && task.status !== 'pending')) && (
                                <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-caption font-semibold bg-blue-50 text-blue-700 border border-blue-100">
                                    <Clock className="w-3 h-3" />
                                    {formatMinutesToTimeString(spentMinutes)}
                                </div>
                            )}

                            {/* Tag */}
                            {task.tag && (
                                <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-caption font-semibold bg-purple-100 text-purple-800 border border-purple-200">
                                    <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
                                    {task.tag}
                                </div>
                            )}

                            {/* Manager Name */}
                            {(task.managerName || task.creatorName) && (
                                <div className="inline-flex items-center py-0.5 text-caption font-medium text-purple-600 opacity-80">
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
                                                    <span className="text-caption font-bold text-indigo-700">
                                                        {formatDisplayName(comment.user)}
                                                    </span>
                                                    <span className="text-caption text-gray-400">
                                                        {new Date(comment.createdAt).toLocaleDateString()}
                                                    </span>
                                                </div>
                                                {canEdit && !isEditing && (
                                                    <div className="flex gap-1">
                                                        <button
                                                            aria-label="Redaguoti komentarą"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setEditingCommentIndex(index);
                                                                setEditCommentText(comment.text);
                                                            }}
                                                            className="text-gray-400 hover:text-blue-600 p-2 -my-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                        </button>
                                                        <button
                                                            aria-label="Ištrinti komentarą"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setConfirmDeleteCommentIdx(index);
                                                            }}
                                                            className="text-gray-400 hover:text-red-600 p-2 -my-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
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
                                                className="flex items-center justify-center text-blue-600 hover:text-blue-800 transition-transform active:scale-95 min-w-touch min-h-touch bg-blue-50 rounded-lg shadow-sm border border-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                                title={link.trim()}
                                                aria-label={`Atidaryti nuorodą: ${link.trim()}`}
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
                                    className="flex items-center justify-center gap-1.5 text-pink-600 hover:text-pink-800 hover:bg-pink-50 rounded-lg transition-colors px-2 py-1.5 min-h-touch min-w-touch focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                    title="Peržiūrėti nuotrauką"
                                    aria-label="Peržiūrėti nuotrauką"
                                >
                                    <ImageIcon className="w-4 h-4" />
                                </button>
                            )}
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveModal('comments');
                                }}
                                className="flex items-center justify-center gap-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors px-2 py-1.5 min-h-touch min-w-touch focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                aria-label="Peržiūrėti komentarus"
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

                    <div className="flex items-center gap-2">
                        {(task.completed || task.isDeleted) && isManager && (
                            <Button
                                variant="secondary"
                                icon={Undo2}
                                onClick={(e) => { e.stopPropagation(); setRevertError(''); setConfirmRevert(true); }}
                                className="text-amber-700"
                            >
                                Grąžinti
                            </Button>
                        )}

                        {isManager && taskStatus === 'unapproved' && (
                            <Button
                                variant="primary"
                                onClick={(e) => { e.stopPropagation(); setConfirmApprove(true); }}
                            >
                                Patvirtinti
                            </Button>
                        )}
                    </div>
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

            <DeleteConfirmationModal
                isOpen={showDeleteModal}
                onClose={() => setShowDeleteModal(false)}
                onConfirm={confirmDelete}
                taskTitle={task.title}
            />

            {confirmRevert && (
                <ConfirmDialog
                    open
                    title="Grąžinti užduotį?"
                    message="Užduotis bus grąžinta į aktyvių sąrašą."
                    warning={revertError || undefined}
                    confirmLabel="Grąžinti"
                    variant="primary"
                    onConfirm={performRevert}
                    onCancel={() => setConfirmRevert(false)}
                />
            )}

            {confirmApprove && (
                <ConfirmDialog
                    open
                    title="Patvirtinti užduotį?"
                    message="Užduotis bus patvirtinta ir perkelta į vykdomas."
                    confirmLabel="Patvirtinti"
                    variant="primary"
                    onConfirm={performApprove}
                    onCancel={() => setConfirmApprove(false)}
                />
            )}

            {confirmDeleteCommentIdx !== null && (
                <ConfirmDialog
                    open
                    title="Ištrinti komentarą?"
                    message="Komentaras bus pašalintas visam laikui."
                    confirmLabel="Ištrinti"
                    variant="danger"
                    onConfirm={() => performDeleteComment(confirmDeleteCommentIdx)}
                    onCancel={() => setConfirmDeleteCommentIdx(null)}
                />
            )}
        </>
    );
};

export default React.memo(TaskCard, (prevProps, nextProps) => {
    if (prevProps.role !== nextProps.role) return false;
    if (prevProps.showReorderControls !== nextProps.showReorderControls) return false;
    const prev = prevProps.task;
    const next = nextProps.task;
    if (!prev || !next) return prev === next;
    if (prev.id !== next.id) return false;
    if (prev.updatedAt !== next.updatedAt) return false;
    if (prev.status !== next.status) return false;
    if (prev.timerStatus !== next.timerStatus) return false;
    if (prev.timerStartedAt !== next.timerStartedAt) return false;
    if (prev.comments?.length !== next.comments?.length) return false;
    if (prev.timeChanged !== next.timeChanged) return false;
    if (prev.timeLimitReached !== next.timeLimitReached) return false;
    if (prev.estimatedTime !== next.estimatedTime) return false;
    if (prev.title !== next.title) return false;
    if (prev.priority !== next.priority) return false;
    return true;
});
