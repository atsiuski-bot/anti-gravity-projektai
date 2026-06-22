import { Check } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * CompletedMarker — the one "finished work" signal on a task title. Replaces the old
 * struck-through title for completed work: strikethrough now means ONLY deleted
 * (see <DeletedBadge>), so finished work gets a positive leading check instead.
 *
 * The presence of the green CIRCLE is the confirmation axis, so meaning survives without
 * color (§5):
 *  - confirmed (manager approved) -> white check on a filled green disc — a "closed" win.
 *  - completed (awaiting confirmation) -> bare green check, no circle — done, ring not closed.
 *
 * Render before the title when `task.status` is 'completed' or 'confirmed' (or `task.completed`).
 * The matching StatusPill ("Nepatvirtinta"/"Patvirtinta") still carries the word.
 *
 * @param {Object} props
 * @param {Object} props.task
 * @param {string} [props.className]
 */
export default function CompletedMarker({ task, className }) {
    const confirmed = task?.status === 'confirmed';
    const completed = confirmed || task?.status === 'completed' || task?.completed;
    if (!completed) return null;

    if (confirmed) {
        return (
            <span
                className={cn(
                    'inline-flex shrink-0 items-center justify-center align-[-0.2em]',
                    'h-[1.15em] w-[1.15em] rounded-full bg-feedback-success',
                    className
                )}
                aria-label="Patvirtinta"
            >
                <Check className="h-[0.8em] w-[0.8em] text-white" strokeWidth={3} aria-hidden="true" />
            </span>
        );
    }

    return (
        <Check
            className={cn('inline-block shrink-0 h-[1.1em] w-[1.1em] align-[-0.15em] text-feedback-success', className)}
            strokeWidth={3}
            aria-label="Užbaigta"
        />
    );
}
