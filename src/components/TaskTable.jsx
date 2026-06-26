import React, { useState, useEffect } from 'react';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { Link as LinkIcon, MessageCircle, CheckCircle2, MessageSquare, ArrowUp, ArrowDown, ImageIcon, Undo2, Clock, AlertCircle, ListChecks, Calendar, Filter, ArrowDownUp, Eye } from 'lucide-react';
import { LinksModal, CommentsModal, DescriptionModal, ImageModal, ChecklistModal, DeleteConfirmationModal, TimeAdjustmentsModal } from './TaskDetailsModals';
import TaskTimerControls from './TaskTimerControls';
import IconButton from './ui/IconButton';
import Select from './ui/Select';
import ConfirmDialog from './ui/ConfirmDialog';
import TaskActionRow from './task/TaskActionRow';
import TaskStatusPill from './task/TaskStatusPill';
import PriorityBadge from './task/PriorityBadge';
import DeletedBadge from './task/DeletedBadge';
import CompletedMarker from './task/CompletedMarker';
import AssigneeChip from './task/AssigneeChip';
import TaskDetailModal from './task/TaskDetailModal';
import TaskStatusIcon from './task/TaskStatusIcon';
import TaskFlagBadges from './task/TaskFlagBadges';
import UserChip from './UserChip';
import TimeChangedWarning from './task/TimeChangedWarning';
import { formatMinutesToTimeString, calculateCurrentTotalMinutes, getLithuanianNow, MAX_SESSION_MINUTES, parseTimeStringToMinutes } from '../utils/timeUtils';
import { deleteTask, revertTask } from '../utils/taskActions';
import { toggleTaskCompletion } from '../utils/taskCompletionActions';
import { approveTask, unapproveTask, completeTask, reopenTask, confirmTask, unconfirmTask, humanActor, MODES } from '../domain';
import { useUndoableAction } from '../hooks/useUndoableAction';
import { isManagerRole } from '../utils/formatters';
import { canEditTask } from '../utils/taskPermissions';
import { getTaskFlagRowBg } from '../utils/taskFlags';
import { addComment, updateComment, deleteComment } from '../utils/commentActions';
import { toggleChecklistItem, addChecklistItem, deleteChecklistItem, getChecklistProgress } from '../utils/checklistActions';
import { logError } from '../utils/errorLog';
import SessionTypeIcon from './SessionTypeIcon';
import { isSelfDirectedTask } from '../utils/selfDirectedTask';

// ---------------------------------------------------------------------------------------------
// Desktop data-grid header controls. Rendered only when the parent passes `gridControls`; without
// it the headers stay static text (back-compat for the read-only "My Tasks" table). Sorting reuses
// the existing comparator modes (no asc/desc) — clicking the active column again resets to 'none'.
// Filtering reuses the canonical Select via its `renderTrigger`, with `alwaysSheet` so the menu
// opens as a Modal sheet that escapes the table's horizontal-scroll clip.
// ---------------------------------------------------------------------------------------------

function SortableHeaderButton({ label, mode, sort }) {
    const active = sort.value === mode;
    return (
        <button
            type="button"
            onClick={() => sort.set(active ? 'none' : mode)}
            aria-pressed={active}
            className={clsx(
                'inline-flex items-center gap-1 rounded px-1 py-1.5 text-caption font-medium uppercase tracking-wider',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
                active ? 'text-brand' : 'text-ink-muted hover:text-ink'
            )}
        >
            <span>{label}</span>
            <ArrowDownUp
                className={clsx('h-3.5 w-3.5 shrink-0', active ? 'text-brand' : 'text-ink-muted opacity-50')}
                aria-hidden="true"
            />
            {active && <span className="sr-only"> (rūšiuojama)</span>}
        </button>
    );
}

// The per-column filter funnel. A compact, dense trigger (NOT the 44px IconButton) so the
// whole "label + sort + funnel" cluster fits inside a narrow data-grid column instead of
// overflowing into the neighbour — this is what made it ambiguous which funnel owned which
// column. Desktop-only header (md:block, mouse-driven), so a sub-44px target is acceptable
// under §9 dual density, matching SortableHeaderButton's footprint. Active = filled brand.
function ColumnFilter({ filter, label }) {
    const active = filter.value !== '' && filter.value != null;
    const selectedLabel = active ? (filter.options.find((o) => o.value === filter.value)?.label ?? '') : '';
    const name = active ? `${label}: ${selectedLabel}` : label;
    return (
        <Select
            value={filter.value}
            onChange={filter.set}
            options={filter.options}
            ariaLabel={name}
            alwaysSheet
            className="shrink-0"
            renderTrigger={({ triggerProps }) => (
                <button
                    {...triggerProps}
                    aria-label={name}
                    title={name}
                    className={clsx(
                        'inline-flex shrink-0 items-center justify-center rounded p-1 transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
                        active ? 'bg-brand text-white' : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'
                    )}
                >
                    <Filter className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                </button>
            )}
        />
    );
}

// Each interactive column header bundles its label, sort toggle and filter funnel into one
// bordered chip. The chip is the "which funnel belongs to which column" cue: the controls are
// visibly boxed together and each column's chip is separated from its neighbours by the cell
// gap, so a funnel can no longer read as belonging to the column beside it.
function HeaderCell({ label, sortMode, sort, filter, filterLabel }) {
    const hasSort = !!sortMode;
    const hasFilter = !!filter;
    if (!hasSort && !hasFilter) return label;
    return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line bg-surface-card px-1.5 py-0.5">
            {hasSort ? <SortableHeaderButton label={label} mode={sortMode} sort={sort} /> : <span className="px-1">{label}</span>}
            {hasFilter && <ColumnFilter filter={filter} label={filterLabel} />}
        </span>
    );
}

