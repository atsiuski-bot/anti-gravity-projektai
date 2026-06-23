import { MessageSquare } from 'lucide-react';
import IconButton from '../ui/IconButton';
import AssigneeChip from './AssigneeChip';
import PriorityBadge from './PriorityBadge';
import DeletedBadge from './DeletedBadge';
import TaskStatusPill from './TaskStatusPill';
import TaskAnomalyBadge from './TaskAnomalyBadge';

/**
 * TaskRow — the one dense desktop "report row" shared by the manager report tables
 * (Reports + DailyStatistics), so a finished task reads identically in both and there is a
 * single place that fixes the column order and the assignee/priority/status/comments cells.
 *
 * The stable cells (leading confirm checkbox, assignee, priority, status, comments) are built
 * in here; the cells whose content genuinely diverges per surface — the title cell (expandable
 * vs flat, different secondary lines) and the time cell (read-only vs an inline admin editor) —
 * and the trailing action(s) are passed as nodes. This keeps any per-surface stateful UI in the
 * caller and avoids turning TaskRow into a branching mega-component (the column order is fixed:
 * [confirm?] · title · assignee · time · [completedAt?] · priority · status · comments · actions).
 *
 * Deleted flows through DeletedBadge (never a status tone) — the binding 2026-06-22 decision.
 *
 * @param {Object} props
 * @param {Object} props.task
 * @param {string} [props.rowClassName] - the row's background/hover classes (surface tint)
 * @param {boolean} [props.showConfirm] - render the leading confirmation checkbox cell
 * @param {boolean} [props.confirmChecked]
 * @param {boolean} [props.confirmDisabled]
 * @param {(task: Object) => void} [props.onToggleConfirm]
 * @param {string} [props.confirmAriaLabel]
 * @param {import('react').ReactNode} props.titleCell - the UŽDUOTIS cell content
 * @param {string} [props.assigneeName] - assignee display name (DARB. cell)
 * @param {import('react').ReactNode} props.timeCell - the time cell content (read-only or editor)
 * @param {boolean} [props.showCompletedAt] - render the ATLIKTA cell
 * @param {import('react').ReactNode} [props.completedAtCell] - ATLIKTA cell content
 * @param {number} [props.commentCount]
 * @param {(task: Object) => void} [props.onOpenComments]
 * @param {import('react').ReactNode} [props.actions] - trailing action cell content
 */
export default function TaskRow({
    task,
    rowClassName,
    showConfirm = false,
    confirmChecked = false,
    confirmDisabled = false,
    onToggleConfirm,
    confirmAriaLabel,
    titleCell,
    assigneeName,
    timeCell,
    showCompletedAt = false,
    completedAtCell = null,
    commentCount = 0,
    onOpenComments,
    actions = null,
}) {
    const deleted = task.isDeleted || task.status === 'deleted';
    return (
        <tr className={rowClassName}>
            {showConfirm && (
                <td className="px-2 py-2 text-center align-top">
                    <input
                        type="checkbox"
                        checked={confirmChecked}
                        onChange={() => onToggleConfirm?.(task)}
                        disabled={confirmDisabled}
                        aria-label={confirmAriaLabel}
                        className="w-4 h-4 rounded border-line text-feedback-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-feedback-success focus-visible:ring-offset-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                    />
                </td>
            )}
            <td className="px-2 py-2 align-top">{titleCell}</td>
            <td className="px-1 py-2 whitespace-nowrap align-top">
                {assigneeName && <AssigneeChip userId={task.assignedUserId} name={assigneeName} firstNameOnly showIcon={false} />}
            </td>
            <td className="px-1 py-2 whitespace-nowrap text-right align-top font-mono text-ink-strong">{timeCell}</td>
            {showCompletedAt && (
                <td className="px-1 py-2 whitespace-nowrap align-top text-caption text-ink-muted">{completedAtCell}</td>
            )}
            <td className="px-1 py-2 whitespace-nowrap align-top">
                <PriorityBadge priority={task.priority} />
            </td>
            <td className="px-1 py-2 whitespace-nowrap align-top">
                {deleted ? <DeletedBadge /> : <TaskStatusPill task={task} />}
                {/* Read-only runaway-timer flag: surfaces a 3x+ over-estimate (or an unbounded
                    abandoned timer) so a manager can correct it. Manager-only by where TaskRow lives. */}
                <TaskAnomalyBadge task={task} className="flex" />
            </td>
            <td className="px-1 py-2 text-center align-top">
                <IconButton label="Peržiūrėti komentarus" onClick={() => onOpenComments?.(task)}>
                    <MessageSquare className="w-4 h-4" aria-hidden="true" />
                    {commentCount > 0 && <span className="ml-0.5 text-caption font-bold">{commentCount}</span>}
                </IconButton>
            </td>
            <td className="px-1 py-2 text-right align-top">{actions}</td>
        </tr>
    );
}
