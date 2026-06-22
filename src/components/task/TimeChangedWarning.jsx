import { cn } from '../../utils/cn';
import { formatMinutesToTimeString } from '../../utils/timeUtils';
import { formatDisplayName } from '../../utils/formatters';

/**
 * TimeChangedWarning — the single "⚠ Pakeistas laikas" disclosure shown when a manager has
 * manually overridden a task's tracked time. Renders the before→after figures and the
 * (mandatory) reason + who made the change, so a payable-hours edit is always self-describing.
 * Previously copied verbatim across the mobile card, the desktop row, and daily statistics.
 *
 * Renders nothing when the task's time was never changed.
 *
 * @param {Object} props
 * @param {Object} props.task
 * @param {boolean} [props.alignEnd] - right-align the reason block (for right-aligned table cells)
 * @param {string} [props.className]
 */
export default function TimeChangedWarning({ task, alignEnd = false, className }) {
    if (!task?.timeChanged) return null;
    const hasRange = Number.isFinite(task.timeChangedFrom) && Number.isFinite(task.timeChangedTo);
    return (
        <div className={cn('mt-0.5', className)}>
            <div className="text-feedback-danger font-bold text-caption uppercase tracking-wide">
                ⚠ Pakeistas laikas
            </div>
            {hasRange && (
                <div className="text-caption text-ink-muted font-sans normal-case font-normal">
                    {formatMinutesToTimeString(task.timeChangedFrom)} → {formatMinutesToTimeString(task.timeChangedTo)}
                </div>
            )}
            {task.timeChangedReason && (
                <div className={cn(
                    'text-caption text-ink-muted font-sans normal-case font-normal italic break-words',
                    alignEnd && 'max-w-[12rem] ml-auto'
                )}>
                    „{task.timeChangedReason}“{task.timeChangedByName ? ` — ${formatDisplayName(task.timeChangedByName)}` : ''}
                </div>
            )}
        </div>
    );
}
