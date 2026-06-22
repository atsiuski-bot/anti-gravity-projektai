import React, { useState, useEffect } from 'react';
import clsx from 'clsx';
import { db } from '../firebase';
import { doc, updateDoc, addDoc, collection, deleteDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { Link as LinkIcon, MessageCircle, CheckCircle2, MessageSquare, Trash2, ArrowUp, ArrowDown, ImageIcon, Undo2, Pencil, Clock, AlertCircle } from 'lucide-react';
import { LinksModal, CommentsModal, DescriptionModal, ImageModal, DeleteConfirmationModal, TimeAdjustmentsModal } from './TaskDetailsModals';
import TaskTimerControls from './TaskTimerControls';
import IconButton from './ui/IconButton';
import ConfirmDialog from './ui/ConfirmDialog';
import Button from './ui/Button';
import StatusPill from './ui/StatusPill';
import { formatMinutesToTimeString, calculateCurrentTotalMinutes, getLithuanianNow, MAX_SESSION_MINUTES } from '../utils/timeUtils';
import { deleteTask, revertTask } from '../utils/taskActions';
import { toggleTaskCompletion } from '../utils/taskCompletionActions';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../utils/priority';
import { addComment, updateComment, deleteComment } from '../utils/commentActions';
import { STATUS_LABELS, STATUS_COLORS } from '../utils/taskConstants';
import { logError } from '../utils/errorLog';
import SessionTypeIcon from './SessionTypeIcon';

const TaskTable = ({ tasks, onEdit, role, showReorderControls, onMoveUp, onMoveDown, hideCheckboxes }) => {
    const { currentUser, userRole, userData } = useAuth();
    const [activeModal, setActiveModal] = useState({ type: null, taskId: null }); // { type: 'description'|'links'|'comments', taskId: string }
    const [, setRefreshTick] = useState(0);
    const [deleteModalTask, setDeleteModalTask] = useState(null);

    // Comment Editing State
    const [editingComment, setEditingComment] = useState({ taskId: null, index: null });
    const [editCommentText, setEditCommentText] = useState('');

    // Confirmation dialog targets (replace window.confirm — §8). Each destructive action gates
    // its own state so rapid clicks on different tasks can't race a single shared dialog.
    const [adjDeleteTarget, setAdjDeleteTarget] = useState(null);       // { taskId, adj }
    const [commentDeleteTarget, setCommentDeleteTarget] = useState(null); // { taskId, index }
    const [completeTarget, setCompleteTarget] = useState(null);        // taskId (marking completed)
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



    const handleAddAdjustment = async (taskId, date, h, m, reason) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;
            const durationMinutes = (parseInt(h) || 0) * 60 + (parseInt(m) || 0);

            const now = getLithuanianNow();
            const newSessionRef = await addDoc(collection(db, 'work_sessions'), {
                taskId: task.id,
                taskTitle: `🕒 Korekcija: ${task.title}${reason ? ` - ${reason}` : ''}`,
                userId: task.assignedUserId || task.creatorId || 'unknown',
                userName: task.assignedUserName || task.creatorName || 'Nežinomas',
                startTime: new Date(date + 'T12:00:00').toISOString(),
                endTime: new Date(date + 'T12:00:00').toISOString(),
                durationMinutes: durationMinutes,
                date: date,
                createdAt: now.toISOString(),
                isManualAdjustment: true
            });

            const newAdj = {
                id: newSessionRef.id,
                date: date,
                durationMinutes: durationMinutes,
                reason: reason,
                createdAt: now.toISOString()
            };

            await updateDoc(doc(db, 'tasks', task.id), {
                timeAdjustments: [...(task.timeAdjustments || []), newAdj],
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            logError(err, { source: 'TaskTable.handleAddAdjustment' });
            if (err.code === 'permission-denied') {
                setError('Neturite leidimo pridėti korekciją.');
            } else if (err.code === 'not-found') {
                setError('Užduotis nebeegzistuoja.');
            } else {
                setError('Nepavyko pridėti laiko korekcijos. Bandykite vėliau.');
            }
        }
    };

    // Invoked from the TimeAdjustmentsModal row; opens a ConfirmDialog instead of window.confirm.
    const handleDeleteAdjustment = (taskId, adj) => {
        setAdjDeleteTarget({ taskId, adj });
    };

    const confirmDeleteAdjustment = async () => {
        if (!adjDeleteTarget) return;
        const { taskId, adj } = adjDeleteTarget;
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) {
                setAdjDeleteTarget(null);
                return;
            }

            await deleteDoc(doc(db, 'work_sessions', adj.id));

            const newAdjustments = (task.timeAdjustments || []).filter(a => a.id !== adj.id);
            await updateDoc(doc(db, 'tasks', task.id), {
                timeAdjustments: newAdjustments,
                updatedAt: new Date().toISOString()
            });
            setAdjDeleteTarget(null);
        } catch (err) {
            logError(err, { source: 'TaskTable.confirmDeleteAdjustment' });
            setError('Nepavyko ištrinti korekcijos.');
            setAdjDeleteTarget(null);
        }
    };

    const handleUpdateComment = async (taskId, index, newText) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            await updateComment(taskId, index, newText, task?.comments);
            setEditingComment({ taskId: null, index: null });
            setEditCommentText('');
        } catch (err) {
            logError(err, { source: 'TaskTable.handleUpdateComment' });
            setError("Nepavyko atnaujinti komentaro.");
        }
    };

    const handleDeleteComment = (taskId, index) => {
        setCommentDeleteTarget({ taskId, index });
    };

    const confirmDeleteComment = async () => {
        if (!commentDeleteTarget) return;
        const { taskId, index } = commentDeleteTarget;
        try {
            const task = tasks.find(t => t.id === taskId);
            await deleteComment(taskId, index, task?.comments);
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

    const performToggleComplete = async (taskId) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;
            await toggleTaskCompletion(task, currentUser.uid, userRole, task.managerId);
        } catch (err) {
            console.error("Error toggling task completion:", err);
        }
    };

    const handleToggleComplete = (taskId, currentStatus) => {
        // Marking a task complete requires confirmation (reversible → primary, not danger);
        // un-checking proceeds directly, preserving the original behaviour.
        if (!currentStatus) {
            setCompleteTarget(taskId);
            return;
        }
        performToggleComplete(taskId);
    };

    const confirmComplete = async () => {
        if (!completeTarget) return;
        const taskId = completeTarget;
        setCompleteTarget(null);
        await performToggleComplete(taskId);
    };

    const handleConfirmTask = async (taskId) => {
        // PERMISSION CHECK: Only explicit Managers or Admins can confirm tasks.
        // Task-level managers (who are not system managers) cannot confirm.
        if (!isManagerRole(userRole)) {
            setError("Tik vadovai gali patvirtinti užduotis.");
            return;
        }
        setError('');

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

            // Sanitize data to remove undefined values
            Object.keys(taskData).forEach(key => taskData[key] === undefined && delete taskData[key]);

            // Do NOT archive immediately
            await updateDoc(doc(db, 'tasks', taskId), taskData);
        } catch (err) {
            console.error("Error confirming task:", err);
        }
    };

    // Manual archiving removed per request. Archive only via nightly automation.

    const handleApproveTask = async (taskId) => {
        try {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;
            await updateDoc(doc(db, 'tasks', taskId), {
                status: 'pending',
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            // alert("Nepavyko patvirtinti užduoties.");
        }
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
            await revertTask(revertTarget);
            setRevertTarget(null);
        } catch (err) {
            logError(err, { source: 'TaskTable.confirmRevert' });
            if (err.code === 'permission-denied') {
                setError('Tik vadovai gali grąžinti užduotis.');
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
        if (isTaskRunning(task)) return 'bg-green-200 border-green-300';

        const status = task.status || 'pending';
        if (status === 'confirmed') return 'bg-gray-50';
        if (status === 'completed') return 'bg-gray-100';
        if (status === 'unapproved') return 'bg-amber-50';
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

    const isWorker = role === 'worker';
    const canManage = isManagerRole(userRole);

    return (
        <div className="bg-surface-card rounded-card shadow-sm border border-line overflow-hidden">
            {/* Friendly error banner — replaces the banned window.alert with mapped LT copy (§8/§10) */}
            {error && (
                <div className="flex items-start gap-3 border-b border-feedback-danger bg-red-50 p-4" role="alert">
                    <AlertCircle className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-red-700">{error}</p>
                    <button
                        type="button"
                        onClick={() => setError('')}
                        aria-label="Uždaryti pranešimą"
                        className="ml-auto text-body font-medium text-red-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
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
                        <li key={task.id} className={clsx('p-4', getStatusStyle(task))}>
                            {/* Title row + priority */}
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                    <div className={clsx(
                                        'text-body font-semibold break-words',
                                        (task.completed || task.isDeleted) ? 'text-ink-muted line-through' : 'text-ink-strong'
                                    )}>
                                        {task.title}
                                        {task.isDeleted && (
                                            <span className="ml-2 inline-block no-underline px-1.5 py-0.5 text-caption font-bold bg-red-100 text-red-700 rounded border border-red-200 align-middle" style={{ textDecoration: 'none' }}>
                                                Ištrintas
                                            </span>
                                        )}
                                    </div>
                                    {(task.managerName || task.creatorName) && (
                                        <div className="text-caption text-purple-700 font-medium mt-0.5">
                                            Vadovas: {formatDisplayName(task.managerName || task.creatorName)}
                                        </div>
                                    )}
                                </div>
                                <span
                                    className="px-1.5 py-0.5 inline-flex text-caption leading-4 font-semibold rounded-md border border-black/5 shrink-0"
                                    style={{ backgroundColor: getPriorityColor(task.priority), color: getPriorityTextColor(task.priority) }}
                                >
                                    {getPriorityLabel(task.priority)}
                                </span>
                            </div>

                            {/* Description (opens modal) */}
                            {task.description && (
                                <button
                                    onClick={() => setActiveModal({ type: 'description', taskId: task.id })}
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
                                    <span
                                        className="inline-flex items-center justify-center p-[3px] rounded-full"
                                        style={{ backgroundColor: task.assignedWorkerColor || WORKER_FALLBACK_COLOR }}
                                    >
                                        <span className="px-1.5 py-0.5 rounded-full text-caption font-bold bg-surface-card text-ink-strong border border-white/50 max-w-[160px] truncate block">
                                            👤 {formatDisplayName(task.assignedUserName)}
                                        </span>
                                    </span>
                                )}
                                <span className={clsx(
                                    'px-1.5 py-0.5 inline-flex text-caption leading-4 font-semibold rounded-full',
                                    STATUS_COLORS[task.status || 'pending']
                                )}>
                                    {STATUS_LABELS[task.status || 'pending']}
                                </span>
                                {task.tag && (
                                    <span className="px-1.5 py-0.5 inline-flex text-caption leading-4 font-semibold rounded-md bg-purple-100 text-purple-800 border border-purple-200">
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
                                    <span className="text-body-lg text-blue-600 font-bold whitespace-nowrap">
                                        {formatMinutesToTimeString(totalMinutes)}
                                    </span>
                                    {canManage && (
                                        <IconButton
                                            icon={Clock}
                                            label="Koreguoti laiko įrašą"
                                            variant="ghost"
                                            onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'timeAdjustments', taskId: task.id }); }}
                                        />
                                    )}
                                </div>
                            )}
                            {!showTime && canManage && task.status === 'pending' && (
                                <div className="mt-2">
                                    <IconButton
                                        icon={Clock}
                                        label="Pridėti laiko korekciją"
                                        variant="ghost"
                                        onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'timeAdjustments', taskId: task.id }); }}
                                    />
                                </div>
                            )}
                            {task.timeChanged && (
                                <div className="mt-1 text-caption text-red-600 font-bold uppercase tracking-wide">⚠ Pakeistas laikas</div>
                            )}

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
                                            className="inline-flex items-center justify-center min-h-touch min-w-touch rounded-control text-blue-600 hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                        >
                                            <LinkIcon className="w-5 h-5" aria-hidden="true" />
                                        </a>
                                    ))}
                                    {hasImage && (
                                        <IconButton
                                            icon={ImageIcon}
                                            label="Peržiūrėti nuotrauką"
                                            variant="ghost"
                                            className="text-pink-600"
                                            onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'image', taskId: task.id }); }}
                                        />
                                    )}
                                </div>
                            )}

                            {/* Comments preview (last 1) + open-modal control */}
                            {task.comments && task.comments.length > 0 && (
                                <div className="mt-3 pl-2 border-l-2 border-indigo-100">
                                    {(() => {
                                        const last = task.comments[task.comments.length - 1];
                                        return (
                                            <div className="text-caption">
                                                <div className="flex items-center gap-1.5">
                                                    <MessageCircle className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" aria-hidden="true" />
                                                    <span className="font-semibold text-indigo-700">{formatDisplayName(last.user)}</span>
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
                                <label className={clsx(
                                    'mt-3 flex items-center gap-2 min-h-touch',
                                    checkboxDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                                )}>
                                    <input
                                        type="checkbox"
                                        checked={task.completed || false}
                                        onChange={() => {
                                            if (isAssignedToMe) {
                                                handleToggleComplete(task.id, task.completed);
                                            }
                                        }}
                                        disabled={checkboxDisabled}
                                        className="w-5 h-5 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                    />
                                    <span className="text-caption text-ink">Atlikta</span>
                                </label>
                            )}

                            {/* Actions — always-visible 44px targets (no group-hover on touch) */}
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                                {onEdit && (
                                    <Button variant="secondary" size="md" icon={Pencil} onClick={() => onEdit(task)}>
                                        Redaguoti
                                    </Button>
                                )}
                                {canManage && task.status === 'completed' && task.status !== 'confirmed' && (
                                    <Button variant="primary" size="md" icon={CheckCircle2} onClick={() => handleConfirmTask(task.id)}>
                                        Patvirtinti atlikimą
                                    </Button>
                                )}
                                {canManage && task.status === 'unapproved' && (
                                    <Button variant="primary" size="md" onClick={() => handleApproveTask(task.id)}>
                                        Patvirtinti
                                    </Button>
                                )}
                                {task.status === 'confirmed' && (
                                    <StatusPill tone="running" icon={CheckCircle2}>Patvirtinta</StatusPill>
                                )}
                                <IconButton
                                    icon={MessageSquare}
                                    label={`Komentarai${task.comments?.length ? ` (${task.comments.length})` : ''}`}
                                    variant="ghost"
                                    className="text-green-600"
                                    onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'comments', taskId: task.id }); }}
                                />
                                {(task.completed || task.isDeleted) && canManage && (
                                    <Button variant="secondary" size="md" icon={Undo2} onClick={() => setRevertTarget(task)}>
                                        Grąžinti
                                    </Button>
                                )}
                                {(canManage || !isWorker) && (
                                    <Button variant="danger" size="md" icon={Trash2} onClick={() => handleDeleteTask(task.id, task.title)}>
                                        Ištrinti
                                    </Button>
                                )}
                            </div>

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
                            <th className={`px-1 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider ${!isWorker ? 'w-72' : ''}`}>Užduotis</th>
                            <th className="px-1 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-24">Darb.</th>
                            <th className="px-1 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-16">Žyma</th>
                            <th className="px-1 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-16">Atlikti iki</th>
                            <th className="px-1 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-16">Prior.</th>
                            <th className="px-1 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-20">Būsena</th>
                            <th className="px-1 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-14" title="Numatytas laikas">Num.</th>
                            <th className="px-1 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-16">Nuorodos</th>
                            <th className="px-1 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider w-10 text-center">Kom.</th>
                            {canManage && <th className="px-1 py-3 text-center text-caption font-medium text-ink-muted uppercase tracking-wider w-12">Patv.</th>}
                            <th className="px-1 py-3 text-right text-caption font-medium text-ink-muted uppercase tracking-wider w-24">Veik.</th>
                        </tr>
                    </thead>
                    <tbody className="bg-surface-card divide-y divide-line">
                        {tasks.map((task) => {
                            const isAssignedToMe = currentUser?.uid === task.assignedUserId;
                            return (
                                <React.Fragment key={task.id}>
                                    <tr className={clsx(
                                        "transition-colors",
                                        getStatusStyle(task),
                                        !task.completed && "hover:opacity-90"
                                    )}>
                                        {showReorderControls && (
                                            <td className="px-2 py-3 text-center">
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
                                            <td className="px-1 py-3 text-center">
                                                <input
                                                    type="checkbox"
                                                    checked={task.completed || false}
                                                    onChange={() => {
                                                        if (isAssignedToMe) {
                                                            handleToggleComplete(task.id, task.completed);
                                                        }
                                                    }}
                                                    disabled={!isAssignedToMe || task.status === 'confirmed' || task.status === 'unapproved'}
                                                    aria-label="Pažymėti atlikta"
                                                    className={clsx(
                                                        "w-4 h-4 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1",
                                                        isAssignedToMe && task.status !== 'confirmed' && task.status !== 'unapproved' ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                                                    )}
                                                />
                                            </td>
                                        )}
                                        <td className="px-1 py-3">
                                            <div className={clsx(
                                                "text-body font-medium break-words rounded px-2 py-1",
                                                (task.completed || task.isDeleted) ? "text-ink-muted line-through" : "text-ink-strong",
                                                task.status === 'unapproved' ? "bg-surface-sunken text-ink" : ""
                                            )}>
                                                {task.title}
                                                {task.isDeleted && (
                                                    <span className="ml-2 inline-block no-underline px-1.5 py-0.5 text-caption font-bold bg-red-100 text-red-700 rounded border border-red-200 align-middle" style={{ textDecoration: 'none' }}>
                                                        Ištrintas
                                                    </span>
                                                )}
                                            </div>
                                            {(task.managerName || task.creatorName) && (
                                                <div className="text-caption text-purple-700 font-medium mt-0.5">
                                                    Vadovas: {formatDisplayName(task.managerName || task.creatorName)}
                                                </div>
                                            )}
                                            {/* Deadline removed from here, moving to own column */}
                                            {task.description && (
                                                <button
                                                    onClick={() => setActiveModal({ type: 'description', taskId: task.id })}
                                                    aria-label="Peržiūrėti aprašymą"
                                                    className="text-caption text-ink-muted hover:text-brand hover:bg-brand-soft/50 p-1 rounded-md transition-colors line-clamp-3 text-left w-full mt-1 border border-transparent hover:border-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand whitespace-pre-wrap flex items-start gap-1"
                                                >
                                                    <SessionTypeIcon
                                                        type={task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : 'task')}
                                                        className="w-3.5 h-3.5 flex-shrink-0 mt-0.5"
                                                    />
                                                    {task.description}
                                                </button>
                                            )}

                                            {/* Comments List */}
                                            {task.comments && task.comments.length > 0 && (
                                                <div className="mt-2 space-y-1.5 pl-2 border-l-2 border-indigo-100">
                                                    {task.comments.map((comment, index) => {
                                                        const isEditing = editingComment.taskId === task.id && editingComment.index === index;
                                                        const canEdit = canManage || comment.userId === currentUser.uid;

                                                        return (
                                                            <div key={index} className="text-caption bg-indigo-50/30 rounded p-1.5 group hover:bg-indigo-50/60 transition-colors">
                                                                <div className="flex justify-between items-start mb-0.5">
                                                                    <div className="flex items-center gap-1.5 text-caption">
                                                                        <MessageCircle className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" aria-hidden="true" />
                                                                        <span className="font-semibold text-indigo-700">{formatDisplayName(comment.user)}</span>
                                                                        <span className="text-ink-muted">{new Date(comment.createdAt).toLocaleDateString()}</span>
                                                                    </div>
                                                                    {canEdit && !isEditing && (
                                                                        <div className="flex gap-1">
                                                                            <IconButton
                                                                                icon={Pencil}
                                                                                label="Redaguoti komentarą"
                                                                                variant="ghost"
                                                                                onClick={(e) => {
                                                                                    e.stopPropagation();
                                                                                    setEditingComment({ taskId: task.id, index });
                                                                                    setEditCommentText(comment.text);
                                                                                }}
                                                                            />
                                                                            <IconButton
                                                                                icon={Trash2}
                                                                                label="Ištrinti komentarą"
                                                                                variant="danger"
                                                                                onClick={(e) => {
                                                                                    e.stopPropagation();
                                                                                    handleDeleteComment(task.id, index);
                                                                                }}
                                                                            />
                                                                        </div>
                                                                    )}
                                                                </div>

                                                                {isEditing ? (
                                                                    <div onClick={(e) => e.stopPropagation()}>
                                                                        <textarea
                                                                            value={editCommentText}
                                                                            onChange={(e) => setEditCommentText(e.target.value)}
                                                                            className="w-full text-caption p-2 border border-line rounded-input resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                                                            rows={2}
                                                                            autoFocus
                                                                        />
                                                                        <div className="flex justify-end gap-2 mt-1">
                                                                            <Button
                                                                                variant="secondary"
                                                                                onClick={() => setEditingComment({ taskId: null, index: null })}
                                                                            >
                                                                                Atšaukti
                                                                            </Button>
                                                                            <Button
                                                                                variant="primary"
                                                                                onClick={() => handleUpdateComment(task.id, index, editCommentText)}
                                                                            >
                                                                                Išsaugoti
                                                                            </Button>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                    <div className="text-ink leading-snug break-words pl-4">
                                                                        {comment.text}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                            {task.completed && task.completedAt && (
                                                <div className="text-caption text-ink-muted mt-1">
                                                    {new Date(task.completedAt).toLocaleDateString()}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap">
                                            {task.assignedUserName && (
                                                <div
                                                    className="inline-flex items-center justify-center p-[3px] rounded-full"
                                                    style={{ backgroundColor: task.assignedWorkerColor || WORKER_FALLBACK_COLOR }}
                                                >
                                                    <span className="px-1.5 py-0.5 rounded-full text-caption font-bold bg-surface-card text-ink-strong border border-white/50 max-w-[120px] truncate block">
                                                        👤 {formatDisplayName(task.assignedUserName)}
                                                    </span>
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap">
                                            {task.tag && (
                                                <span className="px-1.5 py-0.5 inline-flex text-caption leading-4 font-semibold rounded-md bg-purple-100 text-purple-800 border border-purple-200">
                                                    {task.tag}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap text-caption text-ink">
                                            {formatDeadline(task.deadline)}
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap">
                                            <span
                                                className={clsx(
                                                    "px-1.5 py-0.5 inline-flex text-caption leading-4 font-semibold rounded-md border border-black/5"
                                                )}
                                                style={{
                                                    backgroundColor: getPriorityColor(task.priority),
                                                    color: getPriorityTextColor(task.priority)
                                                }}
                                            >
                                                {getPriorityLabel(task.priority)}
                                            </span>
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap">
                                            <div className="flex flex-col gap-0.5">
                                                <span className={clsx(
                                                    "px-1.5 py-0.5 inline-flex text-caption leading-4 font-semibold rounded-full max-w-[100px] truncate",
                                                    STATUS_COLORS[task.status || 'pending']
                                                )}>
                                                    {STATUS_LABELS[task.status || 'pending']}
                                                </span>
                                                {(() => {
                                                    const totalMinutes = calculateCurrentTotalMinutes(task);
                                                    const hasStarted = task.status && task.status !== 'pending';
                                                    if (totalMinutes > 0 || hasStarted) {
                                                        return (
                                                            <div className="flex items-center gap-1 mt-0.5">
                                                                <span className="text-body text-brand font-bold whitespace-nowrap">
                                                                    {formatMinutesToTimeString(totalMinutes)}
                                                                </span>
                                                                {canManage && (
                                                                    <IconButton
                                                                        icon={Clock}
                                                                        label="Koreguoti laiko įrašą"
                                                                        variant="ghost"
                                                                        onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'timeAdjustments', taskId: task.id }); }}
                                                                    />
                                                                )}
                                                            </div>
                                                        );
                                                    } else if (canManage && task.status === 'pending') {
                                                        return (
                                                            <div className="flex items-center gap-1 mt-0.5">
                                                                <IconButton
                                                                    icon={Clock}
                                                                    label="Pridėti laiko korekciją"
                                                                    variant="ghost"
                                                                    onClick={(e) => { e.stopPropagation(); setActiveModal({ type: 'timeAdjustments', taskId: task.id }); }}
                                                                />
                                                            </div>
                                                        );
                                                    }
                                                    return null;
                                                })()}
                                                {task.timeChanged && (
                                                    <span className="text-red-600 font-bold text-caption uppercase tracking-wide">⚠ Pakeistas laikas</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-1 py-3 whitespace-nowrap text-caption text-ink-muted">
                                            {task.estimatedTime || '-'}
                                        </td>
                                        <td className="px-1 py-3 text-caption">
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
                                                            aria-label={`Nuoroda: ${link.trim()}`}
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            <LinkIcon className="w-4 h-4" aria-hidden="true" />
                                                        </a>
                                                    ));
                                                })()}
                                            </div>
                                            {((task.attachmentUrls && task.attachmentUrls.length > 0) || task.attachmentUrl) && (
                                                <div className="mt-1 flex justify-center">
                                                    <IconButton
                                                        icon={ImageIcon}
                                                        label="Peržiūrėti nuotrauką"
                                                        variant="ghost"
                                                        className="text-pink-600"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setActiveModal({ type: 'image', taskId: task.id });
                                                        }}
                                                    />
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-1 py-3 text-center">
                                            <IconButton
                                                label="Komentarai"
                                                variant="ghost"
                                                className="text-green-600"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setActiveModal({ type: 'comments', taskId: task.id });
                                                }}
                                            >
                                                <MessageSquare className="w-4 h-4" aria-hidden="true" />
                                                {task.comments?.length > 0 && (
                                                    <span className="text-caption font-bold">{task.comments.length}</span>
                                                )}
                                            </IconButton>
                                        </td>
                                        {canManage && (
                                            <td className="px-1 py-3 text-center">
                                                {task.status === 'completed' && task.status !== 'confirmed' && (
                                                    canManage ? (
                                                        <input
                                                            type="checkbox"
                                                            checked={false}
                                                            onChange={() => handleConfirmTask(task.id)}
                                                            className="w-4 h-4 rounded border-line text-green-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-feedback-success focus-visible:ring-offset-1 cursor-pointer"
                                                            title="Patvirtinti atlikimą"
                                                            aria-label="Patvirtinti atlikimą"
                                                        />
                                                    ) : null
                                                )}
                                                {task.status === 'unapproved' && (
                                                    <button
                                                        onClick={() => handleApproveTask(task.id)}
                                                        className="min-h-touch text-caption bg-green-100 text-green-700 px-3 py-1 rounded border border-green-200 hover:bg-green-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-feedback-success focus-visible:ring-offset-1"
                                                        title="Patvirtinti užduotį (leisti vykdyti)"
                                                    >
                                                        Patvirtinti
                                                    </button>
                                                )}
                                                {task.status === 'confirmed' && (
                                                    <span className="inline-flex items-center text-green-600">
                                                        <CheckCircle2 className="w-4 h-4" />
                                                    </span>
                                                )}
                                            </td>
                                        )}
                                        <td className="px-1 py-3 text-right text-caption font-medium valign-top">
                                            <div className="flex flex-col items-end gap-2">
                                                {onEdit && (
                                                    <button
                                                        onClick={() => onEdit(task)}
                                                        className="rounded px-1 py-0.5 font-medium text-brand hover:text-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                                    >
                                                        Redaguoti
                                                    </button>
                                                )}
                                                {(task.completed || task.isDeleted) && canManage && (
                                                    <button
                                                        onClick={() => setRevertTarget(task)}
                                                        className="flex items-center justify-end gap-1 rounded px-1 py-0.5 font-medium text-amber-700 hover:text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                                    >
                                                        <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
                                                        Grąžinti
                                                    </button>
                                                )}
                                                {(canManage || !isWorker) && (
                                                    <button
                                                        onClick={() => handleDeleteTask(task.id, task.title)}
                                                        className="flex items-center justify-end gap-1 rounded px-1 py-0.5 font-medium text-feedback-danger hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                                        Ištrinti
                                                    </button>
                                                )}
                                                {/* Manual Archive button removed */}
                                                <div className="w-full">
                                                    <TaskTimerControls
                                                        task={task}
                                                        role={role}
                                                    />
                                                </div>
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
                            />
                            <ImageModal
                                isOpen={activeModal.type === 'image'}
                                onClose={() => setActiveModal({ type: null, taskId: null })}
                                imageUrls={task.attachmentUrls && task.attachmentUrls.length > 0 ? task.attachmentUrls : (task.attachmentUrl ? [task.attachmentUrl] : [])}
                            />
                            <TimeAdjustmentsModal
                                isOpen={activeModal.type === 'timeAdjustments'}
                                onClose={() => setActiveModal({ type: null, taskId: null })}
                                task={task}
                                onAddAdjustment={handleAddAdjustment}
                                onDeleteAdjustment={handleDeleteAdjustment}
                            />
                        </>
                    );
                })()
            }

            <DeleteConfirmationModal
                isOpen={!!deleteModalTask}
                onClose={() => setDeleteModalTask(null)}
                onConfirm={confirmDeleteTask}
                taskTitle={deleteModalTask?.title || ''}
            />

            {/* Confirm: mark a task complete (reversible → primary) */}
            {completeTarget && (
                <ConfirmDialog
                    open
                    title="Užbaigti užduotį?"
                    message="Patvirtinkite, kad šią užduotį norite žymėti atlikta."
                    confirmLabel="Užbaigti"
                    variant="primary"
                    onConfirm={confirmComplete}
                    onCancel={() => setCompleteTarget(null)}
                />
            )}

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

            {/* Confirm: delete a time adjustment (destructive) */}
            {adjDeleteTarget && (
                <ConfirmDialog
                    open
                    title="Ištrinti korekciją?"
                    message="Šią korekciją negrąžinsite."
                    warning="Šio veiksmo atšaukti negalėsite."
                    confirmLabel="Ištrinti"
                    variant="danger"
                    onConfirm={confirmDeleteAdjustment}
                    onCancel={() => setAdjDeleteTarget(null)}
                />
            )}
        </div >
    );
};

export default React.memo(TaskTable, (prevProps, nextProps) => {
    if (prevProps.role !== nextProps.role) return false;
    if (prevProps.showReorderControls !== nextProps.showReorderControls) return false;
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
