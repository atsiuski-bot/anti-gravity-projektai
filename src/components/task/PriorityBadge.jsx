import { cn } from '../../utils/cn';
import { getPriorityColor, getPriorityLabel, getPriorityTextColor } from '../../utils/priority';
import PriorityMeter from '../icons/PriorityMeter';

/**
 * PriorityBadge — the single priority chip for the whole app. Before this, the same
 * inline-hex <span> was hand-rolled in six surfaces (and Reports dropped the color entirely);
 * now every surface renders priority identically and the WCAG-correct fg/bg pairing lives in
 * exactly one place (priority.js).
 *
 * The chip uses inline hex on purpose — the priority scale is a fixed, contrast-tuned ramp
 * defined in priority.js, not a Tailwind token, and getPriorityTextColor guarantees AA.
 *
 * A missing/invalid priority is normalized to the default (Vidutinis) rather than hidden, so
 * dense tables keep showing a priority for every row exactly as before. Callers that want to
 * hide priority when absent (e.g. the worker card) guard the element with `task.priority && …`.
 *
 * @param {Object} props
 * @param {string} props.priority - raw priority value (normalized internally)
 * @param {'sm'|'md'} [props.size] - sm for dense rows, md for spacious cards
 * @param {boolean} [props.pill] - fully-rounded (cards) vs slightly-rounded (table rows)
 * @param {string} [props.className]
 */
export default function PriorityBadge({ priority, size = 'sm', pill = false, className }) {
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 font-bold uppercase whitespace-nowrap border',
                pill ? 'rounded-full' : 'rounded-md',
                size === 'md' ? 'px-2 py-0.5 text-caption' : 'px-1.5 py-0.5 text-caption leading-4',
                className
            )}
            style={{
                backgroundColor: getPriorityColor(priority),
                color: getPriorityTextColor(priority),
                borderColor: 'var(--priority-hairline)',
            }}
        >
            {/* Countable signal-strength bars lead the label; they inherit the chip's
                WCAG-tuned text color via currentColor (ADR 0010). */}
            <PriorityMeter priority={priority} className={cn('shrink-0', size === 'md' ? 'h-3' : 'h-2.5')} />
            {getPriorityLabel(priority)}
        </span>
    );
}
