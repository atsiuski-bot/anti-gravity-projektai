import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { Clock, Calendar, Trash2, ArrowUp, ArrowDown, Undo2, Edit, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { ChecklistModal, DeleteConfirmationModal, TimeAdjustmentsModal } from './TaskDetailsModals';
import TaskTimerControls from './TaskTimerControls';
import { deleteTask, revertTask } from '../utils/taskActions';
import { approveTask, humanActor, MODES } from '../domain';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString, parseTimeStringToMinutes } from '../utils/timeUtils';
import { isManagerRole } from '../utils/formatters';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import ConfirmDialog from './ui/ConfirmDialog';
import PriorityBadge from './task/PriorityBadge';
import DeletedBadge from './task/DeletedBadge';
import AssigneeChip from './task/AssigneeChip';
import UserChip from './UserChip';
import TaskDetailModal from './task/TaskDetailModal';
import { toggleChecklistItem, addChecklistItem, deleteChecklistItem } from '../utils/checklistActions';
import { logError } from '../utils/errorLog';
import { STATUS_STYLES } from '../utils/taskConstants';
import { deriveTaskStatus } from '../utils/taskStatus';
import { useIsTaskRunning } from '../hooks/useIsTaskRunning';

/**
 * STATUS_ICON_TONE — color for the standalone leading status glyph, mirroring StatusPill's
 * tone→text-color map (the pill itself is gone from the card; the glyph alone now carries the
 * state to the left of the title). The finished/running/awaiting glyphs are self-colored
 * (green/amber baked in), so the tone here only actually paints the monochrome pending/paused
 * shapes — but keeping the full map means a tone change can never silently fall back to ink.
 */
const STATUS_ICON_TONE = {
    neutral: 'text-ink',
    pending: 'text-feedback-warning-text',
    running: 'text-feedback-success-text',
    done: 'text-ink-muted',
    success: 'text-feedback-success-text',
    info: 'text-feedback-info-text',
    danger: 'text-feedback-danger-text',
};

/**
 * useOneLineActions — keeps the footer action buttons on a SINGLE row, full-width-adaptive, and
 * collapses every label to icon-only the moment the labelled set no longer fits.
 *
 * It measures fit instead of guessing a viewport breakpoint: an invisible mirror row holds the
 * SAME buttons at their natural (labelled) width; we compare that needed width to the real row's
 * available width. Because the mirror always carries labels, the measurement is independent of
 * the current compact state — so the decision can't oscillate.
 *
 * Re-measurement is belt-and-suspenders: a cheap pass after every render (one reflow per commit;
 * the card already re-renders on its time ticker) covers becoming-visible — e.g. mounting inside
 * an inactive tab, where clientWidth is 0 and any decision would be wrong — plus a ResizeObserver
 * for instant response to width changes that don't trigger a render (dragging a desktop window
 * edge, orientation change).
 */
function useOneLineActions() {
    const rowRef = useRef(null);
    const mirrorRef = useRef(null);
    const [compact, setCompact] = useState(false);

    const measure = useCallback(() => {
        const row = rowRef.current;
        const mirror = mirrorRef.current;
        if (!row || !mirror) return;
        // Skip while hidden (clientWidth 0): a later render/resize re-measures once visible.
        // mirror is overflow-hidden, so scrollWidth is the full labelled width even when wider
        // than the card. setCompact bails on an unchanged value, so this can never loop.
        if (row.clientWidth === 0) return;
        setCompact(mirror.scrollWidth > row.clientWidth + 0.5);
    }, []);

    useLayoutEffect(() => { measure(); });

    useLayoutEffect(() => {
        const row = rowRef.current;
        if (!row || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => measure());
        ro.observe(row);
        return () => ro.disconnect();
    }, [measure]);

    return { rowRef, mirrorRef, compact };
}

