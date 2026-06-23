import { User } from 'lucide-react';
import { cn } from '../../utils/cn';
import { formatDisplayName } from '../../utils/formatters';
import { WORKER_FALLBACK_COLOR } from '../../utils/colors';
import { useUsers } from '../../context/UsersContext';
import { useProfileViewer } from '../../context/ProfileViewerContext';
import Avatar from '../ui/Avatar';

/**
 * AssigneeChip — the one "who is this assigned to" chip. Two looks, one component:
 *  - ring: the worker's color as a small leading dot on a calm pill (spacious cards)
 *  - plain: a quiet sunken pill (dense tables / rows)
 * Both run the name through formatDisplayName so "Jonas Kazlauskas" -> "Jonas K." consistently.
 *
 * When a `userId` is given the chip becomes a clickable link to that member's profile (it opens
 * the app-wide ProfileViewer overlay), and the ring variant shows the real avatar in place of
 * the generic User glyph. Without a userId it is the original static chip — legacy rows that
 * carry only a name still render, just not clickable. Resolution is graceful: the photo/name are
 * read from the live users map and fall back to the passed `name`.
 *
 * @param {Object} props
 * @param {string} props.name - assignee display name (fallback when the user map has no record)
 * @param {string} [props.userId] - assignee uid; when present the chip is clickable + shows the avatar
 * @param {string} [props.color] - worker avatar color (ring variant only)
 * @param {boolean} [props.ring] - use the colored-ring look (default plain)
 * @param {boolean} [props.firstNameOnly] - show only the first name (dense rows)
 * @param {boolean} [props.showIcon] - show the user glyph when there is no avatar (default true)
 * @param {string} [props.className]
 */
export default function AssigneeChip({ name, userId, color, ring = false, firstNameOnly = false, showIcon = true, className }) {
    const { usersMap } = useUsers();
    const { openProfile } = useProfileViewer();
    if (!name && !userId) return null;

    const user = userId ? usersMap?.[userId] : null;
    const fullName = user?.displayName || name || '';
    const formatted = formatDisplayName(fullName);
    const display = firstNameOnly ? formatted.split(' ')[0] : formatted;

    const clickable = !!userId;
    const Tag = clickable ? 'button' : 'span';
    const tagProps = clickable
        ? {
            type: 'button',
            // Stop the click from also triggering a clickable ancestor (card/row open).
            onClick: (e) => { e.stopPropagation(); openProfile(userId); },
            'aria-label': `Atidaryti ${display} profilį`,
        }
        : {};
    const interactive = clickable
        ? 'transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1'
        : '';

    if (ring) {
        // The leading glyph: the real avatar when we know who this is, else the generic User icon.
        const leading = userId
            ? <Avatar src={user?.photoURL || null} name={fullName} email={user?.email} size="xs" className="shrink-0" />
            : (showIcon ? <User className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> : null);
        // One calm pill — the same weight the manager (UserChip) chip carries — so assignee and
        // Vadovas read at a single size. The worker colour survives as a small leading dot instead
        // of a full ring that inflated the element and made every chip look a different size.
        return (
            <Tag
                {...tagProps}
                className={cn('inline-flex min-w-0 items-center gap-1.5 px-2 py-0.5 rounded-full border border-line bg-surface-sunken text-caption font-medium text-ink', interactive, className)}
            >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color || WORKER_FALLBACK_COLOR }} aria-hidden="true" />
                {leading}
                <span className="truncate">{display}</span>
            </Tag>
        );
    }

    return (
        <Tag
            {...tagProps}
            className={cn('inline-flex items-center gap-1 px-2 py-1 rounded-full text-caption font-medium bg-surface-sunken text-ink border border-line', interactive, className)}
        >
            {showIcon && !userId && <User className="w-3 h-3" aria-hidden="true" />}
            {display}
        </Tag>
    );
}
