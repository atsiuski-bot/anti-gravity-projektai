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
        const title = data.title || 'WORKZ';
        self.registration.showNotification(title, {
            body: data.body || '',
            icon: '/pwa-192x192.png',
            badge: '/pwa-192x192.png',
            // Per-EVENT tag (the source doc id) so two distinct alerts never silently collapse
            // onto one slot; renotify re-alerts when a tag is reused. Fall back to taskId, then
            // a constant.
            tag: data.notifId || data.taskId || 'workz-notification',
            renotify: true,
            data: { link: data.link || '/' }
        });
    });
} catch (err) {
    // If the FCM SDK fails to load (offline cold start, CDN blocked), don't let SW install throw
    // — log and continue; the notificationclick handler below stays functional.
    // eslint-disable-next-line no-console
    console.error('[fcm-sw] init failed:', err);
}

// Focus (or open) the app when a background notification is clicked, honoring a per-message link.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const link = (event.notification.data && event.notification.data.link) || '/';
    const target = new URL(link, self.location.origin).href;
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
            // Already on the target — just focus it (no reload).
            for (const client of wins) {
                if (client.url === target && 'focus' in client) return client.focus();
            }
            // Otherwise navigate the first available window to the target, then focus.
            for (const client of wins) {
                if ('focus' in client) {
                    if ('navigate' in client) {
                        return client.navigate(target).then((c) => (c || client).focus()).catch(() => client.focus());
                    }
                    return client.focus();
                }
            }
            // No window open — open a new one at the target.
            if (clients.openWindow) return clients.openWindow(target);
            return undefined;
        })
    );
});
