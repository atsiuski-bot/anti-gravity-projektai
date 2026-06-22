import {
    Pencil, Trash2, Undo2, CheckCircle2, Clock, MessageSquare, ListChecks,
    Link as LinkIcon, ImageIcon, Calendar, Timer, Hourglass, UserCog,
} from 'lucide-react';
import { DetailsModal } from '../TaskDetailsModals';
import Button from '../ui/Button';
import PriorityBadge from './PriorityBadge';
import TaskStatusPill from './TaskStatusPill';
import DeletedBadge from './DeletedBadge';
import AssigneeChip from './AssigneeChip';
import TimeChangedWarning from './TimeChangedWarning';
import SessionTypeIcon from '../SessionTypeIcon';
import { formatDisplayName } from '../../utils/formatters';
import { formatMinutesToTimeString, calculateCurrentTotalMinutes } from '../../utils/timeUtils';
import { getChecklistProgress } from '../../utils/checklistActions';

/**
 * TaskDetailModal — the single "open the task" surface for the desktop list. Clicking a row
 * opens this; it always shows the full task read-only, so a viewer WITHOUT edit access still
 * sees everything, and a viewer WITH edit access gets the management actions in the footer.
 *
 * It deliberately does NOT re-implement the comment / checklist / image / time-adjustment
 * editors — those rich modals already exist. Their launchers here hand off to the parent
 * (which closes this sheet first, so two dialogs never stack). This keeps one task surface
 * while reusing the canonical detail modals.
 *
 * @param {Object}   props
 * @param {boolean}  props.isOpen
 * @param {Function} props.onClose
 * @param {Object}   props.task
 * @param {boolean}  [props.isRunning]      live timer truth (drives the status pill)
 * @param {boolean}  [props.canManage]      manager/admin: gates confirm/approve/revert
 * @param {boolean}  [props.canDelete]      gates the delete action
 * @param {boolean}  [props.showManagerLine] show the "Vadovas" meta row (off in single-manager lists)
 * @param {Function} [props.onEdit]         present ⇒ render the Edit action (i.e. the viewer has edit access)
 * @param {Function} [props.onDelete]
 * @param {Function} [props.onRevert]
 * @param {Function} [props.onConfirm]      confirm finished work (taskId)
 * @param {Function} [props.onApprove]      approve an unapproved task (taskId)
 * @param {Function} [props.onOpenComments]
 * @param {Function} [props.onOpenChecklist]
 * @param {Function} [props.onOpenImage]
 * @param {Function} [props.onOpenTimeAdjustments]
 */
