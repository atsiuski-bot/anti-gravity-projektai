/* WORKZ Firebase Cloud Messaging service worker.
 *
 * Registered by the FCM SDK at its own scope (/firebase-cloud-messaging-push-scope), so it
 * coexists with the vite-plugin-pwa Workbox SW at "/". The config below is the PUBLIC client
 * config (same values already shipped in the app bundle) — no secrets.
 *
 * The server sends DATA-ONLY messages, so onBackgroundMessage is the single place that renders
 * a background notification (no browser auto-display, no duplicate).
 *
 * SDK version is kept in lock-step with the bundled `firebase` package (package.json). Bumping
 * one without the other risks client/SW skew.
 */
/* eslint-disable no-undef */

// The message this worker posts to an open app window when a notification is tapped. MIRROR of
// PUSH_INTENT_MESSAGE in src/notifications/pushIntent.js — rename one, rename both.
const INTENT_MESSAGE = 'workz-notification-intent';

// Query-param names carrying an intent when NO window is open and we have to cold-start the app.
// MIRROR of the same three constants in src/notifications/pushIntent.js.
const PARAM_ACTION = 'na';
const PARAM_NOTIF = 'nid';
const PARAM_TYPE = 'nt';

// Chrome renders at most Notification.maxActions buttons (2 today) and silently drops the rest.
// Clamp to whatever the platform actually reports so a future third button fails loudly in review
// rather than vanishing at runtime. iOS ignores `actions` altogether — the array is simply unused.
function parseActions(raw) {
    if (!raw) return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return []; // malformed payload → a plain tap-to-open notification, never a broken one
    }
    if (!Array.isArray(parsed)) return [];
    const max = (typeof Notification !== 'undefined' && Notification.maxActions) || 2;
    return parsed
        .filter((a) => a && typeof a.action === 'string' && a.action && typeof a.title === 'string' && a.title)
        // Re-shape rather than pass through: only these two members are ours to declare, so a
        // payload that grew extra keys can't smuggle anything into showNotification.
        .map((a) => ({ action: a.action, title: a.title }))
        .slice(0, max);
}

try {
    importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
    importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

    firebase.initializeApp({
        apiKey: 'AIzaSyDXaHCrL8hKgaEedSXEIT-XSxhmIcCEuXU',
        authDomain: 'darbo-planavimas.firebaseapp.com',
        projectId: 'darbo-planavimas',
        storageBucket: 'darbo-planavimas.firebasestorage.app',
        messagingSenderId: '198926113678',
        appId: '1:198926113678:web:de7f0253681f8c667e62df'
    });

    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
        const data = payload.data || {};
        const title = data.title || 'Gildija';
        // 'action' = a decision is owed (server mirrors registry category into data.category).
        const isAction = data.category === 'action';
        // ALWAYS show a notification for every push received here. A push that arrives without a
        // visible notification breaks the browser's user-visible-push contract — Chrome shows a
        // generic "site updated in background" and, on iOS, the subscription gets revoked after a
        // few silent strikes. So there is no early-return branch: every background push renders.
        self.registration.showNotification(title, {
            body: data.body || '',
            icon: '/pwa-192x192.png',   // Android notification artwork; iOS ignores it (uses the app icon).
            badge: '/pwa-192x192.png',  // Android status-bar glyph only; no-op on iOS.
            // Per-EVENT tag (the source doc id) so two distinct alerts never silently collapse
            // onto one slot; renotify re-alerts when a tag is reused. Fall back to taskId, then
            // a constant. (renotify + tag coalescing are Android-only; iOS ignores both.)
            tag: data.notifId || data.taskId || 'workz-notification',
            renotify: true,
            // Keep an 'action' alert on screen until the user acts on it. Effective on DESKTOP
            // (a manager at a computer); on Android the shade already persists it and iOS ignores
            // requireInteraction — so this helps the desktop case and is harmless elsewhere. It is
            // NOT a guarantee that a phone alert "sticks until acknowledged".
            requireInteraction: isAction,
            // SOUND: deliberately NOT setting `silent`. Left unset, the OS plays its default
            // notification sound (Android channel sound / iOS system sound), subject to the user's
            // own per-app + Focus/DND/ringer settings, which the web cannot override. There is no
            // custom-sound option on web push. `vibrate` is intentionally omitted: it is a no-op on
            // Android O+ (vibration is channel-governed) and on iOS.
            //
            // DECISION BUTTONS (Android + desktop; iOS ignores them). Declared per type in the
            // client registry and mirrored server-side — see PUSH_ACTIONS_BY_TYPE. A button only
            // ever hands an INTENT back to the app (notificationclick below); it never decides
            // anything here, because this worker has no auth, no Firestore and none of the in-app
            // card's guards.
            actions: parseActions(data.actions),
            // notifId + type travel onto the click so the app knows WHICH notification a button
            // belongs to and can refuse an action that doesn't match the type.
            data: { link: data.link || '/', notifId: data.notifId || '', type: data.type || '' }
        });
    });
} catch (err) {
    // If the FCM SDK fails to load (offline cold start, CDN blocked), don't let SW install throw
    // — log and continue; the notificationclick handler below stays functional.
    // eslint-disable-next-line no-console
    console.error('[fcm-sw] init failed:', err);
}

// Focus (or open) the app when a background notification is clicked — honoring the per-message deep
// link, and carrying the pressed decision button (event.action) back to the app as an INTENT.
//
// The app, not this worker, executes the decision: it runs the very handler the in-app card's button
// runs, so every guard (the "another manager already decided" re-read, the deleted-task self-heal,
// the undo window, the Lithuanian error banner) applies identically whether the tap landed on the
// lockscreen or in the bell. See ADR 0024.
//
// HOW the intent travels depends on whether the app is already running:
//   • a live window  → postMessage. This worker is registered at its OWN scope
//     (/firebase-cloud-messaging-push-scope) and therefore does NOT control the page at "/", so
//     WindowClient.navigate() rejects with a TypeError — the deep link never actually moved an
//     open app to the right tab, it only ever fell through to focus(). postMessage does move it,
//     and hands over the action without a reload.
//   • no window at all → cold-start via openWindow with the intent in the query string, which the
//     app reads once on boot (src/notifications/pushIntent.js) and then strips from the URL.
// If the message never lands (an old bundle, the login screen), the tap degrades to "the app comes
// to the front" — exactly today's behaviour. It fails safe: nothing is written on a lost intent.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const d = event.notification.data || {};
    const link = d.link || '/';
    const action = event.action || ''; // '' = the notification body itself was tapped

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
            const win = wins.find((c) => 'focus' in c);
            if (win) {
                try {
                    win.postMessage({
                        type: INTENT_MESSAGE,
                        action,
                        notifId: d.notifId || '',
                        notifType: d.type || '',
                        link
                    });
                } catch (err) {
                    // Best effort — focusing the app is still strictly better than doing nothing.
                }
                return win.focus();
            }
            const target = new URL(link, self.location.origin);
            if (action) {
                target.searchParams.set(PARAM_ACTION, action);
                if (d.notifId) target.searchParams.set(PARAM_NOTIF, d.notifId);
                if (d.type) target.searchParams.set(PARAM_TYPE, d.type);
            }
            if (clients.openWindow) return clients.openWindow(target.href);
            return undefined;
        })
    );
});
