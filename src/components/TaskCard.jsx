import React, { useState, useEffect, useRef } from 'react';
import { Clock, Link as LinkIcon, MessageCircle, FileText, Calendar, Trash2, ArrowUp, ArrowDown, ImageIcon, Edit, Undo2, ListChecks } from 'lucide-react';
import clsx from 'clsx';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { LinksModal, CommentsModal, DescriptionModal, ImageModal, ChecklistModal, DeleteConfirmationModal } from './TaskDetailsModals';
import { InlineEditModal } from './InlineEditModal';
import TaskTimerControls from './TaskTimerControls';
import { deleteTask, revertTask } from '../utils/taskActions';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString, parseTimeStringToMinutes } from '../utils/timeUtils';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import ConfirmDialog from './ui/ConfirmDialog';
import TaskStatusPill from './task/TaskStatusPill';
import PriorityBadge from './task/PriorityBadge';
import DeletedBadge from './task/DeletedBadge';
import AssigneeChip from './task/AssigneeChip';
import { addComment, updateComment, deleteComment } from '../utils/commentActions';
import { toggleChecklistItem, addChecklistItem, deleteChecklistItem, getChecklistProgress } from '../utils/checklistActions';
import { logError } from '../utils/errorLog';
import { STATUS_STYLES } from '../utils/taskConstants';
import { useIsTaskRunning } from '../hooks/useIsTaskRunning';


