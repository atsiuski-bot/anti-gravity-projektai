import React, { useState, useEffect, useRef } from 'react';
import { Clock, Calendar, Trash2, ArrowUp, ArrowDown, Undo2, Edit, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { ChecklistModal, DeleteConfirmationModal, TimeAdjustmentsModal } from './TaskDetailsModals';
import TaskTimerControls from './TaskTimerControls';
import { deleteTask, revertTask } from '../utils/taskActions';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString, parseTimeStringToMinutes } from '../utils/timeUtils';
import { isManagerRole } from '../utils/formatters';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import ConfirmDialog from './ui/ConfirmDialog';
import TaskStatusPill from './task/TaskStatusPill';
import PriorityBadge from './task/PriorityBadge';
import DeletedBadge from './task/DeletedBadge';
import CompletedMarker from './task/CompletedMarker';
import AssigneeChip from './task/AssigneeChip';
import UserChip from './UserChip';
import TaskDetailModal from './task/TaskDetailModal';
import { toggleChecklistItem, addChecklistItem, deleteChecklistItem } from '../utils/checklistActions';
import { logError } from '../utils/errorLog';
import { STATUS_STYLES } from '../utils/taskConstants';
import { useIsTaskRunning } from '../hooks/useIsTaskRunning';

/**
 * TaskCard — the spacious mobile list card. It is now a compact summary that OPENS the shared
 * task preview (TaskDetailModal) on tap: title, live status, the time hero, and one calm
 * assignee · Vadovas line, plus a footer with the timer (left) and the contextual
 * approve / revert + an icon-only edit (right). The heavy detail — description, comments,
 * photos, links — lives in the preview, so the card stays short instead of sprawling.
 *
 * Tapping anywhere that is not itself a control (or a person chip) opens the preview; the
 * pencil opens the create/edit form directly, bypassing the preview.
 */