function formatDeadline(dateStr) {
    if (!dateStr) return null;
    try {
        const date = new Date(dateStr);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${month}.${day} d.`;
    } catch {
        return dateStr;
    }
}

function MetaRow({ icon: Icon, label, children }) {
    if (children === null || children === undefined || children === false) return null;
    return (
        <div className="flex items-start gap-2 py-1.5">
            <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-ink-muted" aria-hidden="true" />
            <div className="min-w-0">
                <div className="text-caption font-medium uppercase tracking-wide text-ink-muted">{label}</div>
                <div className="text-body text-ink">{children}</div>
            </div>
        </div>
    );
}

export default function TaskDetailModal({
    isOpen,
    onClose,
    task,
    isRunning = false,
    canManage = false,
    canDelete = false,
    showManagerLine = true,
    onEdit,
    onDelete,
    onRevert,
    onConfirm,
    onApprove,
    onOpenComments,
    onOpenChecklist,
    onOpenImage,
    onOpenTimeAdjustments,
}) {
    if (!isOpen || !task) return null;

    const isDeleted = task.isDeleted || task.status === 'deleted';
    const deadline = formatDeadline(task.deadline);
    const totalMinutes = calculateCurrentTotalMinutes(task);
    const hasStarted = task.status && task.status !== 'pending';
    const showSpent = totalMinutes > 0 || hasStarted;

    const links = (task.links || []).flatMap((l) => l.split('\n')).filter((l) => l.trim().length > 0);
    const hasImage = (task.attachmentUrls && task.attachmentUrls.length > 0) || task.attachmentUrl;
    const commentCount = task.comments?.length || 0;
    const checklist = task.checklist && task.checklist.length > 0 ? getChecklistProgress(task.checklist) : null;
    const managerName = task.managerName || task.creatorName;

    const canConfirm = canManage && task.status === 'completed';
    const canApprove = canManage && task.status === 'unapproved';
    const canRevert = canManage && (task.completed || isDeleted);
    const hasFooterActions = !!onEdit || canConfirm || canApprove || canRevert || canDelete;

    return (
        <DetailsModal isOpen={isOpen} onClose={onClose} title={task.title}>
            <div className="space-y-5">
                {/* Status / priority / deleted / tag — the calm badges, never a duplicated column */}
                <div className="flex flex-wrap items-center gap-2">
                    <TaskStatusPill task={task} isRunning={isRunning} doneIcon />
                    <PriorityBadge priority={task.priority} size="md" pill />
                    {isDeleted && <DeletedBadge />}
                    {task.tag && (
                        <span className="inline-flex items-center rounded-full border border-purple-200 bg-purple-100 px-2 py-0.5 text-caption font-semibold text-purple-800">
                            {task.tag}
                        </span>
                    )}
                </div>

                <TimeChangedWarning task={task} />

                {/* Description */}
                {task.description && (
                    <div className="flex items-start gap-2 rounded-card bg-surface-sunken p-3">
                        <SessionTypeIcon
                            type={task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : 'task')}
                            className="mt-0.5 h-4 w-4 flex-shrink-0"
                        />
                        <p className="whitespace-pre-wrap text-body leading-relaxed text-ink">{task.description}</p>
                    </div>
                )}

                {/* Meta grid */}
                <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                    <MetaRow icon={UserCog} label="Vykdytojas">
                        {task.assignedUserName
                            ? <AssigneeChip userId={task.assignedUserId} name={task.assignedUserName} color={task.assignedWorkerColor} ring />
                            : <span className="text-ink-muted">—</span>}
                    </MetaRow>
                    {showManagerLine && managerName && (
                        <MetaRow icon={UserCog} label="Vadovas">
                            <span className="font-medium text-purple-700">{formatDisplayName(managerName)}</span>
                        </MetaRow>
                    )}
                    <MetaRow icon={Calendar} label="Atlikti iki">
                        {deadline || <span className="text-ink-muted">—</span>}
                    </MetaRow>
                    <MetaRow icon={Hourglass} label="Numatyta">
                        {task.estimatedTime || <span className="text-ink-muted">—</span>}
                    </MetaRow>
                    {showSpent && (
                        <MetaRow icon={Timer} label="Sugaišta">
                            <span className="font-bold text-brand">{formatMinutesToTimeString(totalMinutes)}</span>
                        </MetaRow>
                    )}
                </div>

                {/* Inline links — clickable, no extra column */}
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

                {/* Section launchers — hand off to the existing rich modals */}
                <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                    {onOpenComments && (
                        <Button variant="secondary" size="md" icon={MessageSquare} onClick={() => onOpenComments(task)}>
                            Komentarai{commentCount > 0 ? ` (${commentCount})` : ''}
                        </Button>
                    )}
                    {checklist && onOpenChecklist && (
                        <Button variant="secondary" size="md" icon={ListChecks} onClick={() => onOpenChecklist(task)}>
                            Sąrašas {checklist.done}/{checklist.total}
                        </Button>
                    )}
                    {hasImage && onOpenImage && (
                        <Button variant="secondary" size="md" icon={ImageIcon} onClick={() => onOpenImage(task)}>
                            Nuotraukos
                        </Button>
                    )}
                    {canManage && onOpenTimeAdjustments && (
                        <Button variant="secondary" size="md" icon={Clock} onClick={() => onOpenTimeAdjustments(task)}>
                            Koreguoti laiką
                        </Button>
                    )}
                </div>

                {/* Footer — permission-gated management actions. The primary (Edit) outweighs the
                    destructive (Delete) per DESIGN_SYSTEM §8. */}
                {hasFooterActions && (
                    <div className="sticky bottom-0 -mx-6 -mb-6 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-card px-6 py-3">
                        {canRevert && onRevert && (
                            <Button variant="secondary" size="md" icon={Undo2} onClick={() => onRevert(task)}>
                                Grąžinti
                            </Button>
                        )}
                        {canDelete && onDelete && (
                            <Button variant="danger" size="md" icon={Trash2} onClick={() => onDelete(task)}>
                                Ištrinti
                            </Button>
                        )}
                        {canApprove && onApprove && (
                            <Button variant="success" size="md" icon={CheckCircle2} onClick={() => onApprove(task.id)}>
                                Patvirtinti
                            </Button>
                        )}
                        {canConfirm && onConfirm && (
                            <Button variant="success" size="md" icon={CheckCircle2} onClick={() => onConfirm(task.id)}>
                                Patvirtinti atlikimą
                            </Button>
                        )}
                        {onEdit && (
                            <Button variant="primary" size="md" icon={Pencil} onClick={() => onEdit(task)}>
                                Redaguoti
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </DetailsModal>
    );
}
