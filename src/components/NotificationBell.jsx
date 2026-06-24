import { useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useNotifications } from '../context/NotificationsContext';
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
    const { unreadCount } = useNotifications();
    const [open, setOpen] = useState(false);
    const isDesktop = useMediaQuery('(min-width: 768px)');
    const bellRef = useRef(null);

    const label = unreadCount > 0 ? `Pranešimai, ${unreadCount} nauji` : 'Pranešimai';
    const badge = unreadCount > 99 ? '99+' : String(unreadCount);
    const close = () => setOpen(false);

    return (
        <>
            <button
                ref={bellRef}
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-label={label}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? PANEL_ID : undefined}
                className={`relative inline-flex min-h-touch min-w-touch items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${open ? 'bg-surface-sunken text-ink' : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'}`}
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
                <Popover anchorRef={bellRef} open={open} onClose={close} title="Pranešimai" id={PANEL_ID}>
                    <ManagerNotifications onClose={close} />
                </Popover>
            ) : (
                open && (
                    <Modal open onClose={close} title="Pranešimai" size="md">
                        <ManagerNotifications onClose={close} />
                    </Modal>
                )
            )}
        </>
    );
}
