import { AlertTriangle } from 'lucide-react';
import { cn } from '../../utils/cn';
import { isTaskTimerAnomalous } from '../../utils/timeUtils';

/**
 * TaskAnomalyBadge — a non-blocking "⚠ Patikrinti" flag for MANAGER-facing task rows whose
 * accumulated timer is implausible versus the task's own estimate (a 3×+ overrun, or a large
 * timer with no estimate to bound it — the forgot-to-stop / runaway-timer signature). It surfaces
 * the corruption the read-side clamp otherwise hides in reports, so a manager can correct the time
 * rather than have it silently capped. Read-only: it computes and flags, never writes.
 *
 * Ratio-based (see isTaskTimerAnomalous) so a legitimate multi-day job with a large estimate is
 * never flagged. Color is never the sole signal — icon + text label (WCAG 1.4.1). Rendered inside
 * TaskRow, which lives only on the manager report tables, so it stays a manager-side affordance.
 *
 * Renders nothing when the task's time is plausible.
 *
 * @param {Object} props
 * @param {Object} props.task
 * @param {string} [props.className]
 */
export default function TaskAnomalyBadge({ task, className }) {
    if (!isTaskTimerAnomalous(task)) return null;
    return (
        <span
            className={cn(
                'mt-0.5 inline-flex items-center gap-1 text-feedback-warning-text font-bold text-caption uppercase tracking-wide',
                className
            )}
            title="Užfiksuotas laikas gerokai viršija planą — galbūt pamirštas laikmatis. Patikrinkite."
        >
            <AlertTriangle className="w-3 h-3" aria-hidden="true" /> Patikrinti
        </span>
    );
}
