import { WORKER_FALLBACK_COLOR } from '../../utils/colors';
import UserChip from '../UserChip';

/**
 * AssigneeChip — the "who is this assigned to" chip. It is now a thin wrapper over the single
 * person primitive `UserChip` (DESIGN_SYSTEM §8): the assignee reads in the EXACT same pill as the
 * manager and every other person, the only difference being a small **leading dot in the worker's
 * identity colour** (the same colour the session cards and calendar use). Colour is paired with the
 * avatar + name, so it is never the only signal (§5). Folding the old bespoke pill into UserChip is
 * what makes assignee, manager and mention all render at one shape and one size.
 *
 * @param {Object} props
 * @param {string} props.name - assignee display name (fallback when the user map has no record)
 * @param {string} [props.userId] - assignee uid; when present the chip is clickable + shows the avatar
 * @param {string} [props.color] - worker identity colour (shown as the leading dot)
 * @param {boolean} [props.ring] - show the leading colour dot (kept for call-site compatibility)
 * @param {boolean} [props.firstNameOnly] - show only the first name (dense rows)
 * @param {boolean} [props.showColor] - show the leading colour dot (default true; needs `ring`)
 * @param {boolean} [props.showIcon] - ignored: the avatar (with initials fallback) is always shown now
 * @param {string} [props.size] - UserChip size (default 'sm', the universal standard)
 * @param {string} [props.className]
 */
export default function AssigneeChip({
    name,
    userId,
    color,
    ring = false,
    firstNameOnly = false,
    showColor = true,
    size = 'sm',
    className,
}) {
    if (!name && !userId) return null;
    // The colour dot belongs to the doer; show it on the ring variant (when colour is not suppressed).
    const colorDot = ring && showColor ? (color || WORKER_FALLBACK_COLOR) : undefined;
    return (
        <UserChip
            userId={userId}
            name={name}
            size={size}
            colorDot={colorDot}
            firstNameOnly={firstNameOnly}
            className={className}
        />
    );
}
