import { AlarmClock, AlarmClockCheck } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useAuth } from '../../context/AuthContext';
import { isTaskSnoozed, hasReturnedFromSnooze, formatSnoozeUntil } from '../../utils/taskSnooze';

/**
 * SnoozeBadge — the read-only snooze state of a task, for the card and the table row:
 *   - parked:   "Atidėta iki pirm. 07:00 · Laukiu medžiagų" (+ who, when it was someone else)
 *   - returned: "Grįžo iš atidėjimo" for the rest of the work day it came back
 * Renders nothing otherwise. Icon + text always travel together (DESIGN_SYSTEM §5), and the pill
 * rides on the raised surface like TaskFlagBadges so it stays legible on a tinted card.
 */
export default function SnoozeBadge({ task, size = 'md', className }) {
    const { currentUser } = useAuth();
    const snoozed = isTaskSnoozed(task);
    const returned = !snoozed && hasReturnedFromSnooze(task);
    if (!snoozed && !returned) return null;

    const iconClass = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
    const pill = 'inline-flex max-w-full items-center gap-1 rounded-full border bg-surface-card px-2 py-0.5 text-caption font-semibold shadow-sm';

    if (returned) {
        return (
            <span className={cn(pill, 'border-feedback-info-border text-feedback-info-text', className)}>
                <AlarmClockCheck className={cn(iconClass, 'shrink-0')} aria-hidden="true" />
                Grįžo iš atidėjimo
            </span>
        );
    }

    const byOther = task.snoozedBy && task.snoozedBy !== currentUser?.uid && task.snoozedByName;
    const parts = [`Atidėta iki ${formatSnoozeUntil(task.snoozedUntil)}`];
    if (task.snoozeReason) parts.push(task.snoozeReason);
    if (byOther) parts.push(task.snoozedByName);
    const text = parts.join(' · ');

    return (
        <span className={cn(pill, 'border-feedback-warning-border text-feedback-warning-text', className)} title={text}>
            <AlarmClock className={cn(iconClass, 'shrink-0')} aria-hidden="true" />
            <span className="truncate">{text}</span>
        </span>
    );
}
