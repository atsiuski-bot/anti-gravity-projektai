import { useState, useEffect, useRef, useId, useMemo } from 'react';
import clsx from 'clsx';
import {
    Pencil, Trash2, Undo2, CheckCircle2, Check, Clock, MessageSquare, ListChecks,
    Link as LinkIcon, ImageIcon, ImagePlus, Camera, Send, X, ChevronDown,
    Calendar, Timer, Hourglass, UserCog,
} from 'lucide-react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useAuth } from '../../context/AuthContext';
import { useUsers } from '../../context/UsersContext';
import { ImageModal } from '../TaskDetailsModals';
import BackdateTimeModal from '../BackdateTimeModal';
import Modal from '../ui/Modal';
import Linkify from '../ui/Linkify';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import TaskActionRow from './TaskActionRow';
import PriorityBadge from './PriorityBadge';
import TaskStatusPill from './TaskStatusPill';
import TaskFlagToggles from './TaskFlagToggles';
import DeletedBadge from './DeletedBadge';
import AssigneeChip from './AssigneeChip';
import TimeChangedWarning from './TimeChangedWarning';
import SessionTypeIcon from '../SessionTypeIcon';
import UserChip from '../UserChip';
import { deriveTaskStatus } from '../../utils/taskStatus';
import { formatMinutesToTimeString, calculateCurrentTotalMinutes, relativeDeadline } from '../../utils/timeUtils';
import { getChecklistProgress } from '../../utils/checklistActions';
import { addComment, updateComment, deleteComment, getCommentKey } from '../../utils/commentActions';
import { uploadAttachments, MAX_ATTACHMENTS } from '../../utils/attachmentUpload';
import { notifyMany } from '../../utils/notify';
import { logError } from '../../utils/errorLog';
import { preventEnterSubmit } from '../../utils/formUtils';

/**
 * TaskDetailModal — the single "open the task" surface for both the desktop list (row click) and
 * the mobile cards (tap). It shows the full task read-only, but is NOT a dead end: the viewer can
 * add a comment or a photo straight from here. Editing the task itself is a separate step — the
 * footer "Redaguoti" hands off to the create/edit form.
 *
 * Layout: a fixed header + a scrolling body + a sticky footer (the management actions). When the
 * body overflows, a soft fade toward the footer signals there is more to scroll, so a comment or
 * photo below the fold is never missed. With little content the sheet stays compact; with comments
 * and photos it grows to (capped) full screen height on a phone.
 *
 * Empty optional fields (no deadline / no estimate) are hidden rather than shown as "—"; when the
 * assignee and the manager are the same person only one chip is shown, with no role caption.
 *
 * @param {Object}   props
 * @param {boolean}  props.isOpen
 * @param {Function} props.onClose
 * @param {Object}   props.task
 * @param {boolean}  [props.isRunning]       live timer truth (drives the status pill)
 * @param {boolean}  [props.canManage]       manager/admin: gates confirm/approve/revert + time edit
 * @param {boolean}  [props.canDelete]       gates the delete action
 * @param {boolean}  [props.showManagerLine] show the "Vadovas" chip (off in single-manager lists)
 * @param {Function} [props.onEdit]          present ⇒ render the Edit action (viewer has edit access)
 * @param {Function} [props.onDelete]
 * @param {Function} [props.onRevert]
 * @param {Function} [props.onConfirm]       confirm finished work (taskId)
 * @param {Function} [props.onApprove]       approve an unapproved task (taskId)
 * @param {Function} [props.onOpenChecklist]
 * @param {Function} [props.onOpenTimeAdjustments]
 */
// Deadline rendering is delegated to the shared relativeDeadline() helper so this modal and the
// TaskCard always speak with one voice ("Šiandien" / "Rytoj" / "Vėluoja N d." / "MM.DD d.").
// Returns the helper's { label, tone } (or null) directly; the JSX maps the tone to a colour.
const DEADLINE_TONE = {
    neutral: 'text-ink',
    warning: 'text-feedback-warning-text font-semibold',
    danger: 'text-feedback-danger-text font-semibold',
};

