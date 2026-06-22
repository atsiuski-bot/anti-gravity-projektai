/**
 * Local (foreground) notification helper.
 *
 * Why this exists: the page-context `new Notification(title, opts)` constructor THROWS
 * ("Illegal constructor") on Android Chrome and inside installed PWAs — those platforms require
 * notifications to be raised through a ServiceWorkerRegistration. The session/timer alerts that
 * used `new Notification(...)` directly were therefore silently dead on the worker's primary
 * device (the throw was swallowed). This routes through a service worker where the constructor
 * is unavailable, and keeps the constructor only where it works (desktop), so click-to-focus is
 * preserved there.
 *
 * Resolution order:
 *   1. FCM service worker (it ships a `notificationclick` handler → clickable everywhere) when
 *      push is registered;
 *   2. the page constructor (desktop: works, keeps onclick; Android: throws, caught);
 *   3. the page-controlling Workbox SW (Android-safe display; no click handler there).
 *
 * Icons are real PNGs, never emoji — `icon`/`badge` are resolved as URLs, so an emoji string
 * silently fails to load.
 */

const DEFAULT_ICON = '/pwa-192x192.png';
const FCM_SW_SCOPE = '/firebase-cloud-messaging-push-scope';

async function fcmRegistration() {
    if (!('serviceWorker' in navigator)) return null;
    try {
        const reg = await navigator.serviceWorker.getRegistration(FCM_SW_SCOPE);
        return reg && typeof reg.showNotification === 'function' ? reg : null;
    } catch {
        return null;
    }
}

/**
 * Show a foreground notification, best-effort. No-ops unless permission is granted.
 * @param {string} title
 * @param {object} [options] standard Notification options plus an optional `onClick` (desktop only).
 */
export async function showLocalNotification(title, options = {}) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const { onClick, ...rest } = options;
    const opts = { icon: DEFAULT_ICON, badge: DEFAULT_ICON, ...rest };

    // 1. FCM SW — clickable on all platforms.
    const fcm = await fcmRegistration();
    if (fcm) {
        try {
            await fcm.showNotification(title, opts);
            return;
        } catch {
            /* fall through */
        }
    }

    // 2. Desktop page constructor — keeps onclick → focus. Throws on Android/installed PWA.
    try {
        const n = new Notification(title, opts);
        n.onclick = () => {
            try { window.focus(); } catch { /* ignore */ }
            n.close();
            if (typeof onClick === 'function') onClick();
        };
        return;
    } catch {
        /* Android / installed PWA: constructor illegal — use the page-controlling SW. */
    }

    // 3. Page-controlling (Workbox) SW — Android-safe display.
    try {
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.ready;
            if (reg && typeof reg.showNotification === 'function') {
                await reg.showNotification(title, opts);
            }
        }
    } catch {
        /* unsupported — give up silently */
    }
}

/**
 * Close any service-worker notification carrying `tag` (used to clear a session notification when
 * the session ends). Desktop constructor notifications are replaced by tag on the next show.
 * @param {string} tag
 */
export async function clearLocalNotification(tag) {
    if (!('serviceWorker' in navigator)) return;
    const regs = [];
    try {
        const fcm = await navigator.serviceWorker.getRegistration(FCM_SW_SCOPE);
        if (fcm) regs.push(fcm);
    } catch { /* ignore */ }
    try {
        const ready = await navigator.serviceWorker.ready;
        if (ready) regs.push(ready);
    } catch { /* ignore */ }

    for (const reg of regs) {
        try {
            if (typeof reg.getNotifications === 'function') {
                const notes = await reg.getNotifications({ tag });
                notes.forEach((n) => n.close());
            }
        } catch { /* ignore */ }
    }
}
