import { useState } from 'react';
import { Bell } from 'lucide-react';
import { useNotifications } from '../context/NotificationsContext';
import Modal from './ui/Modal';
import ManagerNotifications from './ManagerNotifications';

/**
 * NotificationBell — the top-bar entry to the notification feed. Surfaces the live unread count
 * (the SAME `unreadCount` that drives the OS app-icon badge — now with a visible in-app home) and
 * opens the hybrid panel (action cards + info rows) in the canonical Modal shell.
 *
 * The count is two-way: a manager's pending approvals/requests AND a worker's manager-decision
 * notices. The button's accessible name speaks the count, so the badge colour is never the sole
 * signal (DESIGN_SYSTEM §4-A / WCAG 1.4.1).
 */
export default function NotificationBell() {
    const { unreadCount } = useNotifications();
    const [open, setOpen] = useState(false);

    const label = unreadCount > 0 ? `Pranešimai, ${unreadCount} nauji` : 'Pranešimai';
    const badge = unreadCount > 99 ? '99+' : String(unreadCount);

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label={label}
                className="relative inline-flex min-h-touch min-w-touch items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
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

            {open && (
                <Modal open onClose={() => setOpen(false)} title="Pranešimai" size="md">
                    <ManagerNotifications onClose={() => setOpen(false)} />
                </Modal>
            )}
        </>
    );
}
