import { cn } from '../utils/cn';
import { useUsers } from '../context/UsersContext';
import { useProfileViewer } from '../context/ProfileViewerContext';
import { formatDisplayName } from '../utils/formatters';
import Avatar from './ui/Avatar';

/**
 * UserChip — a person shown as avatar + name that opens their profile on click. Drops in
 * wherever a bare name used to render. It inherits the surrounding text color/size, so it reads
 * on any surface (including the coloured live-session cards), and it is an inline link (WCAG
 * 2.5.5 inline exception) rather than a 44px block. The photo and canonical name are resolved
 * from the live users map, so call sites only need the uid (+ a fallback name for legacy rows).
 * With no resolvable uid it degrades to a static, non-clickable name.
 */
export default function UserChip({ userId, name, size = 'sm', className }) {
    const { usersMap } = useUsers();
    const { openProfile } = useProfileViewer();
    const user = userId ? usersMap?.[userId] : null;
    const display = formatDisplayName(user?.displayName || name || '');
    const avatarSize = size === 'md' ? 'sm' : 'xs';

    const inner = (
        <>
            <Avatar src={user?.photoURL || null} name={user?.displayName || name} email={user?.email} size={avatarSize} />
            <span className="truncate">{display}</span>
        </>
    );

    if (!userId) {
        return <span className={cn('inline-flex items-center gap-1.5', className)}>{inner}</span>;
    }

    return (
        <button
            type="button"
            // Stop the click from also triggering a clickable ancestor (e.g. opening the task card).
            onClick={(e) => { e.stopPropagation(); openProfile(userId); }}
            aria-label={`Atidaryti ${display} profilį`}
            className={cn(
                'inline-flex items-center gap-1.5 rounded-full hover:underline',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
                className
            )}
        >
            {inner}
        </button>
    );
}