const TaskTable = ({ tasks, onEdit, role, showReorderControls, onMoveUp, onMoveDown, hideCheckboxes, gridControls }) => {
    const { currentUser, userRole, userData } = useAuth();
    const runUndoable = useUndoableAction();
    // Data-grid header wiring (see helpers above). Derived once per render; harmless no-ops when
    // `gridControls` is absent.
    const gc = gridControls;
    const sortCols = gc?.sort?.columns || {};
    const filters = gc?.filters || {};
    const ariaSortFor = (mode) => (gc && mode ? (gc.sort.value === mode ? 'other' : 'none') : undefined);
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null }); // { type: 'description'|'links'|'comments', taskId: string }
    const [, setRefreshTick] = useState(0);
    const [deleteModalTask, setDeleteModalTask] = useState(null);

    // The desktop list opens one task at a time in a read/act detail sheet. We store the id (not
    // the task object) so the open sheet always reflects the live task — comments added, time
    // ticked, status changed — instead of a stale snapshot.
    const [detailTaskId, setDetailTaskId] = useState(null);

    // Confirmation dialog targets (replace window.confirm — §8). Each destructive action gates
    // its own state so rapid clicks on different tasks can't race a single shared dialog.
    const [commentDeleteTarget, setCommentDeleteTarget] = useState(null); // { taskId, commentKey }
    const [revertTarget, setRevertTarget] = useState(null);            // task object
    const [reverting, setReverting] = useState(false);

    // Friendly error banner (replaces banned window.alert — §8/§10). Never holds raw err.message;
    // failures are mapped to Lithuanian copy here and recorded durably via logError.
    const [error, setError] = useState('');

    // Auto-refresh timer for running tasks (every 60 seconds)
    useEffect(() => {
        const interval = setInterval(() => {
            setRefreshTick(prev => prev + 1);
        }, 60000); // 60 seconds
        return () => clearInterval(interval);
    }, []);




    const handleUpdateComment = async (taskId, commentKey, newText) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            await updateComment(taskId, commentKey, newText, task?.comments);
        } catch (err) {
            logError(err, { source: 'TaskTable.handleUpdateComment' });
            setError("Nepavyko atnaujinti komentaro.");
        }
    };

    const handleDeleteComment = (taskId, commentKey) => {
        setCommentDeleteTarget({ taskId, commentKey });
    };

    const confirmDeleteComment = async () => {
        if (!commentDeleteTarget) return;
        const { taskId, commentKey } = commentDeleteTarget;
        try {
            const task = tasks.find(t => t.id === taskId);
            await deleteComment(taskId, commentKey, task?.comments);
        } catch (err) {
            // Error managed in utility
        } finally {
            setCommentDeleteTarget(null);
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

    // Completion is a cleanly REVERSIBLE state flip, so it no longer gates behind a confirm dialog
    // (friction before a cheap-to-undo action). It commits immediately and offers an undo for a few
    // seconds (DESIGN_SYSTEM §8). The inverse is the audited mirror command — reopenTask undoes a
    // completion, completeTask undoes an un-check — so the undo is itself a first-class decision.
    const handleToggleComplete = (taskId) => {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        const willComplete = !task.completed;
        const actor = humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email, role: userRole });
        runUndoable({
            run: () => toggleTaskCompletion(task, currentUser, userRole),
            undo: () => (willComplete
                ? reopenTask({ task }, { actor, mode: MODES.COMMIT, reason: 'undo completion' })
                : completeTask({ task }, { actor, mode: MODES.COMMIT, reason: 'undo reopen' })),
            message: willComplete ? 'Užduotis pažymėta atlikta.' : 'Užduotis grąžinta į sąrašą.',
            undoneMessage: willComplete ? 'Atšaukta — užduotis grąžinta į sąrašą.' : 'Atšaukta — užduotis vėl pažymėta atlikta.',
        });
    };

    // Accepting finished work (completed -> confirmed) is a cleanly reversible sign-off, so it is
    // immediate + undoable; both the accept and its undo are audited commands (confirmTask /
    // unconfirmTask — the undo returns the task to 'completed', "awaiting acceptance"). The table
    // pings no one, so there is no notification to defer.
    const handleConfirmTask = (taskId) => {
        // PERMISSION CHECK: Only explicit Managers or Admins can accept tasks.
        // Task-level managers (who are not system managers) cannot accept.
        if (!isManagerRole(userRole)) {
            setError("Tik koordinatoriai gali priimti užduotis.");
            return;
        }
        setError('');
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        const actor = humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email, role: userRole });
        runUndoable({
            // Forward sign-off AND undo are both audited commands (ADR 0015) — confirmTask returns the
            // task to 'completed' on undo, the same state it confirmed from.
            run: () => confirmTask({ task }, { actor, mode: MODES.COMMIT, reason: 'confirmed from task table' }),
            undo: () => unconfirmTask({ task }, { actor, mode: MODES.COMMIT, reason: 'confirm undone from task table' }),
            message: 'Užduotis priimta.',
            undoneMessage: 'Atšaukta — laukiama priėmimo.',
            errorMessage: 'Nepavyko priimti užduoties. Bandykite vėliau.',
        });
    };

    // Manual archiving removed per request. Archive only via nightly automation.

    // Approving clears the approval gate → status 'approved' ("Patvirtintas"). Reversible, so it is
    // immediate + undoable; undo restores the exact prior status. The table pings no one (unlike the
    // bell's approve, whose worker ping is deferred for the undo window).
    const handleApproveTask = (taskId) => {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        const prior = { status: task.status ?? null, isApproved: !!task.isApproved };
        const actor = humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email, role: userRole });
        runUndoable({
            run: () => approveTask({ task }, { actor, mode: MODES.COMMIT, reason: 'approved from task table' }),
            undo: () => unapproveTask({ task, priorStatus: prior.status, priorIsApproved: prior.isApproved }, { actor, mode: MODES.COMMIT, reason: 'approval undone from task table' }),
            message: 'Užduotis patvirtinta.',
            undoneMessage: 'Atšaukta — patvirtinimas atšauktas.',
            errorMessage: 'Nepavyko patvirtinti užduoties. Bandykite vėliau.',
        });
    };

    const handleDeleteTask = (taskId, taskTitle) => {
        const taskToDelete = tasks.find(t => t.id === taskId) || { id: taskId, title: taskTitle };
        setDeleteModalTask(taskToDelete);
    };

    const confirmDeleteTask = async ({ keepWorkHours }) => {
        if (!deleteModalTask) return;
        try {
            await deleteTask(deleteModalTask, currentUser.uid, { keepWorkHours });
            setDeleteModalTask(null);
        } catch (err) {
            logError(err, { source: 'TaskTable.confirmDeleteTask' });
            if (err.code === 'not-found') {
                setError("Užduotis neegzistuoja.");
            } else {
                setError("Nepavyko ištrinti užduoties. Bandykite vėliau.");
            }
        }
    };

    // Revert (restore) a completed/deleted task — confirmed via ConfirmDialog (replaces
    // the inline window.confirm + raw err.message in the action column).
    const confirmRevert = async () => {
        if (!revertTarget) return;
        setReverting(true);
        try {
            await revertTask(revertTarget, currentUser);
            setRevertTarget(null);
        } catch (err) {
            logError(err, { source: 'TaskTable.confirmRevert' });
            if (err.code === 'permission-denied') {
                setError('Tik koordinatoriai gali grąžinti užduotis.');
            } else {
                setError('Nepavyko grąžinti užduoties. Bandykite vėliau.');
            }
            setRevertTarget(null);
        } finally {
            setReverting(false);
        }
    };

    const isTaskRunning = (task) => {
        if (task.timerStatus !== 'running' || !task.timerStartedAt) return false;
        // Guard against an orphaned timer (a worker's app died mid-run): a started-at older
        // than a full max session is a not-yet-recovered stale timer, not a live run, so it
        // must not light up green forever in the manager's team view.
        const startedAt = new Date(task.timerStartedAt).getTime();
        if (Number.isFinite(startedAt) &&
            (getLithuanianNow().getTime() - startedAt) > MAX_SESSION_MINUTES * 60 * 1000) {
            return false;
        }
        // Manager/team view: the running highlight must reflect ANY worker's live timer, so
        // drive it from the team-wide-visible task field alone. The viewer-identity +
        // activeSession cross-check below is only meaningful for a worker viewing their OWN
        // task (the user doc we have is the viewer's), so restrict it to the worker view.
        if (isManagerRole(role)) return true;

        if (currentUser?.uid !== task.assignedUserId) return false;
        const activeSession = userData?.activeSession;
        if (activeSession) return activeSession.type === 'task' && activeSession.taskId === task.id;
        if (userData?.workStatus?.status === 'running') return userData.workStatus.activeTaskId === task.id;
        if (userData?.workStatus?.status === 'idle' || userData?.workStatus?.status === 'paused') return false;
        return false;
    };

    const getStatusStyle = (task) => {
        if (isTaskRunning(task)) return 'bg-session-task-surface border-session-task-shell';

        // Worker-raised attention tint ("Reikia vadovo" red / "Laukiama" blue) — sits above the
        // plain status styling so a flagged row stands out at a glance (the badges name the flag).
        const flagBg = getTaskFlagRowBg(task);
        if (flagBg) return flagBg;

        const status = task.status || 'pending';
        if (status === 'confirmed') return 'bg-surface-base';
        if (status === 'completed') return 'bg-surface-sunken';
        if (status === 'unapproved') return 'bg-feedback-warning-soft';
        return 'bg-surface-card';
    };



    const handleAddComment = async (taskId, text) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            // Optimization: if commentActions is robust to null comments, we can simplify, 
            // but fetching task here is safe if we don't have it passed fully.
            // However, tasks prop usually has comments.
            await addComment(taskId, text, currentUser, task?.comments);
        } catch (err) {
            logError(err, { source: 'TaskTable.handleAddComment' });
            setError("Nepavyko pridėti komentaro.");
        }
    };

    const checklistCollectionFor = (task) => (task?.isArchived ? 'archived_tasks' : 'tasks');

    const handleToggleChecklist = async (taskId, itemId) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            await toggleChecklistItem(taskId, itemId, currentUser, task?.checklist, checklistCollectionFor(task));
        } catch (err) {
            logError(err, { source: 'TaskTable.toggleChecklist' });
            setError('Nepavyko atnaujinti sąrašo.');
        }
    };

    const handleAddChecklist = async (taskId, text) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            await addChecklistItem(taskId, text, task?.checklist, checklistCollectionFor(task));
        } catch (err) {
            logError(err, { source: 'TaskTable.addChecklist' });
            setError('Nepavyko pridėti punkto.');
        }
    };

    const handleDeleteChecklist = async (taskId, itemId) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            await deleteChecklistItem(taskId, itemId, task?.checklist, checklistCollectionFor(task));
        } catch (err) {
            logError(err, { source: 'TaskTable.deleteChecklist' });
            setError('Nepavyko ištrinti punkto.');
        }
    };

    const isWorker = role === 'worker';
    const canManage = isManagerRole(userRole);
    const canDelete = canManage || !isWorker;

    // The ONE lifecycle action set for an active-board task, fed to TaskActionRow so the mobile card
    // and the desktop row show the SAME buttons on a single adaptive line (labels, collapsing to
    // icon-only together when the cell is too tight). Order: revert → approve/confirm. Edit / comment /
    // delete are NOT here — they live in the task detail sheet (open on row click / card tap).
    const buildRowActions = (task) => {
        const acts = [];
        if ((task.completed || task.isDeleted) && canManage) {
            acts.push({ key: 'revert', label: 'Grąžinti', icon: Undo2, variant: 'secondary', onClick: (e) => { e?.stopPropagation?.(); setRevertTarget(task); } });
        }
        if (canManage && task.status === 'unapproved') {
            acts.push({ key: 'approve', label: 'Patvirtinti', icon: CheckCircle2, variant: 'primary', onClick: (e) => { e?.stopPropagation?.(); handleApproveTask(task.id); } });
        }
        if (canManage && task.status === 'completed' && task.status !== 'confirmed') {
            // A completed self-directed job is confirmed through the SAME path as a normal hand-off,
            // but surfaced distinctly (amber "review" tone + Eye) so the manager treats it as
            // "self-directed, give it a glance" rather than a normal hand-off — see isSelfDirectedTask.
            acts.push(isSelfDirectedTask(task)
                ? { key: 'confirm', label: 'Peržiūrėti savarankišką veiklą', icon: Eye, variant: 'secondary', className: 'border-feedback-warning-border bg-feedback-warning-soft text-feedback-warning-text hover:bg-feedback-warning-soft hover:brightness-95', onClick: (e) => { e?.stopPropagation?.(); handleConfirmTask(task.id); } }
                : { key: 'confirm', label: 'Patvirtinti atlikimą', icon: CheckCircle2, variant: 'primary', onClick: (e) => { e?.stopPropagation?.(); handleConfirmTask(task.id); } });
        }
        return acts;
    };

    // "Vad. X" repeats on every row when a list belongs to a single manager — pure noise.
    // Show it only when the list actually mixes managers (then it disambiguates); otherwise it
    // lives in the detail sheet. This is what kills the most-repeated cell in the screenshot.
    const showManagerLine = new Set(
        tasks.map(t => t.managerName || t.creatorName).filter(Boolean)
    ).size > 1;

    // Open a task's detail sheet. Clicking anywhere on a row (that is not itself an action)
    // lands here, so a row with edit access opens an editable sheet and one without opens the
    // same sheet read-only.
    const openDetail = (task) => setDetailTaskId(task.id);
    const closeDetail = () => setDetailTaskId(null);
    const detailTask = detailTaskId ? tasks.find(t => t.id === detailTaskId) : null;

    // Detail-sheet actions that lead to another dialog (edit form, confirm dialogs, the rich
    // sub-modals) close the sheet first, so two modals never stack.
    const editFromDetail = (task) => { closeDetail(); onEdit?.(task); };
    const deleteFromDetail = (task) => { closeDetail(); handleDeleteTask(task.id, task.title); };
    const revertFromDetail = (task) => { closeDetail(); setRevertTarget(task); };
    const confirmFromDetail = (taskId) => { closeDetail(); handleConfirmTask(taskId); };
    const approveFromDetail = (taskId) => { closeDetail(); handleApproveTask(taskId); };
    const openSubModalFromDetail = (type) => (task) => { closeDetail(); setActiveModal({ type, taskId: task.id }); };

    return (
        <div className="bg-surface-card rounded-card shadow-sm border border-line overflow-hidden">
            {/* Friendly error banner — replaces the banned window.alert with mapped LT copy (§8/§10) */}
            {error && (
                <div className="flex items-start gap-3 border-b border-feedback-danger bg-feedback-danger-soft p-4" role="alert">
                    <AlertCircle className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-feedback-danger-text">{error}</p>
                    <button
                        type="button"
                        onClick={() => setError('')}
                        aria-label="Uždaryti pranešimą"
                        className="ml-auto text-body font-medium text-feedback-danger-text underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
                    >
                        Uždaryti
                    </button>
                </div>
            )}
            {/* Mobile / touch: one card per task (never a horizontally-scrolling table — §9).
                Actions are always-visible 44px controls (group-hover is invisible on touch). */}
            <ul className="divide-y divide-line md:hidden">
                {tasks.map((task) => {
                    const isAssignedToMe = currentUser?.uid === task.assignedUserId;
                    const totalMinutes = calculateCurrentTotalMinutes(task);
                    const hasStarted = task.status && task.status !== 'pending';
                    const showTime = totalMinutes > 0 || hasStarted;
                    const checkboxDisabled = !isAssignedToMe || task.status === 'confirmed' || task.status === 'unapproved';
                    const links = (task.links || []).flatMap(l => l.split('\n')).filter(l => l.trim().length > 0).slice(0, 4);
                    const hasImage = (task.attachmentUrls && task.attachmentUrls.length > 0) || task.attachmentUrl;
                    return (
                        <li
                            key={task.id}
                            onClick={() => openDetail(task)}
                            className={clsx('p-4 cursor-pointer', getStatusStyle(task))}
                        >
                            {/* The whole card is the "open the task" target: tapping anywhere that is not
                                itself a control opens the shared detail sheet, where edit / comment / delete
                                now live. The title stays a button for keyboard access. */}
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                    <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); openDetail(task); }}
                                        className={clsx(
                                            'block w-full text-left text-body font-semibold break-words rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                                            task.isDeleted ? 'text-ink-muted line-through' : task.completed ? 'text-ink' : 'text-ink-strong'
                                        )}
                                    >
                                        {!task.isDeleted && <CompletedMarker task={task} className="mr-1.5" />}
                                        {task.title}
                                        {task.isDeleted && <DeletedBadge inline className="ml-2" />}
                                    </button>
                                    {(task.managerName || task.creatorName) && (
                                        <div className="text-caption text-feedback-info-text font-medium mt-0.5">
                                            Koord. <UserChip userId={task.managerId || task.creatorId} name={task.managerName || task.creatorName} />
                                        </div>
                                    )}
                                </div>
                                <PriorityBadge priority={task.priority} className="shrink-0" />
                            </div>

                            {/* Description (opens modal) */}
                            {task.description && (
                                <button
                                    onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'description', taskId: task.id }); }}
                                    className="mt-2 flex items-start gap-1 w-full text-left text-caption text-ink hover:text-brand-hover line-clamp-3 whitespace-pre-wrap rounded-input p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                >
                                    <SessionTypeIcon
                                        type={task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : 'task')}
                                        className="w-3.5 h-3.5 flex-shrink-0 mt-0.5"
                                    />
                                    {task.description}
                                </button>
                            )}

                            {/* Metadata */}
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                                {task.assignedUserName && (
                                    <AssigneeChip userId={task.assignedUserId} name={task.assignedUserName} ring showColor={false} className="max-w-[160px]" />
                                )}
                                <TaskStatusPill task={task} isRunning={isTaskRunning(task)} />
                                <TaskFlagBadges task={task} />
                                {task.tag && (
                                    <span className="px-1.5 py-0.5 inline-flex text-caption leading-4 font-semibold rounded-md bg-feedback-info-soft text-feedback-info-text border border-feedback-info-border">
                                        {task.tag}
                                    </span>
                                )}
                                <span className="text-caption text-ink-muted">Atlikti iki: {formatDeadline(task.deadline)}</span>
                                {task.estimatedTime && (
                                    <span className="text-caption text-ink-muted">Num.: {task.estimatedTime}</span>
                                )}
                            </div>

                            {/* Live time readout (>= text-body-lg per live-timer rule) + adjust control */}
                            {showTime && (
                                <div className="mt-2 flex items-center gap-2">
                                    <span className="text-body-lg text-brand font-bold whitespace-nowrap">
                                        {formatMinutesToTimeString(totalMinutes)}
                                    </span>
                                    {/* Read-only history of legacy time corrections (deltas), shown
                                        only when the task has any. New corrections are made on the
                                        day timeline by editing the specific session. */}
                                    {canManage && task.timeAdjustments?.length > 0 && (
                                        <IconButton
                                            icon={Clock}
                                            label="Peržiūrėti laiko korekcijas"
                                            variant="ghost"
                                            onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'timeAdjustments', taskId: task.id }); }}
                                        />
                                    )}
                                </div>
                            )}
                            <TimeChangedWarning task={task} className="mt-1" />

                            {/* Links + attachments */}
                            {(links.length > 0 || hasImage) && (
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                    {links.map((link, idx) => (
                                        <a
                                            key={idx}
                                            href={link.trim().startsWith('http') ? link.trim() : `https://${link.trim()}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title={link.trim()}
                                            aria-label={`Nuoroda: ${link.trim()}`}
                                            onClick={(e) => e.stopPropagation()}
                                            className="inline-flex items-center justify-center min-h-touch min-w-touch rounded-control text-brand hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                        >
                                            <LinkIcon className="w-5 h-5" aria-hidden="true" />
                                        </a>
                                    ))}
                                    {hasImage && (
                                        <IconButton
                                            icon={ImageIcon}
                                            label="Peržiūrėti nuotrauką"
                                            variant="ghost"
                                            className="text-feedback-danger"
                                            onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'image', taskId: task.id }); }}
                                        />
                                    )}
                                </div>
                            )}

                            {/* Checklist progress */}
                            {task.checklist && task.checklist.length > 0 && (() => {
                                const { done, total, allDone } = getChecklistProgress(task.checklist);
                                return (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'checklist', taskId: task.id }); }}
                                        className={clsx(
                                            'mt-3 inline-flex items-center gap-1.5 rounded-control border border-line px-2 py-1.5 min-h-touch text-caption font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                                            allDone ? 'text-feedback-success' : 'text-ink-muted'
                                        )}
                                        aria-label={`Kontrolinis sąrašas: atlikta ${done} iš ${total}`}
                                    >
                                        <ListChecks className="w-4 h-4" aria-hidden="true" />
                                        <span className="tabular-nums">{done}/{total}</span>
                                    </button>
                                );
                            })()}

                            {/* Comments preview (last 1) + open-modal control */}
                            {task.comments && task.comments.length > 0 && (
                                <div className="mt-3 pl-2 border-l-2 border-brand-soft">
                                    {(() => {
                                        const last = task.comments[task.comments.length - 1];
                                        return (
                                            <div className="text-caption">
                                                <div className="flex items-center gap-1.5">
                                                    <MessageCircle className="w-3.5 h-3.5 text-brand flex-shrink-0" aria-hidden="true" />
                                                    <UserChip userId={last.userId} name={last.user} />
                                                    <span className="text-ink-muted">{new Date(last.createdAt).toLocaleDateString()}</span>
                                                </div>
                                                <div className="text-ink leading-snug break-words pl-4 line-clamp-2">{last.text}</div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            )}

                            {/* Completion checkbox (worker) — prominent labelled control */}
                            {!hideCheckboxes && (
                                <label
                                    onClick={(e) => e.stopPropagation()}
                                    className={clsx(
                                        'mt-3 flex items-center gap-2 min-h-touch',
                                        checkboxDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                                    )}>
                                    <input
                                        type="checkbox"
                                        checked={task.completed || false}
                                        onChange={() => {
                                            if (isAssignedToMe) {
                                                handleToggleComplete(task.id);
                                            }
                                        }}
                                        disabled={checkboxDisabled}
                                        className="w-5 h-5 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                    />
                                    <span className="text-caption text-ink">Atlikta</span>
                                </label>
                            )}

                            {/* One adaptive single-line action row (lifecycle only — edit/comment live
                                in the detail sheet), then the worker timer on its own row below. */}
                            <TaskActionRow actions={buildRowActions(task)} className="mt-3" />

                            <div className="mt-3">
                                <TaskTimerControls task={task} role={role} />
                            </div>
                        </li>
                    );
                })}
            </ul>

            {/* Desktop / wide: denser table is allowed (§9) */}
            <div className="hidden overflow-x-auto md:block">
                <table className="min-w-full divide-y divide-line table-fixed">
                    <thead className="bg-surface-sunken">
                        <tr>
                            {showReorderControls && (
                                <th className="px-2 py-3 text-center text-caption font-medium text-ink-muted uppercase tracking-wider w-10">
                                    #
                                </th>
                            )}
                            {!hideCheckboxes && (
                                <th className="px-2 py-3 text-center text-caption font-medium text-ink-muted uppercase tracking-wider w-10">
                                    ✓
                                </th>
                            )}
                            <th className="px-2 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider">Užduotis</th>
                            <th className="px-1 py-1.5 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-28" aria-sort={ariaSortFor(sortCols.user)}>
                                {gc ? <HeaderCell label="Meist." sortMode={sortCols.user} sort={gc.sort} filter={filters.user} filterLabel="Filtruoti pagal meistrą" /> : 'Meist.'}
                            </th>
                            <th className="px-1 py-1.5 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-28" aria-sort={ariaSortFor(sortCols.priority)}>
                                {gc ? <HeaderCell label="Prior." sortMode={sortCols.priority} sort={gc.sort} filter={filters.priority} filterLabel="Filtruoti pagal prioritetą" /> : 'Prior.'}
                            </th>
                            <th className="px-1 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-24" title="Sugaišta / numatyta">Laikas</th>
                            {/* Žymos sits as far right as possible — directly before the actions block. */}
                            <th className="px-1 py-1.5 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-28" aria-sort={ariaSortFor(sortCols.tag)}>
                                {gc ? <HeaderCell label="Žymos" sortMode={sortCols.tag} sort={gc.sort} filter={filters.tag} filterLabel="Filtruoti pagal žymą" /> : 'Žymos'}
                            </th>
                            <th className="px-2 py-3 text-right text-caption font-medium text-ink-muted uppercase tracking-wider w-64">Veik.</th>
                        </tr>
                    </thead>
                    <tbody className="bg-surface-card divide-y divide-line">
                        {tasks.map((task) => {
                            const isAssignedToMe = currentUser?.uid === task.assignedUserId;
                            const totalMinutes = calculateCurrentTotalMinutes(task);
                            const hasStarted = task.status && task.status !== 'pending';
                            const showSpent = totalMinutes > 0 || hasStarted;
                            // Time progress bar — same glance signal the mobile card carries: green +
                            // full when finished, red + full when the planned time ran out before the
                            // work was done, otherwise blue at the share of planned time already used.
                            // Derived from raw math (not task.timeLimitReached) so a manual time cut
                            // instantly un-reds the row.
                            const estMinutes = parseTimeStringToMinutes(task.estimatedTime || '0');
                            const isLimitExceeded = estMinutes > 0 && totalMinutes >= estMinutes;
                            const isFinished = Boolean(task.completed);
                            const progressPct = estMinutes > 0 ? Math.min(100, Math.round((totalMinutes / estMinutes) * 100)) : 0;
                            const barFill = isFinished
                                ? 'bg-feedback-success'
                                : isLimitExceeded
                                    ? 'bg-feedback-danger'
                                    : 'bg-brand';
                            const barPct = (isFinished || isLimitExceeded) ? 100 : progressPct;
                            const deadline = task.deadline ? formatDeadline(task.deadline) : null;
                            const links = (task.links || []).flatMap(l => l.split('\n')).filter(l => l.trim().length > 0);
                            const hasImage = (task.attachmentUrls && task.attachmentUrls.length > 0) || task.attachmentUrl;
                            const commentCount = task.comments?.length || 0;
                            const checklist = task.checklist && task.checklist.length > 0 ? getChecklistProgress(task.checklist) : null;
                            return (
                                <tr
                                    key={task.id}
                                    onClick={() => openDetail(task)}
                                    className={clsx(
                                        "cursor-pointer transition hover:brightness-[0.97]",
                                        getStatusStyle(task)
                                    )}
                                >
                                    {showReorderControls && (
                                        <td className="px-2 py-3 text-center align-top">
                                            <div className="flex flex-col items-center gap-1">
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
                                        </td>
                                    )}
                                    {!hideCheckboxes && (
                                        <td className="px-1 py-3 text-center align-top">
                                            <input
                                                type="checkbox"
                                                checked={task.completed || false}
                                                onClick={(e) => e.stopPropagation()}
                                                onChange={() => {
                                                    if (isAssignedToMe) {
                                                        handleToggleComplete(task.id);
                                                    }
                                                }}
                                                disabled={!isAssignedToMe || task.status === 'confirmed' || task.status === 'unapproved'}
                                                aria-label="Pažymėti atlikta"
                                                className={clsx(
                                                    "mt-1 w-4 h-4 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1",
                                                    isAssignedToMe && task.status !== 'confirmed' && task.status !== 'unapproved' ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                                                )}
                                            />
                                        </td>
                                    )}
                                    {/* Task — title is the keyboard-accessible opener; the whole row opens on
                                        mouse click. Deadline / links / image / checklist / comments collapse into
                                        one muted indicator row in front of "Vadovas" (tag keeps its own column). */}
                                    <td className="px-2 py-3 align-top">
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); openDetail(task); }}
                                            className={clsx(
                                                // flex + items-start keeps the leading status glyph glued to the
                                                // FIRST line of the title (a wrapping title no longer lets the
                                                // glyph drift to the block's vertical centre); the small top
                                                // nudge on the glyph optically centres it on that line. Replaces
                                                // the old inline align-[-0.2em] that let it sink below the row.
                                                "flex w-full items-start gap-1.5 rounded text-left text-body font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                                                task.isDeleted ? "text-ink-muted line-through" : task.completed ? "text-ink" : "text-ink-strong"
                                            )}
                                        >
                                            {/* Leading status glyph — the same shape the mobile card shows, so the
                                                lifecycle/approval state (pending / running / paused / awaiting /
                                                done / confirmed) is glanceable in front of the title while scanning,
                                                not only in the far-right "Būsena" column. Decorative here: that
                                                column's pill already carries the labelled status for screen readers. */}
                                            <TaskStatusIcon task={task} isRunning={isTaskRunning(task)} size="sm" decorative className="mt-0.5" />
                                            <span className="min-w-0 flex-1 break-words">
                                                {task.title}
                                                {task.isDeleted && <DeletedBadge inline className="ml-2" />}
                                            </span>
                                        </button>
                                        {/* Worker attention flags — shown only while raised; the whole row is
                                            tinted to match (getStatusStyle). */}
                                        <TaskFlagBadges task={task} size="sm" className="mt-1" />
                                        {/* One muted line: the indicators lead, the manager closes it — so a
                                            deadline / urgent / comment glyph rides IN FRONT of "Vadovas" instead
                                            of dropping onto its own extra row and making the task taller. */}
                                        {(task.isSystemTask || task.isQuickWork || deadline || links.length > 0 || hasImage || checklist || commentCount > 0 || (showManagerLine && (task.managerName || task.creatorName))) && (
                                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-muted">
                                                {(task.isSystemTask || task.isQuickWork) && (
                                                    <SessionTypeIcon
                                                        type={task.isSystemTask ? 'call' : 'quickWork'}
                                                        className="h-3.5 w-3.5"
                                                    />
                                                )}
                                                {deadline && (
                                                    <span className="inline-flex items-center gap-1">
                                                        <Calendar className="h-3.5 w-3.5" aria-hidden="true" />{deadline}
                                                    </span>
                                                )}
                                                {links.length > 0 && (
                                                    <span className="inline-flex items-center gap-1">
                                                        <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />{links.length}
                                                    </span>
                                                )}
                                                {hasImage && <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                                                {checklist && (
                                                    <span className={clsx("inline-flex items-center gap-1 tabular-nums", checklist.allDone && "text-feedback-success")}>
                                                        <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />{checklist.done}/{checklist.total}
                                                    </span>
                                                )}
                                                {commentCount > 0 && (
                                                    <span className="inline-flex items-center gap-1">
                                                        <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />{commentCount}
                                                    </span>
                                                )}
                                                {showManagerLine && (task.managerName || task.creatorName) && (
                                                    <span className="inline-flex items-center font-medium text-feedback-info-text">
                                                        Koord. <UserChip userId={task.managerId || task.creatorId} name={task.managerName || task.creatorName} className="ml-1" />
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        <TimeChangedWarning task={task} />
                                    </td>
                                    <td className="px-1 py-3 align-top">
                                        {task.assignedUserName && (
                                            <AssigneeChip userId={task.assignedUserId} name={task.assignedUserName} ring showColor={false} className="max-w-[110px]" />
                                        )}
                                    </td>
                                    <td className="px-1 py-3 align-top whitespace-nowrap">
                                        <PriorityBadge priority={task.priority} />
                                    </td>
                                    {/* Laikas — actual over planned in one cell (replaces the buried in-status
                                        time + the near-empty "Num." column). */}
                                    <td className="px-1 py-3 align-top">
                                        {!showSpent && !task.estimatedTime ? (
                                            <span className="text-ink-muted">–</span>
                                        ) : (
                                            <div className="text-caption leading-tight">
                                                {showSpent && (
                                                    <div className={clsx(
                                                        "text-body font-bold whitespace-nowrap",
                                                        isLimitExceeded ? "text-feedback-danger" : "text-brand"
                                                    )}>{formatMinutesToTimeString(totalMinutes)}</div>
                                                )}
                                                {task.estimatedTime && (
                                                    <div className="text-ink-muted whitespace-nowrap">{showSpent ? `/ ${task.estimatedTime}` : task.estimatedTime}</div>
                                                )}
                                                {/* Same time bar as the mobile card — see derivation above. */}
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
                                        )}
                                    </td>
                                    {/* Žymos — moved to the far right, directly before the actions cell. */}
                                    <td className="px-1 py-3 align-top">
                                        {task.tag && (
                                            <span className="inline-flex items-center rounded-md border border-feedback-info-border bg-feedback-info-soft px-1.5 py-0.5 text-caption font-semibold text-feedback-info-text">
                                                {task.tag}
                                            </span>
                                        )}
                                    </td>
                                    {/* Veik. — the SAME action set the mobile card shows, through the one
                                        adaptive single-line TaskActionRow (labels collapse to icon-only together
                                        when the cell is tight). Edit / comment are not here — they live in the
                                        detail sheet (row click). The worker's timer sits on its own row below. */}
                                    <td className="px-2 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                                        <div className="flex flex-col items-stretch gap-2">
                                            <TaskActionRow actions={buildRowActions(task)} />
                                            <TaskTimerControls task={task} role={role} />
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {/* Modals */}
            {
                activeModal.taskId && (() => {
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
                                currentUserId={currentUser?.uid}
                                canManage={canManage}
                                onUpdateComment={(commentKey, text) => handleUpdateComment(task.id, commentKey, text)}
                                onDeleteComment={(commentKey) => handleDeleteComment(task.id, commentKey)}
                            />
                            <ImageModal
                                isOpen={activeModal.type === 'image'}
                                onClose={() => setActiveModal({ type: null, taskId: null })}
                                imageUrls={task.attachmentUrls && task.attachmentUrls.length > 0 ? task.attachmentUrls : (task.attachmentUrl ? [task.attachmentUrl] : [])}
                            />
                            <ChecklistModal
                                isOpen={activeModal.type === 'checklist'}
                                onClose={() => setActiveModal({ type: null, taskId: null })}
                                checklist={task.checklist}
                                canToggle={(canManage || currentUser?.uid === task.assignedUserId) && !task.isDeleted}
                                canManageItems={canEditTask({ task, currentUser, role, userRole }) && !task.isDeleted}
                                onToggle={(itemId) => handleToggleChecklist(task.id, itemId)}
                                onAdd={(text) => handleAddChecklist(task.id, text)}
                                onDelete={(itemId) => handleDeleteChecklist(task.id, itemId)}
                            />
                            <TimeAdjustmentsModal
                                isOpen={activeModal.type === 'timeAdjustments'}
                                onClose={() => setActiveModal({ type: null, taskId: null })}
                                task={task}
                            />
                        </>
                    );
                })()
            }

            {/* The single "open the task" sheet. Always read-only-capable (so a viewer without
                edit access still sees everything); edit access surfaces the management actions. */}
            <TaskDetailModal
                isOpen={!!detailTask}
                onClose={closeDetail}
                task={detailTask}
                isRunning={detailTask ? isTaskRunning(detailTask) : false}
                canManage={canManage}
                canDelete={canDelete || (detailTask && canEditTask({ task: detailTask, currentUser, role, userRole }))}
                showManagerLine={showManagerLine}
                onEdit={onEdit && detailTask && canEditTask({ task: detailTask, currentUser, role, userRole }) ? editFromDetail : undefined}
                onDelete={deleteFromDetail}
                onRevert={revertFromDetail}
                onConfirm={confirmFromDetail}
                onApprove={approveFromDetail}
                onOpenChecklist={openSubModalFromDetail('checklist')}
                onOpenTimeAdjustments={openSubModalFromDetail('timeAdjustments')}
            />

            <DeleteConfirmationModal
                isOpen={!!deleteModalTask}
                onClose={() => setDeleteModalTask(null)}
                onConfirm={confirmDeleteTask}
                taskTitle={deleteModalTask?.title || ''}
            />

            {/* Marking a task complete is now an immediate, undoable action (see handleToggleComplete)
                — no confirm dialog. Revert/delete keep their confirm because their inverse is
                dual-case/destructive. */}

            {/* Confirm: revert (restore) a completed/deleted task */}
            {revertTarget && (
                <ConfirmDialog
                    open
                    title="Grąžinti užduotį?"
                    message={`Užduotis: ${revertTarget.title || ''}.`}
                    confirmLabel="Grąžinti"
                    variant="primary"
                    loading={reverting}
                    onConfirm={confirmRevert}
                    onCancel={() => setRevertTarget(null)}
                />
            )}

            {/* Confirm: delete a comment (destructive) */}
            {commentDeleteTarget && (
                <ConfirmDialog
                    open
                    title="Ištrinti komentarą?"
                    message="Komentaras bus negrįžtamai ištrintas."
                    warning="Šio veiksmo atšaukti negalėsite."
                    confirmLabel="Ištrinti"
                    variant="danger"
                    onConfirm={confirmDeleteComment}
                    onCancel={() => setCommentDeleteTarget(null)}
                />
            )}

        </div >
    );
};

export default React.memo(TaskTable, (prevProps, nextProps) => {
    if (prevProps.role !== nextProps.role) return false;
    if (prevProps.showReorderControls !== nextProps.showReorderControls) return false;

    // The data-grid headers (active sort caret + funnel "filtered" styling) are driven by
    // gridControls values, not by the task rows. Compare them explicitly, or a re-sort/re-filter
    // that leaves the row set the same length would skip the re-render and strand the header UI.
    const pg = prevProps.gridControls;
    const ng = nextProps.gridControls;
    if (!!pg !== !!ng) return false;
    if (pg && ng) {
        if (pg.sort?.value !== ng.sort?.value) return false;
        const pf = pg.filters || {};
        const nf = ng.filters || {};
        if (pf.user?.value !== nf.user?.value) return false;
        if (pf.priority?.value !== nf.priority?.value) return false;
        if (pf.status?.value !== nf.status?.value) return false;
        if (pf.tag?.value !== nf.tag?.value) return false;
    }

    if (prevProps.tasks?.length !== nextProps.tasks?.length) return false;

    // Fast check by reference and updatedAt
    for (let i = 0; i < (prevProps.tasks?.length || 0); i++) {
        const prevTask = prevProps.tasks[i];
        const nextTask = nextProps.tasks[i];
        if (prevTask.id !== nextTask.id) return false; // order changed
        if (prevTask.updatedAt !== nextTask.updatedAt) return false;
        if (prevTask.status !== nextTask.status) return false;
        if (prevTask.comments?.length !== nextTask.comments?.length) return false;
        if (prevTask.timeChanged !== nextTask.timeChanged) return false;
    }
    return true;
});
