/* WORKZ Firebase Cloud Messaging service worker.
 *
 * Registered by the FCM SDK at its own scope (/firebase-cloud-messaging-push-scope), so it
 * coexists with the vite-plugin-pwa Workbox SW at "/". The config below is the PUBLIC client
 * config (same values already shipped in the app bundle) — no secrets.
 *
 * The server sends DATA-ONLY messages, so onBackgroundMessage is the single place that renders
 * a background notification (no browser auto-display, no duplicate).
 */
/* eslint-disable no-undef */
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

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
        tag: data.taskId || 'workz-notification',
        data: { link: '/' }
    });
});

// Focus (or open) the app when a background notification is clicked.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
            for (const client of wins) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow('/');
            return undefined;
        })
    );
});
