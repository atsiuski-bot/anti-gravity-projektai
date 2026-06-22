import { useEffect, useRef } from 'react';
import { showLocalNotification, clearLocalNotification } from '../utils/localNotify';

/**
 * Custom hook to manage system notifications for active work sessions.
 * Shows a persistent status-bar notification reflecting the current session state.
 *
 * Notifications are raised via the shared helper (showLocalNotification), which routes through a
 * service worker where the page `new Notification(...)` constructor is unavailable (Android /
 * installed PWA) — the previous direct-constructor version threw and was silently swallowed on
 * exactly the worker's primary device. A single stable `tag` ('work-session') means each new
 * state replaces the prior one.
 *
 * `enabled` is the per-user profile toggle: when off, no session notification is shown and any
 * live one is cleared.
 */
export function useSessionNotification({ isQuickWorking, isCalling, isTakingBreak, isRunning, enabled = true }) {
    const previousStateRef = useRef(null);

    useEffect(() => {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
            return undefined;
        }

        // Respect the per-user profile toggle: clear any live notification and show none.
        if (!enabled) {
            clearLocalNotification('work-session');
            previousStateRef.current = null;
            return undefined;
        }

        // Determine current session state + copy (emoji stays in the TEXT, never the icon).
        let currentState = null;
        let title = '';
        let body = '';

        if (isQuickWorking) {
            currentState = 'quickWork';
            title = 'Skubus darbas aktyvus';
            body = '⚡ Greitasis darbas vykdomas';
        } else if (isCalling) {
            currentState = 'call';
            title = 'Skambutis aktyvus';
            body = '📞 Skambinimo sesija vykdoma';
        } else if (isTakingBreak) {
            currentState = 'break';
            title = 'Pertrauka';
            body = '☕ Dabar pertraukos metu';
        } else if (isRunning) {
            currentState = 'working';
            title = 'Darbas vykdomas';
            body = '💼 Darbo sesija aktyvi';
        }

        if (currentState !== previousStateRef.current) {
            if (currentState) {
                // Same tag replaces any prior session notification — no need to close first.
                showLocalNotification(title, {
                    body,
                    tag: 'work-session',
                    requireInteraction: true,
                    silent: true,
                    onClick: () => { try { window.focus(); } catch { /* ignore */ } }
                });
            } else {
                // Session ended — clear the lingering notification.
                clearLocalNotification('work-session');
            }
            previousStateRef.current = currentState;
        }

        return undefined;
    }, [isQuickWorking, isCalling, isTakingBreak, isRunning, enabled]);

    // Clear the session notification on unmount.
    useEffect(() => {
        return () => { clearLocalNotification('work-session'); };
    }, []);
}