/**
 * TaskCard — the spacious mobile list card. A compact summary that OPENS the shared task preview
 * (TaskDetailModal) on tap. Top-to-bottom: a leading status glyph + the title (which wraps with a
 * hanging indent), then priority (· deadline · tag), then the time hero with an always-present
 * coloured bar, then the assignee · Vadovas line, then the action zone — the worker timer and one
 * adaptive row of uniform buttons (revert / approve-confirm / edit / delete) that stay on a single
 * line and collapse to icon-only together when they no longer fit. The heavy detail — description,
 * comments, photos, links — lives in the preview, so the card stays short.
 *
 * Tapping anywhere that is not itself a control (or a person chip) opens the preview; the edit
 * button opens the create/edit form directly, bypassing the preview.
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
    const [confirmComplete, setConfirmComplete] = useState(false);
    const [actionError, setActionError] = useState('');
    // One-shot completion celebration: fires only on a live not-done -> done transition while
    // the card is mounted, so already-finished cards (history) never replay it.
    const [justCompleted, setJustCompleted] = useState(false);
    const prevCompletedRef = useRef(task.completed);

    const performRevert = async () => {
        try {
            await revertTask(task, currentUser);
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
            await approveTask(
                { task },
                { actor: humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email, role: userRole }), mode: MODES.COMMIT, reason: 'approved from task card' },
            );
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
            setConfirmComplete(false);
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

    const timeAccent = isLimitExceeded
        ? 'text-feedback-danger'
        : isRunning
            ? 'text-session-task-accent'
            : 'text-ink-strong';
    // The time bar is ALWAYS shown (a calm full-length track). Its fill tells the story at a
    // glance: green + full when the work is finished (the positive end state), red + full when
    // the planned time ran out before it was finished, otherwise blue at the share of planned
    // time already used (0 % — an empty track — when there is no planned time to measure).
    const isFinished = Boolean(task.completed);
    const barFill = isFinished
        ? 'bg-feedback-success'
        : isLimitExceeded
            ? 'bg-feedback-danger'
            : 'bg-brand';
    const barPct = (isFinished || isLimitExceeded) ? 100 : progressPct;
    const timeCaption = spentMinutes > 0
        ? (task.estimatedTime ? 'praleista / planas' : 'praleista')
        : (task.estimatedTime ? 'planas' : '');

    const managerName = task.managerName || task.creatorName;
    const managerId = task.managerId || task.creatorId;
    const samePerson = !!task.assignedUserId && managerId === task.assignedUserId;
    const showAssignee = task.assignedUserName && (isManager || !isAssignedToMe);

    // Leading status glyph (left of the title) — the card's ONLY status signal now that the
    // right-edge pill is gone. deriveTaskStatus is the single source of state; deleted is its own
    // axis (DeletedBadge + strikethrough), so a deleted task shows no lifecycle glyph here.
    const { Icon: StatusIcon, tone: statusTone, label: statusLabel } = deriveTaskStatus(task, { isRunning });
    const showStatusIcon = !task.isDeleted && Boolean(StatusIcon);

    // Manager sign-off actions, mirroring TaskDetailModal so the card and the preview agree:
    // a finished task ("Nepatvirtinta") can be confirmed OR sent back, an unapproved task can be
    // approved, and any finished/deleted task can be reverted.
    const canConfirm = isManager && taskStatus === 'completed';
    const canApprove = isManager && taskStatus === 'unapproved';
    const canRevert = isManager && (task.completed || task.isDeleted);

    // Footer actions, data-driven so the SAME list feeds both the visible (adaptive) row and the
    // hidden measuring mirror. Order: revert → approve/confirm → edit → delete, so the
    // destructive Trinti sits at the far edge (DESIGN_SYSTEM §8). Every entry renders as the same
    // kind of button; they share the row width and collapse to icon-only together when too tight.
    const actions = [];
    if (canRevert) actions.push({
        key: 'revert', label: 'Grąžinti', icon: Undo2, variant: 'secondary',
        onClick: (e) => { e.stopPropagation(); setRevertError(''); setConfirmRevert(true); },
    });
    if (canApprove) actions.push({
        key: 'approve', label: 'Patvirtinti', icon: CheckCircle2, variant: 'success',
        onClick: (e) => { e.stopPropagation(); setConfirmApprove(true); },
    });
    if (canConfirm) actions.push({
        key: 'confirm', label: 'Patvirtinti', icon: CheckCircle2, variant: 'success',
        onClick: (e) => { e.stopPropagation(); setConfirmComplete(true); },
    });
    if (onEdit) actions.push({
        key: 'edit', label: 'Redaguoti', icon: Edit, variant: 'primary',
        onClick: (e) => { e.stopPropagation(); onEdit(task); },
    });
    if (isManager) actions.push({
        key: 'delete', label: 'Trinti', icon: Trash2, variant: 'danger',
        onClick: (e) => { e.stopPropagation(); handleDeleteTask(); },
    });
    const { rowRef: actionsRowRef, mirrorRef: actionsMirrorRef, compact: actionsCompact } =
        useOneLineActions();

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
                        {/* Title row — a leading status glyph (the card's only status signal) sits to
                            the LEFT; the title takes the rest and wraps with a hanging indent, so a
                            second line starts under the first line's text, never under the glyph. */}
                        <div className="flex items-start gap-2 mb-2">
                            {showStatusIcon && (
                                <span className={clsx("mt-0.5 shrink-0", justCompleted && 'wz-pop')} title={statusLabel}>
                                    <StatusIcon className={clsx("h-5 w-5", STATUS_ICON_TONE[statusTone] || STATUS_ICON_TONE.neutral)} aria-hidden="true" />
                                    <span className="sr-only">{statusLabel}</span>
                                </span>
                            )}
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); openDetail(); }}
                                className={clsx(
                                    "flex-1 min-w-0 rounded text-left text-body font-bold leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                                    task.isDeleted ? "line-through text-ink-muted" : task.completed ? "text-ink" : "text-ink-strong",
                                    taskStatus === 'unapproved' ? "bg-surface-sunken px-2 py-1 text-ink" : ""
                                )}
                            >
                                {task.title}
                                {task.isDeleted && <DeletedBadge inline className="ml-2" />}
                            </button>
                        </div>

                        {/* Priority first, directly under the title — with any deadline / tag on the
                            same line. */}
                        {(task.priority || task.deadline || task.tag) && (
                            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-muted">
                                {task.priority && <PriorityBadge priority={task.priority} pill />}

                                {task.deadline && (
                                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                        <Calendar className="w-3 h-3" aria-hidden="true" />
                                        {task.deadline}
                                    </span>
                                )}

                                {task.tag && (
                                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                        <span className="w-1.5 h-1.5 rounded-full bg-ink-muted" aria-hidden="true"></span>
                                        {task.tag}
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Time hero — spent is the prominent number, planned is muted. The bar below
                            is ALWAYS present: a full-length track whose fill is blue (share of the
                            planned time used), green once the work is finished, or red when the
                            planned time ran out before it was finished. */}
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
                            <div
                                className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
                                role="progressbar"
                                aria-valuenow={barPct}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-label="Sugaišto laiko dalis nuo suplanuoto"
                            >
                                <div
                                    className={clsx("h-full rounded-full transition-all duration-base", barFill)}
                                    style={{ width: `${barPct}%` }}
                                />
                            </div>
                        </div>

                        {/* Who does it · who manages — one calm line (deduped when they are the same
                            person). */}
                        {(showAssignee || (managerName && !samePerson)) && (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-muted">
                                {showAssignee && (
                                    <AssigneeChip userId={task.assignedUserId} name={task.assignedUserName} color={displayColor} ring />
                                )}

                                {managerName && !samePerson && (
                                    <span className="inline-flex items-center whitespace-nowrap">
                                        Vad. <UserChip userId={managerId} name={managerName} className="ml-1" />
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
                <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                    <TaskTimerControls
                        task={task}
                        role={role}
                    />

                    {/* One adaptive row: every action is the SAME kind of button (Redaguoti and
                        Trinti included), they share the width and stay on a single line. A hidden
                        mirror (same buttons at natural, labelled width) measures whether the labels
                        fit; when they don't, all buttons drop to icon-only together — still real,
                        bordered/filled buttons with a 44px target and an accessible name (via
                        aria-label/title), never a bare glyph. */}
                    {actions.length > 0 && (
                        <div className="relative mt-2">
                            <div
                                ref={actionsMirrorRef}
                                aria-hidden="true"
                                className="pointer-events-none invisible absolute inset-x-0 top-0 flex gap-1.5 overflow-hidden"
                            >
                                {actions.map((a) => (
                                    <Button
                                        key={a.key}
                                        variant={a.variant}
                                        size="md"
                                        icon={a.icon}
                                        tabIndex={-1}
                                        className="shrink-0 whitespace-nowrap px-3"
                                    >
                                        {a.label}
                                    </Button>
                                ))}
                            </div>
                            <div ref={actionsRowRef} className="flex items-center gap-1.5">
                                {actions.map((a) => (
                                    <Button
                                        key={a.key}
                                        variant={a.variant}
                                        size="md"
                                        icon={a.icon}
                                        aria-label={a.label}
                                        title={a.label}
                                        className="min-w-0 flex-auto px-3"
                                        onClick={a.onClick}
                                    >
                                        {!actionsCompact && <span className="truncate">{a.label}</span>}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    )}
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

            {confirmComplete && (
                <ConfirmDialog
                    open
                    title="Patvirtinti atliktą darbą?"
                    message="Užduoties atlikimas bus patvirtintas."
                    confirmLabel="Patvirtinti"
                    variant="primary"
                    onConfirm={performConfirm}
                    onCancel={() => setConfirmComplete(false)}
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
