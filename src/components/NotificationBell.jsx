import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useNotifications } from '../context/NotificationsContext';
import { useNavigation } from '../context/NavigationContext';
import { tabFromLink } from '../notifications/pushIntent';
import { useMediaQuery } from '../hooks/useMediaQuery';
import Modal from './ui/Modal';
import Popover from './ui/Popover';
import ManagerNotifications from './ManagerNotifications';

/**
 * NotificationBell — the top-bar entry to the notification feed. Surfaces the live unread count
 * (the SAME `unreadCount` that drives the OS app-icon badge — now with a visible in-app home).
 *
 * Presentation follows the viewport: on desktop (md+) the panel is an anchored `Popover` that opens
 * just under the bell, right-aligned so it grows toward the screen centre (the GitHub/Slack/Linear
 * convention); on phones it stays the centred `Modal` (a corner-anchored dropdown is wrong on a
 * narrow screen). The mount is gated by `useMediaQuery` because the two are different overlays, not a
 * CSS show/hide (DESIGN_SYSTEM §9). The same `open` flag drives both.
 *
 * The count is two-way: a manager's pending approvals/requests AND a worker's manager-decision
 * notices. The button's accessible name speaks the count, so the badge colour is never the sole
 * signal (DESIGN_SYSTEM §4-A / WCAG 1.4.1).
 */
const PANEL_ID = 'notification-popover';

export default function NotificationBell() {
    const { unreadCount, pushIntent, clearPushIntent } = useNotifications();
    const { setActiveTab } = useNavigation();
    const [open, setOpen] = useState(false);
    const isDesktop = useMediaQuery('(min-width: 768px)');
    const bellRef = useRef(null);

    // A tapped background notification lands here (ADR 0024). The bell is the first component inside
    // the router that can act on it, so it owns the two navigational halves of an intent:
    //
    //   • ROUTE to the tab the notification points at. This is the deep link finally working for an
    //     already-open app — the FCM worker is registered at its own scope, so it never controlled
    //     this page and WindowClient.navigate() always rejected; a tap could only ever focus.
    //   • OPEN the panel when a decision button was pressed, because the handler that owns each
    //     decision lives in the feed inside it (and so does the undo snackbar / error banner the
    //     manager needs to see afterwards).
    //
    // A plain tap on the notification BODY routes and stops — same as before, no panel. The intent
    // is then consumed by ManagerNotifications, which runs the decision and clears it.
    useEffect(() => {
        if (!pushIntent) return;
        const tab = tabFromLink(pushIntent.link);
        if (tab) setActiveTab(tab);
        if (pushIntent.action) setOpen(true);
        else clearPushIntent();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- react to a NEW intent only; setActiveTab is re-created every provider render and would re-fire this.
    }, [pushIntent, clearPushIntent]);

    const label = unreadCount > 0 ? `Pranešimai, ${unreadCount} nauji` : 'Pranešimai';
    const badge = unreadCount > 99 ? '99+' : String(unreadCount);
    // Closing the panel CANCELS an intent that has not run yet. The feed executes an intent only
    // once its listener has delivered a snapshot, so a user who dismisses the panel inside that
    // window would otherwise leave a decision armed — and it would fire, unexplained, the next time
    // they opened the bell. An intent that already ran cleared itself before any close could occur.
    const close = () => {
        setOpen(false);
        if (pushIntent?.action) clearPushIntent();
    };

    return (
        <>
            <button
                ref={bellRef}
                type="button"
                onClick={() => (open ? close() : setOpen(true))}
                aria-label={label}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? PANEL_ID : undefined}
                className={`relative inline-flex min-h-touch min-w-touch items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring focus-visible:ring-offset-2 ${open ? 'bg-surface-sunken text-ink' : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'}`}
            >
                <Bell className="h-5 w-5" aria-hidden="true" />
                {unreadCount > 0 && (
                    <span
                        aria-hidden="true"
                        className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-caption font-bold leading-none text-white"
                    >
                        {badge}
                    </span>
                )}
            </button>

            {isDesktop ? (
                // Desktop: the anchored panel drops its own "Pranešimai" + X chrome — the
                // Aktyvūs / Istorija tab bar inside is the panel's header (and outside-click /
                // Escape already close a non-modal Popover, so no X is needed).
                <Popover anchorRef={bellRef} open={open} onClose={close} title="Pranešimai" id={PANEL_ID} hideHeader>
                    <ManagerNotifications onClose={close} />
                </Popover>
            ) : (
                open && (
                    // Phone: a top-anchored sheet (not a centred dialog) so the feed reads from the
                    // top down and grows downward as the list (e.g. full history) gets longer. The
                    // tab bar inside is sticky, so it stays pinned while the list scrolls; the
                    // panel's own title/X chrome is dropped in favour of that tab bar.
                    <Modal open onClose={close} ariaLabel="Pranešimai" size="md" align="top" hideCloseButton>
                        <ManagerNotifications onClose={close} />
                    </Modal>
                )
            )}
        </>
    );
}
