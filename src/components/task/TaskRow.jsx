import AssigneeChip from './AssigneeChip';
import PriorityBadge from './PriorityBadge';
import TaskStatusIcon from './TaskStatusIcon';
import TaskFlagBadges from './TaskFlagBadges';

/**
 * TaskRow — the ONE dense desktop "task row" shared by the report/history tables
 * (Reports + DailyStatistics + TaskHistory), so a task reads identically in all of them AND matches
 * the active board (TaskTable): a leading status glyph + title, then assignee, priority, time, tag,
 * and the trailing actions. There is no confirm checkbox / status-pill / completed-at / comments
 * column — the status is the glyph, acceptance/return/comments are trailing action buttons, exactly
 * like the active board. The cells whose content genuinely diverges per surface — the title cell
 * (expandable vs flat, different secondary lines), the time cell (plan/actual) and the trailing
 * action(s) — are passed as nodes, so per-surface stateful UI stays in the caller.
 *
 * Column order is fixed and mirrors TaskTable: glyph·title · assignee · priority · time · tag · actions.
 *
 * @param {Object} props
 * @param {Object} props.task
 * @param {string} [props.rowClassName] - the row's background/hover classes (surface tint)
 * @param {import('react').ReactNode} props.titleCell - the UŽDUOTIS cell content (after the glyph)
 * @param {string} [props.assigneeName] - assignee display name (VYKD. cell)
 * @param {import('react').ReactNode} props.timeCell - the time cell content (plan / actual)
 * @param {import('react').ReactNode} [props.actions] - trailing action cell content
 * @param {Function} [props.onOpen] - (task) => void; when set the whole row is a click target that
 *   opens the shared task detail sheet (the time + actions cells stop propagation so their own
 *   controls still work). This is how a task reads identically everywhere: one click → one sheet.
 */
export default function TaskRow({
    task,
    rowClassName,
    titleCell,
    assigneeName,
    timeCell,
    actions = null,
    onOpen = null,
}) {
    const stop = (e) => e.stopPropagation();
    return (
        <tr
            className={onOpen
                ? `${rowClassName || ''} cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand`
                : rowClassName}
            onClick={onOpen ? () => onOpen(task) : undefined}
            // Keyboard parity (WCAG 2.1.1): the whole row is an "open the task" control, so it must be
            // focusable and operable with Enter / Space, not mouse-only.
            role={onOpen ? 'button' : undefined}
            tabIndex={onOpen ? 0 : undefined}
            aria-label={onOpen ? `Atidaryti užduotį: ${task.title}` : undefined}
            onKeyDown={onOpen ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(task); }
            } : undefined}
        >
            {/* UŽDUOTIS — a leading status glyph (the same shape the card + active board show) sits in
                front of the caller's title content, so lifecycle/approval state reads at a glance
                while scanning. Decorative: the title text already names the task. */}
            <td className="px-2 py-2 align-top">
                <div className="flex items-start gap-1.5">
                    <TaskStatusIcon task={task} size="sm" decorative className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                        {titleCell}
                        {/* Worker attention flags — render only on still-active tasks (the helper drops
                            them once finished/accepted), so a manager scanning reports/history sees a
                            live "Reikia vadovo" / "Laukiama" but never a stale one. */}
                        <TaskFlagBadges task={task} size="sm" className="mt-1" />
                    </div>
                </div>
            </td>
            <td className="px-1 py-2 whitespace-nowrap align-top">
                {assigneeName && <AssigneeChip userId={task.assignedUserId} name={assigneeName} firstNameOnly showIcon={false} />}
            </td>
            <td className="px-1 py-2 whitespace-nowrap align-top">
                <PriorityBadge priority={task.priority} />
            </td>
            <td className="px-1 py-2 whitespace-nowrap text-right align-top font-mono text-ink-strong" onClick={onOpen ? stop : undefined}>{timeCell}</td>
            {/* Žymos — its own column, far right before the actions (mirrors TaskTable). */}
            <td className="px-1 py-2 align-top">
                {task.tag && (
                    <span className="inline-flex items-center rounded-md border border-feedback-info-border bg-feedback-info-soft px-1.5 py-0.5 text-caption font-semibold text-feedback-info-text">
                        {task.tag}
                    </span>
                )}
            </td>
            <td className="px-1 py-2 text-right align-top" onClick={onOpen ? stop : undefined}>{actions}</td>
        </tr>
    );
}
