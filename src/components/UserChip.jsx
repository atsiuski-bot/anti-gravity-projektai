import { cn } from '../utils/cn';
import { useUsers } from '../context/UsersContext';
import { useProfileViewer } from '../context/ProfileViewerContext';
import { formatDisplayName } from '../utils/formatters';
import Avatar from './ui/Avatar';

/**
 * UserChip — THE single way a person is shown anywhere in the app (DESIGN_SYSTEM §8 "Task people").
 * One visual language: an **avatar + formatted name in a calm pill**, at a size that is owned by the
 * `size` prop alone — never by the call site. A person therefore reads identically whether they are a
 * comment author, a notification actor, an assignee, a manager, or a roster row. Drops in wherever a
 * bare name used to render.
 *
 * Why the size lives here and not in `className`: the chip used to inherit its font size/weight/colour
 * from each parent, so the same person rendered at a dozen different proportions across the app. Now
 * the typography (avatar px · text size · weight · padding) is locked per `size`; callers pass only
 * LAYOUT classes (truncate / max-w / margin / min-w-0) via `className`, never font/size/colour.
 *
 * Variants
 *  - `size="sm"` (default) — 24px avatar + 14px name. The universal in-content standard: mentions,
 *    comments, notifications, list rows, task-card people.
 *  - `size="md"` — 36px avatar + 16px name. Use when the person IS the subject of the row/section
 *    (roster identity, live-session row, section header). Tall enough to be its own 44px tap target.
 *  - `colorDot` — a leading dot in the worker's identity colour (the assignee's "doer" colour). Paired
 *    with the avatar/name so colour is never the only signal (§5). Used by `AssigneeChip`.
 *  - `firstNameOnly` — show only the first name (dense rows).
 *  - `bare` — drop the pill (avatar + name only, colour inherited). Use ONLY when the chip is nested
 *    inside another element that ALREADY draws the pill (e.g. a multi-select toggle button), to avoid
 *    a pill-in-pill.
 *
 * It resolves the photo + canonical name from the live users map, so call sites only need the uid
 * (+ a fallback name for legacy rows). It is clickable → profile when a uid is known and
 * `linkToProfile` is on, and degrades to a static, non-clickable chip (still avatar + name) otherwise.
 * Pass `linkToProfile={false}` when the chip sits INSIDE another interactive element (a drill-down row
 * that is itself a <button>) to avoid an invalid button-in-button. Pass `block` to guarantee the 44px
 * AA touch target when the chip is a STANDALONE primary control (e.g. a roster row's open-profile
 * target); inline uses in running prose keep their slim size.
 */
const SIZES = {
    sm: { avatar: 'xs', text: 'text-body', weight: 'font-medium', pill: 'gap-1.5 px-2 py-0.5', dot: 'h-2 w-2' },
    md: { avatar: 'sm', text: 'text-body-lg', weight: 'font-semibold', pill: 'gap-2 px-2.5 py-1', dot: 'h-2.5 w-2.5' },
};

export default function UserChip({
    userId,
    name,
    size = 'sm',
    colorDot,
    firstNameOnly = false,
    bare = false,
    linkToProfile = true,
    block = false,
    className,
}) {
    const { usersMap } = useUsers();
    const { openProfile } = useProfileViewer();
    const user = userId ? usersMap?.[userId] : null;
    const fullName = user?.displayName || name || '';
    const formatted = formatDisplayName(fullName);
    const display = firstNameOnly ? formatted.split(' ')[0] : formatted;
    const s = SIZES[size] || SIZES.sm;
    const clickable = !!userId && linkToProfile;

    const inner = (
        <>
            {colorDot && (
                <span
                    className={cn('shrink-0 rounded-full', s.dot)}
                    style={{ backgroundColor: colorDot }}
                    aria-hidden="true"
                />
            )}
            <Avatar src={user?.photoURL || null} name={fullName} email={user?.email} size={s.avatar} className="shrink-0" />
            <span className="truncate">{display}</span>
        </>
    );

    // Bare: no pill; avatar + name only, with typography INHERITED from the host. Use only when the
    // chip is nested inside an element that already owns the pill AND the type scale (a multi-select
    // toggle, a dense calendar event label) — bare must not impose its own size there.
    if (bare) {
        const bareCls = cn('inline-flex min-w-0 items-center', s.pill.split(' ')[0], className);
        if (!clickable) return <span className={bareCls}>{inner}</span>;
        return (
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); openProfile(userId); }}
                aria-label={`Atidaryti ${display} profilį`}
                className={cn(bareCls, 'rounded-full hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1')}
            >
                {inner}
            </button>
        );
    }

    // The one calm pill — same border/surface/shape for every person, everywhere.
    const pill = cn(
        'inline-flex min-w-0 items-center rounded-full border border-line bg-surface-sunken text-ink',
        s.pill, s.text, s.weight,
    );

    if (!clickable) {
        return <span className={cn(pill, block && 'min-h-touch', className)}>{inner}</span>;
    }

    return (
        <button
            type="button"
            // Stop the click from also triggering a clickable ancestor (e.g. opening the task card).
            onClick={(e) => { e.stopPropagation(); openProfile(userId); }}
            aria-label={`Atidaryti ${display} profilį`}
            className={cn(
                pill,
                'transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
                block && 'min-h-touch',
                className
            )}
        >
            {inner}
        </button>
    );
}