function formatDeadline(dateStr) {
    return relativeDeadline(dateStr);
}

export default function TaskDetailModal({
    isOpen,
    onClose,
    task,
    isRunning = false,
    canManage = false,
    canDelete = false,
    showManagerLine = true,
    allowPhotoAdd = true,
    onEdit,
    onDelete,
    onRevert,
    onConfirm,
    onApprove,
    onOpenChecklist,
    onOpenTimeAdjustments,
}) {
    const titleId = useId();
    const { currentUser, userData } = useAuth();
    const { users } = useUsers();

    // Recipients for the approval-free backdate FYI: every ACTIVE admin (legacy spelling included),
    // computed from the roster the worker can already read.
    const adminUids = useMemo(
        () => (users || [])
            .filter((u) => (u.role === 'admin' || u.role === 'Administratorius') && !u.isDisabled)
            .map((u) => u.id),
        [users]
    );

    const [backdateOpen, setBackdateOpen] = useState(false);
    const [newComment, setNewComment] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [lightboxIndex, setLightboxIndex] = useState(null); // null = closed; number = open at that photo
    const [error, setError] = useState('');

    // Inline comment editing — the author (or a manager) edits / deletes in place, so comment
    // management stays on this one surface instead of bouncing out to a separate modal. Comments
    // are keyed by their stable `createdAt`, not a positional index, so an edit/delete can't hit
    // the wrong comment if the list shifts under it.
    const [editingKey, setEditingKey] = useState(null);
    const [editText, setEditText] = useState('');
    const [deletingKey, setDeletingKey] = useState(null);

    // Fade-to-footer scroll hint: only render the fade while there is still content below the
    // fold, so it never lies that there is "more" once the reader has reached the bottom.
    const bodyRef = useRef(null);
    const [showFade, setShowFade] = useState(false);

    const imageUrls = useMemo(() => {
        if (!task) return [];
        if (task.attachmentUrls?.length) return task.attachmentUrls;
        return task.attachmentUrl ? [task.attachmentUrl] : [];
    }, [task]);

    useEffect(() => {
        const el = bodyRef.current;
        if (!isOpen || !el) return undefined;
        const check = () => setShowFade(el.scrollHeight - el.clientHeight - el.scrollTop > 8);
        check();
        el.addEventListener('scroll', check, { passive: true });
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
        ro?.observe(el);
        return () => {
            el.removeEventListener('scroll', check);
            ro?.disconnect();
        };
    }, [isOpen, task]);

    if (!isOpen || !task) return null;

    const isDeleted = task.isDeleted || task.status === 'deleted';
    const deadline = formatDeadline(task.deadline);
    // Session-type glyph for a call / quick-work task (null for a plain task — no icon shown).
    const typeIcon = task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : null);
    // The status shape repeated next to the title in the header, so the state reads at a glance.
    const { Icon: StatusGlyph } = deriveTaskStatus(task, { isRunning });
    const totalMinutes = calculateCurrentTotalMinutes(task);
    const hasStarted = task.status && task.status !== 'pending';
    const showSpent = totalMinutes > 0 || hasStarted;

    const links = (task.links || []).flatMap((l) => l.split('\n')).filter((l) => l.trim().length > 0);
    const commentCount = task.comments?.length || 0;
    const checklist = task.checklist && task.checklist.length > 0 ? getChecklistProgress(task.checklist) : null;
    const managerName = task.managerName || task.creatorName;
    const managerId = task.managerId || task.creatorId;
    const samePerson = !!task.assignedUserId && managerId === task.assignedUserId;

    const isAssignee = currentUser?.uid === task.assignedUserId;
    // A trusted worker (canBackdateTime) may self-log a missed session on their OWN active task,
    // without approval. Off on a deleted task (no time edits on a removed task).
    const canBackdate = userData?.canBackdateTime === true && isAssignee && !isDeleted;
    // Photo-add is an ACTIVE-task affordance. Off the active surface (archive / report) the task is
    // historical, so the preview is read-only for photos — `allowPhotoAdd` gates it (the gallery
    // still shows existing photos; only the add controls are withheld).
    const canAddPhoto = (canManage || isAssignee) && allowPhotoAdd;
    const collectionName = task.isArchived ? 'archived_tasks' : 'tasks';

    const canConfirm = canManage && task.status === 'completed';
    const canApprove = canManage && task.status === 'unapproved';
    const canRevert = canManage && (task.completed || isDeleted);
    const hasFooterActions = !!onEdit || canConfirm || canApprove || canRevert || canDelete;

    // Footer actions, data-driven so the SAME adaptive one-line row the card uses backs the modal
    // too (revert → approve/confirm → edit → delete, destructive last per §8). They share the row
    // width and collapse to icon-only together when the labels no longer fit — never wrapping.
    const footerActions = [];
    if (canRevert && onRevert) footerActions.push({ key: 'revert', label: 'Grąžinti', icon: Undo2, variant: 'secondary', onClick: () => onRevert(task) });
    if (canApprove && onApprove) footerActions.push({ key: 'approve', label: 'Patvirtinti', icon: CheckCircle2, variant: 'success', onClick: () => onApprove(task.id) });
    if (canConfirm && onConfirm) footerActions.push({ key: 'confirm', label: 'Priimti', icon: CheckCircle2, variant: 'success', onClick: () => onConfirm(task.id) });
    if (onEdit) footerActions.push({ key: 'edit', label: 'Redaguoti', icon: Pencil, variant: 'primary', onClick: () => onEdit(task) });
    if (canDelete && onDelete) footerActions.push({ key: 'delete', label: 'Ištrinti', icon: Trash2, variant: 'danger', onClick: () => onDelete(task) });

    const onSubmitComment = async (e) => {
        e.preventDefault();
        const text = newComment.trim();
        if (!text || submitting) return;
        setSubmitting(true);
        setError('');
        try {
            await addComment(task.id, text, currentUser, task.comments, collectionName);
            setNewComment('');
        } catch (err) {
            logError(err, { source: 'TaskDetailModal.addComment' });
            setError('Nepavyko pridėti komentaro. Bandykite vėliau.');
        } finally {
            setSubmitting(false);
        }
    };

    const onPickPhotos = async (e) => {
        const picked = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
        e.target.value = '';
        if (!picked.length) return;
        if (imageUrls.length + picked.length > MAX_ATTACHMENTS) {
            setError(`Daugiausia ${MAX_ATTACHMENTS} nuotraukos.`);
            return;
        }
        setError('');
        setUploading(true);
        try {
            const urls = await uploadAttachments(picked, currentUser.uid);
            await updateDoc(doc(db, collectionName, task.id), {
                attachmentUrls: [...imageUrls, ...urls],
                updatedAt: new Date().toISOString(),
            });
            // Tell the OTHER party a photo landed (manager ↔ worker), exactly like a new comment —
            // notifyMany de-dupes and drops the uploader, so it never echoes back to its author.
            await notifyMany([task.managerId, task.assignedUserId], {
                type: 'new_photo',
                taskId: task.id,
                taskTitle: task.title || 'Užduotis',
                actorUid: currentUser.uid,
                actorName: currentUser.displayName || currentUser.email,
            });
        } catch (err) {
            logError(err, { source: 'TaskDetailModal.onPickPhotos' });
            setError('Nepavyko įkelti nuotraukos. Bandykite vėliau.');
        } finally {
            setUploading(false);
        }
    };

    const startEdit = (key, text) => { setEditingKey(key); setEditText(text); setDeletingKey(null); };
    const cancelEdit = () => { setEditingKey(null); setEditText(''); };
    const saveEdit = async (key) => {
        const text = editText.trim();
        if (!text) return;
        try {
            await updateComment(task.id, key, text, task.comments, collectionName);
            cancelEdit();
        } catch (err) {
            logError(err, { source: 'TaskDetailModal.updateComment' });
            setError('Nepavyko atnaujinti komentaro.');
        }
    };
    const confirmDeleteComment = async (key) => {
        try {
            await deleteComment(task.id, key, task.comments, collectionName);
        } catch (err) {
            logError(err, { source: 'TaskDetailModal.deleteComment' });
            setError('Nepavyko ištrinti komentaro.');
        } finally {
            setDeletingKey(null);
        }
    };

    return (
        <Modal open={isOpen} onClose={onClose} ariaLabelledby={titleId} size="xl" bare>
            {/* Header — fixed */}
            <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
                <div className="flex min-w-0 items-start gap-2">
                    {StatusGlyph && <StatusGlyph className="mt-0.5 h-5 w-5 flex-shrink-0 text-ink-muted" aria-hidden="true" />}
                    <h2 id={titleId} className="text-h3 font-bold leading-snug text-ink-strong">{task.title}</h2>
                </div>
                <IconButton icon={X} label="Uždaryti" onClick={onClose} className="-mr-2 -mt-1" />
            </div>

            {/* Body — scrolls; fade signals more content toward the sticky footer */}
            <div className="relative min-h-0 flex-1">
                <div ref={bodyRef} className="h-full space-y-4 overflow-y-auto px-5 py-4">
                    {/* Row 1 — type glyph (call / quick work), status, priority, deadline */}
                    <div className="flex flex-wrap items-center gap-2">
                        {typeIcon && <SessionTypeIcon type={typeIcon} className="h-5 w-5" />}
                        <TaskStatusPill task={task} isRunning={isRunning} doneIcon />
                        <PriorityBadge priority={task.priority} size="md" pill />
                        {isDeleted && <DeletedBadge />}
                        {task.tag && (
                            <span className="inline-flex items-center rounded-full border border-feedback-info-border bg-feedback-info-soft px-2 py-0.5 text-caption font-semibold text-feedback-info-text">
                                {task.tag}
                            </span>
                        )}
                        {deadline && (
                            <span className="inline-flex items-center gap-1.5 text-body text-ink">
                                <Calendar className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                                {/* "Atlikti iki" only fronts an absolute future date; the relative
                                    labels ("Šiandien" / "Rytoj" / "Vėluoja N d.") read as full
                                    phrases on their own. */}
                                {deadline.tone === 'neutral' && deadline.label !== 'Rytoj' && 'Atlikti iki '}
                                <span className={clsx('font-medium', DEADLINE_TONE[deadline.tone] || DEADLINE_TONE.neutral)}>{deadline.label}</span>
                            </span>
                        )}
                    </div>

                    <TimeChangedWarning task={task} />

                    {/* Row 2 — planned vs spent time; time-adjust shown only to managers who can edit.
                        Also renders for a trusted worker (canBackdate) even with no time yet, so the
                        "Įrašyti praėjusį laiką" affordance is reachable on a fresh task. */}
                    {(task.estimatedTime || showSpent || canBackdate) && (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-line py-2.5 text-body text-ink">
                            {task.estimatedTime && (
                                <span className="inline-flex items-center gap-1.5">
                                    <Hourglass className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                                    Numatyta <span className="font-medium">{task.estimatedTime}</span>
                                </span>
                            )}
                            {showSpent && (
                                <span className="inline-flex items-center gap-1.5">
                                    <Timer className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                                    Sugaišta <span className="font-bold text-brand">{formatMinutesToTimeString(totalMinutes)}</span>
                                </span>
                            )}
                            {showSpent && canManage && onOpenTimeAdjustments && (
                                <button
                                    type="button"
                                    onClick={() => onOpenTimeAdjustments(task)}
                                    className="inline-flex items-center gap-1 rounded-control border border-line px-2 py-1 text-caption font-medium text-ink-muted hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                >
                                    <Clock className="h-3.5 w-3.5" aria-hidden="true" /> Koreguoti laiką
                                </button>
                            )}
                            {canBackdate && (
                                <button
                                    type="button"
                                    onClick={() => setBackdateOpen(true)}
                                    className="inline-flex items-center gap-1 rounded-control border border-line px-2 py-1 text-caption font-medium text-ink-muted hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                >
                                    <Clock className="h-3.5 w-3.5" aria-hidden="true" /> Įrašyti praėjusį laiką
                                </button>
                            )}
                        </div>
                    )}

                    {/* Row 3 — who does the work and who manages it (one chip when they're the same) */}
                    {(task.assignedUserName || (showManagerLine && managerName)) && (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            {task.assignedUserName && (
                                <span className="inline-flex items-center gap-1.5">
                                    <UserCog className="h-4 w-4 flex-shrink-0 text-ink-muted" aria-hidden="true" />
                                    <AssigneeChip userId={task.assignedUserId} name={task.assignedUserName} color={task.assignedWorkerColor} ring />
                                </span>
                            )}
                            {showManagerLine && managerName && !samePerson && (
                                <span className="inline-flex items-center gap-1.5 text-caption text-ink-muted">
                                    Vad.
                                    <UserChip userId={managerId} name={managerName} />
                                </span>
                            )}
                        </div>
                    )}

                    {/* Worker attention flags — the vykdytojas (or a manager) raises/clears
                        "Reikia vadovo" / "Laukiama" here. Raising one tints the card everywhere and
                        pings the task's manager with who raised it. */}
                    {(isAssignee || canManage) && !isDeleted && (
                        <div>
                            <div className="mb-2 text-caption font-medium uppercase tracking-wide text-ink-muted">
                                Vykdytojo žymos
                            </div>
                            <TaskFlagToggles
                                task={task}
                                currentUser={currentUser}
                                defaultManagerId={userData?.defaultManager || null}
                                collectionName={collectionName}
                                onError={() => setError('Nepavyko pakeisti žymos. Bandykite dar kartą.')}
                            />
                        </div>
                    )}

                    {/* Row 4 — description */}
                    {task.description && (
                        <div className="flex items-start gap-2 rounded-card bg-surface-sunken p-3">
                            <SessionTypeIcon
                                type={task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : 'task')}
                                className="mt-0.5 h-4 w-4 flex-shrink-0"
                            />
                            <p className="whitespace-pre-wrap text-body leading-relaxed text-ink">
                                <Linkify text={task.description} />
                            </p>
                        </div>
                    )}

                    {/* Row 5 — checklist launcher (the rich editor stays its own modal) */}
                    {checklist && onOpenChecklist && (
                        <div>
                            <Button variant="secondary" size="md" icon={ListChecks} onClick={() => onOpenChecklist(task)}>
                                Sąrašas {checklist.done}/{checklist.total}
                            </Button>
                        </div>
                    )}

                    {/* Links */}
                    {links.length > 0 && (
                        <div>
                            <div className="mb-1 flex items-center gap-1.5 text-caption font-medium uppercase tracking-wide text-ink-muted">
                                <LinkIcon className="h-4 w-4" aria-hidden="true" /> Nuorodos
                            </div>
                            <div className="space-y-1.5">
                                {links.map((link, idx) => (
                                    <a
                                        key={idx}
                                        href={link.trim().startsWith('http') ? link.trim() : `https://${link.trim()}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-2 break-all rounded-lg bg-brand-soft px-3 py-2 text-body text-brand transition-colors hover:text-brand-hover"
                                    >
                                        <LinkIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                                        {link.trim()}
                                    </a>
                                ))}
                            </div>
                        </div>
                    )}

                    {error && (
                        <p role="alert" className="rounded-control border border-feedback-danger-border bg-feedback-danger-soft px-3 py-2 text-caption font-medium text-feedback-danger-text">
                            {error}
                        </p>
                    )}

                    {/* Row 6 — comments; loaded inline, add straight from the preview */}
                    <div>
                        <div className="mb-2 flex items-center gap-1.5 text-caption font-medium uppercase tracking-wide text-ink-muted">
                            <MessageSquare className="h-4 w-4" aria-hidden="true" /> Komentarai{commentCount ? ` · ${commentCount}` : ''}
                        </div>
                        {commentCount > 0 ? (
                            <div className="space-y-2">
                                {task.comments.map((c, idx) => {
                                    const ckey = getCommentKey(c);
                                    const isEditing = editingKey === ckey;
                                    const isDeleting = deletingKey === ckey;
                                    const mayEdit = canManage || (c.userId && c.userId === currentUser?.uid);
                                    return (
                                        <div key={ckey ?? idx} className="rounded-card border border-line bg-surface-card p-3">
                                            <div className="mb-1 flex items-start justify-between gap-2">
                                                <div className="flex items-center gap-2">
                                                    <UserChip userId={c.userId} name={c.user} />
                                                    <span className="text-caption text-ink-muted">{new Date(c.createdAt).toLocaleDateString('lt-LT')}</span>
                                                </div>
                                                {mayEdit && !isEditing && !isDeleting && (
                                                    <div className="flex flex-shrink-0 items-center gap-1">
                                                        <IconButton icon={Pencil} label="Redaguoti komentarą" variant="ghost" onClick={() => startEdit(ckey, c.text)} />
                                                        <IconButton icon={Trash2} label="Ištrinti komentarą" variant="danger" onClick={() => { cancelEdit(); setDeletingKey(ckey); }} />
                                                    </div>
                                                )}
                                            </div>
                                            {isEditing ? (
                                                <div>
                                                    <textarea
                                                        value={editText}
                                                        onChange={(e) => setEditText(e.target.value)}
                                                        rows={2}
                                                        aria-label="Redaguoti komentarą"
                                                        className="w-full resize-y rounded-input border border-line px-3 py-2 text-body focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                                        autoFocus
                                                    />
                                                    <div className="mt-1 flex justify-end gap-1">
                                                        <IconButton icon={X} label="Atšaukti" variant="ghost" onClick={cancelEdit} />
                                                        <IconButton icon={Check} label="Išsaugoti" variant="primary" onClick={() => saveEdit(ckey)} disabled={!editText.trim()} />
                                                    </div>
                                                </div>
                                            ) : (
                                                <p className="whitespace-pre-wrap break-words text-body leading-snug text-ink"><Linkify text={c.text} /></p>
                                            )}
                                            {isDeleting && (
                                                <div className="mt-2 flex items-center justify-end gap-2 text-caption">
                                                    <span className="mr-auto text-ink-muted">Ištrinti komentarą?</span>
                                                    <Button variant="ghost" size="md" onClick={() => setDeletingKey(null)}>Atšaukti</Button>
                                                    <Button variant="danger" size="md" icon={Trash2} onClick={() => confirmDeleteComment(ckey)}>Ištrinti</Button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <p className="text-caption text-ink-muted">Komentarų dar nėra.</p>
                        )}
                        <form onSubmit={onSubmitComment} onKeyDown={preventEnterSubmit} className="mt-2 flex items-end gap-2">
                            <textarea
                                value={newComment}
                                onChange={(e) => setNewComment(e.target.value)}
                                placeholder="Rašyti komentarą…"
                                aria-label="Rašyti komentarą"
                                rows={2}
                                className="min-h-touch flex-1 resize-y rounded-input border border-line px-3 py-2 text-body focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                                disabled={submitting}
                            />
                            <Button type="submit" variant="primary" size="md" icon={Send} loading={submitting} disabled={!newComment.trim() || submitting}>
                                Skelbti
                            </Button>
                        </form>
                    </div>

                    {/* Row 7 — photos; thumbnails open the lightbox, viewers with access can add more
                        (camera capture sits to the LEFT of the gallery picker). */}
                    {(imageUrls.length > 0 || canAddPhoto) && (
                        <div>
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5 text-caption font-medium uppercase tracking-wide text-ink-muted">
                                    <ImageIcon className="h-4 w-4" aria-hidden="true" /> Nuotraukos{imageUrls.length ? ` · ${imageUrls.length}` : ''}
                                </div>
                                {canAddPhoto && (
                                    <div className="flex items-center gap-2">
                                        <label className="inline-flex min-h-touch cursor-pointer items-center gap-1.5 rounded-control border border-line px-2.5 py-1.5 text-caption font-medium text-ink hover:bg-surface-sunken focus-within:outline-none focus-within:ring-2 focus-within:ring-brand">
                                            <Camera className="h-4 w-4" aria-hidden="true" />
                                            Fotografuoti
                                            <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={onPickPhotos} disabled={uploading} />
                                        </label>
                                        <label className="inline-flex min-h-touch cursor-pointer items-center gap-1.5 rounded-control border border-line px-2.5 py-1.5 text-caption font-medium text-ink hover:bg-surface-sunken focus-within:outline-none focus-within:ring-2 focus-within:ring-brand">
                                            <ImagePlus className="h-4 w-4" aria-hidden="true" />
                                            {uploading ? 'Įkeliama…' : 'Pridėti'}
                                            <input type="file" accept="image/*" multiple className="sr-only" onChange={onPickPhotos} disabled={uploading} />
                                        </label>
                                    </div>
                                )}
                            </div>
                            {imageUrls.length > 0 ? (
                                <div className="flex flex-wrap gap-2">
                                    {imageUrls.map((url, idx) => (
                                        <button
                                            key={idx}
                                            type="button"
                                            onClick={() => setLightboxIndex(idx)}
                                            className="h-16 w-16 overflow-hidden rounded-control border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                                            aria-label={`Peržiūrėti nuotrauką ${idx + 1}`}
                                        >
                                            <img src={url} alt={`Nuotrauka ${idx + 1}`} className="h-full w-full object-cover" />
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-caption text-ink-muted">Nuotraukų dar nėra.</p>
                            )}
                        </div>
                    )}
                </div>

                {showFade && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-gradient-to-t from-surface-card to-transparent">
                        <ChevronDown className="mb-1 h-4 w-4 text-ink-muted motion-safe:animate-bounce" aria-hidden="true" />
                    </div>
                )}
            </div>

            {/* Footer — sticky management actions on one adaptive row (TaskActionRow): the primary
                (Redaguoti) outweighs the destructive (Ištrinti, last per DESIGN_SYSTEM §8); the row
                stays on a single line and collapses to icon-only together when too tight. */}
            {hasFooterActions && (
                <div className="flex-shrink-0 border-t border-line bg-surface-sunken px-5 py-4">
                    <TaskActionRow actions={footerActions} />
                </div>
            )}

            {lightboxIndex !== null && (
                <ImageModal isOpen onClose={() => setLightboxIndex(null)} imageUrls={imageUrls} initialIndex={lightboxIndex} />
            )}

            {canBackdate && (
                <BackdateTimeModal
                    open={backdateOpen}
                    onClose={() => setBackdateOpen(false)}
                    task={task}
                    worker={{ uid: currentUser?.uid, displayName: currentUser?.displayName, email: currentUser?.email }}
                    adminUids={adminUids}
                    onSaved={() => setBackdateOpen(false)}
                />
            )}
        </Modal>
    );
}