const TaskCard = ({ task, onEdit, role, showReorderControls, onMoveUp, onMoveDown }) => {
    const { currentUser, userRole } = useAuth();
    const [activeModal, setActiveModal] = useState(null);
    const [editingField, setEditingField] = useState(null);
    const [editingCommentIndex, setEditingCommentIndex] = useState(null);
    const [editCommentText, setEditCommentText] = useState('');
    const [commentError, setCommentError] = useState('');
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [spentMinutes, setSpentMinutes] = useState(0);
    const [confirmRevert, setConfirmRevert] = useState(false);
    const [revertError, setRevertError] = useState('');
    const [confirmApprove, setConfirmApprove] = useState(false);
    const [confirmDeleteCommentIdx, setConfirmDeleteCommentIdx] = useState(null);
    const [actionError, setActionError] = useState('');
    // One-shot completion celebration: fires only on a live not-done -> done transition while
    // the card is mounted, so already-finished cards (history) never replay it.
    const [justCompleted, setJustCompleted] = useState(false);
    const prevCompletedRef = useRef(task.completed);

    const handleUpdateComment = async (index, newText) => {
        try {
            setCommentError('');
            await updateComment(task.id, index, newText, task.comments);
            setEditingCommentIndex(null);
            setEditCommentText('');
        } catch (err) {
            // Inline accessible error instead of the banned window.alert; also log durably.
            logError(err, { source: 'handler:updateComment' });
            setCommentError('Nepavyko atnaujinti komentaro. Bandykite dar kartą.');
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

    useEffect(() => {
        const wasCompleted = prevCompletedRef.current;
        prevCompletedRef.current = task.completed;
        if (!wasCompleted && task.completed) {
            setJustCompleted(true);
            const t = setTimeout(() => setJustCompleted(false), 1500);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [task.completed]);


    const handleAddComment = async (text) => {
        try {
            setActionError('');
            await addComment(task.id, text, currentUser, task.comments);
        } catch (err) {
            // Inline accessible error instead of the banned window.alert; also log durably.
            logError(err, { source: 'handler:addComment' });
            setActionError('Nepavyko pridėti komentaro. Bandykite dar kartą.');
        }
    };

    // Checklist live mutations. The assigned worker (or a manager) ticks items
    // straight from the card; each write rewrites the task's `checklist` array.
    const checklistCollection = task.isArchived ? 'archived_tasks' : 'tasks';

    const handleToggleChecklist = async (itemId) => {
        try {
            setActionError('');
            await toggleChecklistItem(task.id, itemId, currentUser, task.checklist, checklistCollection);
        } catch (err) {
            logError(err, { source: 'handler:toggleChecklist' });
            setActionError('Nepavyko atnaujinti sąrašo. Bandykite dar kartą.');
        }
    };

    const handleAddChecklist = async (text) => {
        try {
            setActionError('');
            await addChecklistItem(task.id, text, task.checklist, checklistCollection);
        } catch (err) {
            logError(err, { source: 'handler:addChecklist' });
            setActionError('Nepavyko pridėti punkto. Bandykite dar kartą.');
        }
    };

    const handleDeleteChecklist = async (itemId) => {
        try {
            setActionError('');
            await deleteChecklistItem(task.id, itemId, task.checklist, checklistCollection);
        } catch (err) {
            logError(err, { source: 'handler:deleteChecklist' });
            setActionError('Nepavyko ištrinti punkto. Bandykite dar kartą.');
        }
    };

    const handleDeleteTask = () => {
        setShowDeleteModal(true);
    };

    const confirmDelete = async ({ keepWorkHours }) => {
        try {
            setActionError('');
            await deleteTask(task, currentUser.uid, { keepWorkHours });
            setShowDeleteModal(false);
        } catch (err) {
            // Inline accessible error instead of the banned window.alert; also log durably.
            logError(err, { source: 'handler:deleteTask' });
            setActionError('Nepavyko ištrinti užduoties. Bandykite dar kartą.');
        }
    };

    // Estimated vs. spent — the card's primary glance signal ("time first"). The limit state
    // is derived from raw math (not the task.timeLimitReached flag) so a manual time reduction
    // instantly un-reds the card without needing a flag wipe.
    const estMinutes = parseTimeStringToMinutes(task.estimatedTime || '0');
    const isLimitExceeded = estMinutes > 0 && spentMinutes >= estMinutes;
    const progressPct = estMinutes > 0 ? Math.min(100, Math.round((spentMinutes / estMinutes) * 100)) : 0;
    const hasTimeInfo = Boolean(task.estimatedTime) || spentMinutes > 0;

    const timeAccent = isLimitExceeded
        ? 'text-feedback-danger'
        : isRunning
            ? 'text-session-task-accent'
            : 'text-ink-strong';
    const progressFill = isLimitExceeded
        ? 'bg-feedback-danger'
        : isRunning
            ? 'bg-session-task-accent'
            : 'bg-brand';
    const timeCaption = spentMinutes > 0
        ? (task.estimatedTime ? 'praleista / planas' : 'praleista')
        : (task.estimatedTime ? 'planas' : '');

    // Status pill (Vyksta / Pristabdyta / Nepradėtas / Nepatvirtinta / Patvirtinta) is derived
    // centrally by <TaskStatusPill> so every surface reads identically; the live timer feeds it
    // via isRunning. `taskStatus` is still used below for the card shell + unapproved styling.

    return (
        <>
            <div
                className={clsx(
                    "rounded-card border-2 shadow-sm p-3 mb-2 transition-shadow duration-base",
                    isRunning ? "bg-session-task-surface border-session-task-shell"
                        : task.inspectionStatus === 'inspecting' ? "bg-feedback-info-soft border-feedback-info-border"
                        : isLimitExceeded ? "bg-feedback-danger-soft border-feedback-danger-border"
                        : (STATUS_STYLES[taskStatus] || "bg-surface-card border-line"),
                    task.completed && "opacity-75",
                    justCompleted && "wz-flash-success"
                )}
            >
                <div className="flex items-start gap-2">
                    {showReorderControls && (
                        <div className="flex flex-col gap-0.5 -ml-1">
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

                    <div className="flex-1 min-w-0">
                        {/* Title + live status — the two things a worker reads first */}
                        <div className="flex items-start justify-between gap-2 mb-2">
                            <h3
                                className={clsx(
                                    "flex-1 min-w-0 text-body font-bold leading-tight",
                                    (task.completed || task.isDeleted) ? "line-through text-ink-muted" : "text-ink-strong",
                                    taskStatus === 'unapproved' ? "rounded bg-surface-sunken px-2 py-1 text-ink" : ""
                                )}
                            >
                                {task.title}
                                {task.isDeleted && <DeletedBadge inline className="ml-2" />}
                            </h3>

                            <div className="flex items-center gap-1.5 shrink-0">
                                <TaskStatusPill
                                    task={task}
                                    isRunning={isRunning}
                                    justCompleted={justCompleted}
                                    className={justCompleted ? 'wz-pop' : undefined}
                                />
                                {isManager && (
                                    <IconButton
                                        icon={Trash2}
                                        label="Ištrinti užduotį"
                                        variant="danger"
                                        onClick={(e) => { e.stopPropagation(); handleDeleteTask(); }}
                                        className="-mr-1"
                                    />
                                )}
                            </div>
                        </div>

                        {/* Hero: time first. Spent is the prominent number; planned is muted; a
                            thin progress bar gives the at-a-glance spent/planned ratio. */}
                        {hasTimeInfo && (
                            <div className="mb-2">
                                <div className="flex items-baseline flex-wrap gap-x-1.5 gap-y-0.5">
                                    <Clock className={clsx("w-4 h-4 self-center shrink-0", timeAccent)} aria-hidden="true" />
                                    <span className={clsx("text-h3 font-bold font-mono leading-none tabular-nums", timeAccent)}>
                                        {formatMinutesToTimeString(spentMinutes)}
                                    </span>
                                    {task.estimatedTime && (
                                        <span className="text-body font-mono text-ink-muted tabular-nums">/ {task.estimatedTime}</span>
                                    )}
                                    {timeCaption && (
                                        <span className="ml-0.5 text-caption text-ink-muted">{timeCaption}</span>
                                    )}
                                </div>
                                {estMinutes > 0 && (
                                    <div
                                        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
                                        role="progressbar"
                                        aria-valuenow={progressPct}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-label="Sugaišto laiko dalis nuo suplanuoto"
                                    >
                                        <div
                                            className={clsx("h-full rounded-full transition-all duration-base", progressFill)}
                                            style={{ width: `${progressPct}%` }}
                                        />
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Secondary meta — one calm, muted line. Priority keeps its (WCAG-correct)
                            color as the single meaningful accent; the rest stays quiet. */}
                        {(task.priority || task.deadline || (task.assignedUserName && (isManager || !isAssignedToMe)) || task.tag || task.managerName || task.creatorName) && (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1.5 text-caption text-ink-muted">
                                {task.priority && <PriorityBadge priority={task.priority} pill />}

                                {task.deadline && (
                                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                        <Calendar className="w-3 h-3" aria-hidden="true" />
                                        {task.deadline}
                                    </span>
                                )}

                                {task.assignedUserName && (isManager || !isAssignedToMe) && (
                                    <AssigneeChip name={task.assignedUserName} color={displayColor} ring />
                                )}

                                {task.tag && (
                                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                        <span className="w-1.5 h-1.5 rounded-full bg-ink-muted" aria-hidden="true"></span>
                                        {task.tag}
                                    </span>
                                )}

                                {(task.managerName || task.creatorName) && (
                                    <span className="inline-flex items-center whitespace-nowrap">
                                        Vadovas: {formatDisplayName(task.managerName || task.creatorName)}
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Description Section */}
                        {task.description && (
                            <div className="mb-1.5">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveModal('description');
                                    }}
                                    className={clsx(
                                        "w-full text-left p-2 rounded-control border border-line transition-all",
                                        "bg-surface-sunken hover:bg-surface-sunken active:scale-[0.98]",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                                        task.completed ? "opacity-60" : "opacity-100"
                                    )}
                                >
                                    <div className="flex items-start gap-1.5">
                                        <FileText className="w-3.5 h-3.5 text-ink-muted mt-0.5 flex-shrink-0" aria-hidden="true" />
                                        <div className="flex-1">
                                            <p className="text-caption text-ink line-clamp-2 leading-snug whitespace-pre-wrap">
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
                                        <div key={index} className="bg-surface-sunken p-2 rounded-control border border-line">
                                            <div className="flex justify-between items-start mb-0.5">
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-caption font-bold text-ink">
                                                        {formatDisplayName(comment.user)}
                                                    </span>
                                                    <span className="text-caption text-ink-muted">
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
                                                            className="inline-flex items-center justify-center min-h-touch min-w-touch text-ink-muted hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
                                                        >
                                                            <Edit className="w-4 h-4" aria-hidden="true" />
                                                        </button>
                                                        <button
                                                            aria-label="Ištrinti komentarą"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setConfirmDeleteCommentIdx(index);
                                                            }}
                                                            className="inline-flex items-center justify-center min-h-touch min-w-touch text-ink-muted hover:text-feedback-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
                                                        >
                                                            <Trash2 className="w-4 h-4" aria-hidden="true" />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>

                                            {isEditing ? (
                                                <div onClick={(e) => e.stopPropagation()}>
                                                    <textarea
                                                        value={editCommentText}
                                                        onChange={(e) => setEditCommentText(e.target.value)}
                                                        className="w-full text-body-lg p-1.5 border border-line rounded-input"
                                                        rows={2}
                                                    />
                                                    {commentError && (
                                                        <p role="alert" className="mt-1 text-caption font-medium text-feedback-danger">
                                                            {commentError}
                                                        </p>
                                                    )}
                                                    <div className="flex justify-end gap-2 mt-1">
                                                        <button
                                                            onClick={() => { setCommentError(''); setEditingCommentIndex(null); }}
                                                            className="min-h-touch text-caption text-ink-muted hover:text-ink px-3 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                                        >
                                                            Atšaukti
                                                        </button>
                                                        <button
                                                            onClick={() => handleUpdateComment(index, editCommentText)}
                                                            className="min-h-touch text-caption bg-brand text-white px-3 rounded-control hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                                        >
                                                            Išsaugoti
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <p className="text-caption text-ink leading-snug break-words whitespace-pre-wrap">
                                                    {comment.text}
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Attachments, links, comments and edit */}
                        <div className="flex items-center gap-3 mt-0.5">
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
                                                className="flex items-center justify-center text-brand hover:text-brand-hover transition-transform active:scale-95 min-w-touch min-h-touch bg-brand-soft rounded-control shadow-sm border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                                title={link.trim()}
                                                aria-label={`Atidaryti nuorodą: ${link.trim()}`}
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <LinkIcon className="w-4 h-4" aria-hidden="true" />
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
                                    className="flex items-center justify-center gap-1.5 text-ink-muted hover:text-ink hover:bg-surface-sunken rounded-control transition-colors px-2 py-1.5 min-h-touch min-w-touch focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                    title="Peržiūrėti nuotrauką"
                                    aria-label="Peržiūrėti nuotrauką"
                                >
                                    <ImageIcon className="w-4 h-4" aria-hidden="true" />
                                </button>
                            )}
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveModal('comments');
                                }}
                                className="flex items-center justify-center gap-1.5 text-ink-muted hover:text-ink-strong hover:bg-surface-sunken rounded-control transition-colors px-2 py-1.5 min-h-touch min-w-touch focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                aria-label="Peržiūrėti komentarus"
                            >
                                <MessageCircle className="w-4 h-4" aria-hidden="true" />
                                <span className="text-caption font-bold">{task.comments?.length || 0}</span>
                            </button>
                            {task.checklist && task.checklist.length > 0 && (() => {
                                const { done, total, allDone } = getChecklistProgress(task.checklist);
                                return (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setActiveModal('checklist'); }}
                                        className={clsx(
                                            "flex items-center justify-center gap-1.5 rounded-control transition-colors px-2 py-1.5 min-h-touch min-w-touch hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                                            allDone ? "text-feedback-success" : "text-ink-muted hover:text-ink-strong"
                                        )}
                                        aria-label={`Kontrolinis sąrašas: atlikta ${done} iš ${total}`}
                                    >
                                        <ListChecks className="w-4 h-4" aria-hidden="true" />
                                        <span className="text-caption font-bold tabular-nums">{done}/{total}</span>
                                    </button>
                                );
                            })()}
                            {onEdit && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEdit(task);
                                    }}
                                    className="flex items-center justify-center gap-1 text-caption font-medium text-brand bg-brand-soft hover:bg-brand-soft/70 px-3 py-1.5 rounded-control transition-colors ml-auto min-h-touch focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                >
                                    <Edit className="w-3.5 h-3.5" aria-hidden="true" />
                                    Redaguoti
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Footer: timer controls (the primary action) + manager actions */}
                {actionError && (
                    <p role="alert" className="mt-1 text-caption font-medium text-feedback-danger">
                        {actionError}
                    </p>
                )}
                <div className="flex items-center justify-between gap-2 mt-0.5">
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

            <ImageModal
                isOpen={activeModal === 'image'}
                onClose={() => setActiveModal(null)}
                imageUrls={task.attachmentUrls && task.attachmentUrls.length > 0 ? task.attachmentUrls : (task.attachmentUrl ? [task.attachmentUrl] : [])}
            />

            <ChecklistModal
                isOpen={activeModal === 'checklist'}
                onClose={() => setActiveModal(null)}
                checklist={task.checklist}
                canEdit={(isManager || isAssignedToMe) && !task.isDeleted}
                onToggle={handleToggleChecklist}
                onAdd={handleAddChecklist}
                onDelete={handleDeleteChecklist}
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
    if ((prev.checklist?.length || 0) !== (next.checklist?.length || 0)) return false;
    {
        const doneCount = (arr) => (arr || []).reduce((n, i) => n + (i && i.done ? 1 : 0), 0);
        if (doneCount(prev.checklist) !== doneCount(next.checklist)) return false;
    }
    if (prev.timeChanged !== next.timeChanged) return false;
    if (prev.timeLimitReached !== next.timeLimitReached) return false;
    if (prev.estimatedTime !== next.estimatedTime) return false;
    if (prev.title !== next.title) return false;
    if (prev.priority !== next.priority) return false;
    return true;
});
