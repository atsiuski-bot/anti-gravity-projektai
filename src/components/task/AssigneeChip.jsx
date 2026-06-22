import { User } from 'lucide-react';
import { cn } from '../../utils/cn';
import { formatDisplayName } from '../../utils/formatters';
import { WORKER_FALLBACK_COLOR } from '../../utils/colors';

/**
 * AssigneeChip — the one "who is this assigned to" chip. Two looks, one component:
 *  - ring: the worker's avatar color as a thin ring around a card-colored pill (spacious cards)
 *  - plain: a quiet sunken pill (dense tables / rows)
 * Both run the name through formatDisplayName so "Jonas Kazlauskas" -> "Jonas K." consistently.
 *
 * @param {Object} props
 * @param {string} props.name - assignee display name
 * @param {string} [props.color] - worker avatar color (ring variant only)
 * @param {boolean} [props.ring] - use the colored-ring look (default plain)
 * @param {boolean} [props.firstNameOnly] - show only the first name (dense rows)
 * @param {boolean} [props.showIcon] - show the user glyph (default true)
 * @param {string} [props.className]
 */
export default function AssigneeChip({ name, color, ring = false, firstNameOnly = false, showIcon = true, className }) {
    if (!name) return null;
    const formatted = formatDisplayName(name);
    const display = firstNameOnly ? formatted.split(' ')[0] : formatted;

    if (ring) {
        // The inner pill carries `className` (e.g. a max-w-[...] cap) and `min-w-0` so a long
        // name ellipsis-clips inside a fixed-width table cell instead of stretching it; the
        // name lives in its own `truncate` child for the ellipsis to actually take effect on a
        // flex container. With no cap passed the chip sizes to content exactly as before.
        return (
            <span
                className="inline-flex items-center justify-center p-[2px] rounded-full"
                style={{ backgroundColor: color || WORKER_FALLBACK_COLOR }}
            >
                <span className={cn('inline-flex min-w-0 items-center gap-1 px-1.5 py-0.5 rounded-full font-bold bg-surface-card text-ink', className)}>
                    {showIcon && <User className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                    <span className="truncate">{display}</span>
                </span>
            </span>
        );
    }

    return (
        <span className={cn('inline-flex items-center gap-1 px-2 py-1 rounded-full text-caption font-medium bg-surface-sunken text-ink border border-line', className)}>
            {showIcon && <User className="w-3 h-3" aria-hidden="true" />}
            {display}
        </span>
    );
}
