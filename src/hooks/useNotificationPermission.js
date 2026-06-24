import { useCallback, useEffect, useState } from 'react';
import { registerFcmToken, isPushSupported } from '../utils/messaging';

/**
 * useNotificationPermission — reads the LIVE OS notification permission and whether push is supported,
 * and exposes a gesture-safe request().
 *
 * This is the gate that the app's `notificationsEnabled` preference cannot see. A user can have the
 * preference ON while the browser silently blocks every push; surfacing the real OS state is what lets
 * the Profile toggle explain "switch is on, but the phone is blocking it" instead of failing silently.
 *
 *   - permission : 'default' | 'granted' | 'denied' | 'unsupported'
 *   - supported  : true once isPushSupported() resolves true (Push API + SW + messaging context)
 *   - request()  : MUST be called from inside a user gesture (a tap handler). iOS rejects a request
 *                  detached from a gesture. On grant it also fetches + persists this device's token
 *                  immediately (instead of waiting for the next foreground return).
 */
export function useNotificationPermission(currentUser) {
    const [permission, setPermission] = useState(
        typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
    );
    const [supported, setSupported] = useState(true);

    // Re-read the permission on mount and whenever the tab regains focus: the user may flip it in OS /
    // browser settings while away, and there is no event for that change.
    useEffect(() => {
        const sync = () => {
            setPermission(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
        };
        sync();
        const onVisible = () => { if (document.visibilityState === 'visible') sync(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, []);

    // Resolve true push support once (async probe).
    useEffect(() => {
        let alive = true;
        isPushSupported()
            .then((ok) => { if (alive) setSupported(ok); })
            .catch(() => { if (alive) setSupported(false); });
        return () => { alive = false; };
    }, []);

    const request = useCallback(async () => {
        if (typeof Notification === 'undefined') return 'unsupported';
        let result = Notification.permission;
        if (result === 'default') {
            try {
                result = await Notification.requestPermission();
            } catch {
                result = 'denied';
            }
        }
        setPermission(result);
        if (result === 'granted' && currentUser) {
            // Fetch + persist this device's token now — don't wait for the next visibilitychange.
            registerFcmToken(currentUser);
            // Keep parity with the first-interaction prompt path (NotificationsContext also listens).
            try { window.dispatchEvent(new CustomEvent('notifications-granted')); } catch { /* ignore */ }
        }
        return result;
    }, [currentUser]);

    return { permission, supported, request };
}
