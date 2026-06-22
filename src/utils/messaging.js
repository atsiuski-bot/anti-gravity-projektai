import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';
import { doc, setDoc, arrayUnion } from 'firebase/firestore';
import app, { db } from '../firebase';

/**
 * FCM client glue. True background push needs three things this module wires up:
 *   1. a registered device token, stored per-user at fcm_tokens/{uid}.tokens,
 *   2. the dedicated FCM service worker (public/firebase-messaging-sw.js),
 *   3. a foreground message handler (onMessage) so an in-app toast shows when the tab is open.
 *
 * Everything degrades gracefully: unsupported browsers, a missing VAPID key, or a denied
 * permission simply no-op, so the app runs identically with or without push configured.
 */

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

// getMessaging throws in unsupported contexts (no SW / no Push API), so gate on isSupported()
// and memoize the resolved instance (or null).
let messagingPromise = null;
function resolveMessaging() {
    if (!messagingPromise) {
        messagingPromise = isSupported()
            .then((ok) => (ok ? getMessaging(app) : null))
            .catch(() => null);
    }
    return messagingPromise;
}

/**
 * Register (or refresh) this device's FCM token and persist it for the user. Safe to call on
 * every load once permission is granted — arrayUnion dedupes, and dead tokens are pruned
 * server-side on send failure.
 */
export async function registerFcmToken(currentUser) {
    try {
        if (!currentUser?.uid) return;
        if (!VAPID_KEY) {
            console.info('[fcm] VITE_FIREBASE_VAPID_KEY not set — push token registration skipped.');
            return;
        }
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        if (!('serviceWorker' in navigator)) return;

        const messaging = await resolveMessaging();
        if (!messaging) return;

        // Register the FCM SW at its own scope so it does not fight the PWA (Workbox) SW at "/".
        const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
            scope: '/firebase-cloud-messaging-push-scope'
        });

        const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
        if (!token) return;

        await setDoc(
            doc(db, 'fcm_tokens', currentUser.uid),
            { tokens: arrayUnion(token), updatedAt: new Date().toISOString() },
            { merge: true }
        );
    } catch (err) {
        console.warn('[fcm] token registration failed:', err);
    }
}

/**
 * Subscribe to foreground messages (tab focused). Returns an unsubscribe function.
 * @param {(payload: object) => void} handler
 */
export async function onForegroundMessage(handler) {
    try {
        const messaging = await resolveMessaging();
        if (!messaging) return () => {};
        return onMessage(messaging, handler);
    } catch {
        return () => {};
    }
}
