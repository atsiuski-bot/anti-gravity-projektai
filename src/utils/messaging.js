import { getMessaging, getToken, deleteToken, isSupported } from 'firebase/messaging';
import { doc, setDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import app, { db } from '../firebase';

/**
 * FCM client glue. True background push needs two things this module wires up:
 *   1. a registered device token, stored per-user at fcm_tokens/{uid}.tokens,
 *   2. the dedicated FCM service worker (public/firebase-messaging-sw.js).
 *
 * The FOREGROUND case (tab open) is handled separately by NotificationsContext's Firestore
 * listeners (an in-app toast), NOT by an FCM onMessage handler — see ADR 0004. FCM only adds
 * the tab-closed background case.
 *
 * Everything degrades gracefully: unsupported browsers, a missing VAPID key, or a denied
 * permission simply no-op (returning a status string), so the app runs identically with or
 * without push configured.
 */

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;
const FCM_SW_URL = '/firebase-messaging-sw.js';
const FCM_SW_SCOPE = '/firebase-cloud-messaging-push-scope';

// Last token successfully persisted this session — lets the frequent foreground re-registration
// skip a redundant Firestore write when the token has not actually rotated.
let lastRegisteredToken = null;

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
 * True if this browser can do FCM web push at all (Notification API + service worker + a messaging
 * context the SDK supports). Async because firebase/messaging's isSupported() probes the environment.
 * Lets the UI distinguish "push unsupported here" from "permission not yet granted".
 */
export async function isPushSupported() {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) return false;
    try {
        return await isSupported();
    } catch {
        return false;
    }
}

/**
 * Register (or refresh) this device's FCM token and persist it for the user. Returns a status
 * string ('ok' | 'no-user' | 'no-vapid' | 'denied' | 'unsupported' | 'error') so callers can
 * react (e.g. hint an iOS user to install the PWA).
 *
 * Safe to call on every load AND on each foreground — arrayUnion dedupes, dead tokens are pruned
 * server-side on send failure, and a rotated token is re-fetched and re-persisted here (FCM
 * tokens are not stable; calling only once at login would let a rotated token silently go stale).
 */
export async function registerFcmToken(currentUser) {
    try {
        if (!currentUser?.uid) return 'no-user';
        if (!VAPID_KEY) {
            console.info('[fcm] VITE_FIREBASE_VAPID_KEY not set — push token registration skipped.');
            return 'no-vapid';
        }
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return 'denied';
        if (!('serviceWorker' in navigator)) return 'unsupported';

        const messaging = await resolveMessaging();
        if (!messaging) return 'unsupported';

        // Register the FCM SW at its own scope so it does not fight the PWA (Workbox) SW at "/".
        const swReg = await navigator.serviceWorker.register(FCM_SW_URL, { scope: FCM_SW_SCOPE });

        const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
        if (!token) return 'unsupported';

        // Skip the write when the token is unchanged — foreground re-registration fires often, and
        // arrayUnion of the same value is a no-op write we don't need to pay for.
        if (token === lastRegisteredToken) return 'ok';

        await setDoc(
            doc(db, 'fcm_tokens', currentUser.uid),
            { tokens: arrayUnion(token), updatedAt: new Date().toISOString() },
            { merge: true }
        );
        lastRegisteredToken = token;
        return 'ok';
    } catch (err) {
        console.warn('[fcm] token registration failed:', err);
        return 'error';
    }
}

/**
 * Remove THIS device's token from the user's list and revoke its local push subscription.
 * Call on sign-out — while the user is STILL authenticated, because the owner-only Firestore
 * rule requires request.auth.uid == userId to write fcm_tokens/{uid}. Without this, a token
 * lingers after logout and a shared/handed-over device keeps receiving the previous user's push.
 */
export async function removeFcmToken(currentUser) {
    try {
        if (!VAPID_KEY || !('serviceWorker' in navigator)) return;
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

        const messaging = await resolveMessaging();
        if (!messaging) return;

        const swReg = await navigator.serviceWorker.getRegistration(FCM_SW_SCOPE);
        let token = null;
        try {
            token = await getToken(
                messaging,
                swReg ? { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg } : { vapidKey: VAPID_KEY }
            );
        } catch {
            /* couldn't resolve this device's token — still try to revoke below */
        }

        if (token && currentUser?.uid) {
            await setDoc(
                doc(db, 'fcm_tokens', currentUser.uid),
                { tokens: arrayRemove(token), updatedAt: new Date().toISOString() },
                { merge: true }
            ).catch(() => {});
        }
        // deleteToken revokes the subscription server-side too, so even an un-removed array entry
        // becomes a hard-failure that the sender prunes on the next send.
        await deleteToken(messaging).catch(() => {});
        lastRegisteredToken = null;
    } catch (err) {
        console.warn('[fcm] token removal failed:', err);
    }
}