const TaskCard = ({ task, onEdit, role, showReorderControls, onMoveUp, onMoveDown }) => {
    const { currentUser, userRole } = useAuth();
    const [activeModal, setActiveModal] = useState(null); // 'checklist' | 'timeAdjustments'
    const [showDetail, setShowDetail] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [spentMinutes, setSpentMinutes] = useState(0);
    const [confirmRevert, setConfirmRevert] = useState(false);
    const [revertError, setRevertError] = useState('');
    const [confirmApprove, setConfirmApprove] = useState(false);
    const [actionError, setActionError] = useState('');
    // One-shot completion celebration: fires only on a live not-done -> done transition while
    // the card is mounted, so already-finished cards (history) never replay it.
    const [justCompleted, setJustCompleted] = useState(false);
    const prevCompletedRef = useRef(task.completed);

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
            // Approving an unapproved task clears the approval gate → status 'approved'
            // ("Patvirtintas"), the canonical value the notification hub and the table use. The old
            // 'in-progress' read as "Pristabdyta" (paused) via deriveTaskStatus — wrong for a task
            // nobody has started. The worker then sees it is approved and may start it.
            await updateDoc(doc(db, 'tasks', task.id), {
                status: 'approved',
                isApproved: true,
                approvedAt: new Date().toISOString(),
                approvedBy: currentUser.uid,
                updatedAt: new Date().toISOString(),
            });
            setConfirmApprove(false);
        } catch (err) {
            console.error('Error approving task:', err);
        }
    };

    // Confirm finished work (completed -> confirmed). Mirrors the manager table so a manager can
    // sign off a done task straight from the mobile preview, not only on desktop.
    const performConfirm = async () => {
        try {
            const now = new Date().toISOString();
            await updateDoc(doc(db, 'tasks', task.id), {
                status: 'confirmed',
                confirmedBy: currentUser.uid,
                confirmedAt: now,
                updatedAt: now,
            });
        } catch (err) {
            logError(err, { source: 'TaskCard.performConfirm' });
            setActionError('Nepavyko patvirtinti atlikimo. Bandykite dar kartą.');
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

    // Checklist live mutations. The assigned worker (or a manager) ticks items from the preview's
    // checklist modal; each write rewrites the task's `checklist` array.
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

    const managerName = task.managerName || task.creatorName;
    const managerId = task.managerId || task.creatorId;
    const samePerson = !!task.assignedUserId && managerId === task.assignedUserId;
    const showAssignee = task.assignedUserName && (isManager || !isAssignedToMe);

    const openDetail = () => setShowDetail(true);

    return (
        <>
            <div
                onClick={openDetail}
                className={clsx(
                    "rounded-card border-2 shadow-sm p-3 mb-2 cursor-pointer transition-shadow duration-base",
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
                        <div className="flex flex-col gap-0.5 -ml-1" onClick={(e) => e.stopPropagation()}>
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
                        {/* Title + live status — the two things a worker reads first. The title is the
                            keyboard-accessible opener; tapping anywhere on the card opens it too. */}
                        <div className="flex items-start justify-between gap-2 mb-2">
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); openDetail(); }}
                                className={clsx(
                                    "flex-1 min-w-0 rounded text-left text-body font-bold leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                                    task.isDeleted ? "line-through text-ink-muted" : task.completed ? "text-ink" : "text-ink-strong",
                                    taskStatus === 'unapproved' ? "bg-surface-sunken px-2 py-1 text-ink" : ""
                                )}
                            >
                                {!task.isDeleted && <CompletedMarker task={task} className="mr-1.5" />}
                                {task.title}
                                {task.isDeleted && <DeletedBadge inline className="ml-2" />}
                            </button>

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

                        {/* One calm meta line — assignee and Vadovas sit together (deduped when they
                            are the same person). Priority keeps its WCAG-correct colour. */}
                        {(task.priority || task.deadline || showAssignee || task.tag || (managerName && !samePerson)) && (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-muted">
                                {task.priority && <PriorityBadge priority={task.priority} pill />}

                                {task.deadline && (
                                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                        <Calendar className="w-3 h-3" aria-hidden="true" />
                                        {task.deadline}
                                    </span>
                                )}

                                {showAssignee && (
                                    <AssigneeChip userId={task.assignedUserId} name={task.assignedUserName} color={displayColor} ring />
                                )}

                                {task.tag && (
                                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                        <span className="w-1.5 h-1.5 rounded-full bg-ink-muted" aria-hidden="true"></span>
                                        {task.tag}
                                    </span>
                                )}

                                {managerName && !samePerson && (
                                    <span className="inline-flex items-center whitespace-nowrap">
                                        Vadovas: <UserChip userId={managerId} name={managerName} className="ml-1" />
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer: timer (the primary action) on the left; contextual approve / revert and
                    the icon-only edit on the right. */}
                {actionError && (
                    <p role="alert" className="mt-1 text-caption font-medium text-feedback-danger">
                        {actionError}
                    </p>
                )}
                <div className="flex items-center justify-between gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                    <TaskTimerControls
                        task={task}
                        role={role}
                    />

                    <div className="flex items-center gap-1.5">
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
                                icon={CheckCircle2}
                                onClick={(e) => { e.stopPropagation(); setConfirmApprove(true); }}
                            >
                                Patvirtinti
                            </Button>
                        )}

                        {onEdit && (
                            <IconButton
                                icon={Edit}
                                label="Redaguoti"
                                className="text-brand hover:bg-brand-soft"
                                onClick={(e) => { e.stopPropagation(); onEdit(task); }}
                            />
                        )}
                    </div>
                </div>
            </div>

            {/* The shared task preview — opens on tap; read-only with inline comment + photo adding.
                Edit / approve / revert / delete hand back to this card's own dialogs and the form. */}
            <TaskDetailModal
                isOpen={showDetail}
                onClose={() => setShowDetail(false)}
                task={task}
                isRunning={isRunning}
                canManage={isManager}
                canDelete={isManager}
                showManagerLine
                onEdit={onEdit ? (t) => { setShowDetail(false); onEdit(t); } : undefined}
                onDelete={() => { setShowDetail(false); handleDeleteTask(); }}
                onRevert={() => { setShowDetail(false); setRevertError(''); setConfirmRevert(true); }}
                onApprove={() => { setShowDetail(false); setConfirmApprove(true); }}
                onConfirm={isManager ? () => { setShowDetail(false); performConfirm(); } : undefined}
                onOpenChecklist={() => { setShowDetail(false); setActiveModal('checklist'); }}
                onOpenTimeAdjustments={isManager ? () => { setShowDetail(false); setActiveModal('timeAdjustments'); } : undefined}
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

            <TimeAdjustmentsModal
                isOpen={activeModal === 'timeAdjustments'}
                onClose={() => setActiveModal(null)}
                task={task}
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
                    message="Užduotis bus patvirtinta ir perkelta į aktyvias užduotis."
                    confirmLabel="Patvirtinti"
                    variant="primary"
                    onConfirm={performApprove}
                    onCancel={() => setConfirmApprove(false)}
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
