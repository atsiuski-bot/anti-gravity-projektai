/**
 * WORKZ Cloud Functions (2nd gen).
 *
 * Two responsibilities, both reacting to Firestore writes:
 *   1. FCM PUSH — when a manager-facing notification doc is created, push to the
 *      recipient's registered devices so they are alerted even with the app/tab closed.
 *   2. STORAGE CLEANUP — when task attachments are removed (in-modal edit) or a task is
 *      truly deleted, delete the orphaned Storage objects the client cannot (the client
 *      can only delete its OWN uploads; the admin SDK here can delete any).
 *
 * Region pinned to europe-west1 (closest to the Vilnius user base). Requires the Blaze
 * plan (2nd-gen functions run on Cloud Run). Deploy: `firebase deploy --only functions`.
 */

const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getStorage } = require('firebase-admin/storage');

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

const db = getFirestore();

// ---------------------------------------------------------------------------
// FCM push
// ---------------------------------------------------------------------------

// Honor the recipient's per-user notification toggle (users/{uid}.notificationsEnabled). A
// missing field means notifications were never turned off (default on). This is the
// authoritative gate for background push: a device that registered its token BEFORE the user
// disabled would otherwise keep receiving push, since the client only skips re-registration.
async function notificationsEnabledFor(uid) {
    if (!uid) return false;
    try {
        const snap = await db.collection('users').doc(uid).get();
        return snap.exists ? snap.data().notificationsEnabled !== false : true;
    } catch (err) {
        // Fail open: a transient read error should not silently drop a recipient's alerts.
        logger.warn('notificationsEnabledFor failed', { uid, err: err.message });
        return true;
    }
}

// Per-user device tokens live at fcm_tokens/{uid} = { tokens: string[], updatedAt }.
async function getTokensFor(uid) {
    if (!uid) return [];
    const snap = await db.collection('fcm_tokens').doc(uid).get();
    if (!snap.exists) return [];
    const tokens = snap.data().tokens;
    return Array.isArray(tokens) ? tokens.filter(Boolean) : [];
}

// Drop tokens FCM reported as dead so the list does not grow unbounded.
async function pruneTokens(uid, badTokens) {
    if (!uid || !badTokens.length) return;
    const ref = db.collection('fcm_tokens').doc(uid);
    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) return;
            const tokens = (snap.data().tokens || []).filter((t) => !badTokens.includes(t));
            tx.update(ref, { tokens });
        });
    } catch (err) {
        logger.warn('pruneTokens failed', { uid, err: err.message });
    }
}

async function sendToUser(uid, notification, data) {
    if (!(await notificationsEnabledFor(uid))) return; // recipient turned notifications off
    const tokens = await getTokensFor(uid);
    if (!tokens.length) return;

    // DATA-ONLY payload (title/body live in `data`, not a `notification` block). On web a
    // `notification` message is auto-displayed by the browser AND still wakes the SW, which
    // double-fires. Data-only gives the SW (background) and onMessage (foreground) one
    // deterministic place each to render, with no duplicate. All values must be strings.
    const resp = await getMessaging().sendEachForMulticast({
        tokens,
        data: {
            title: String(notification.title || 'WORKZ'),
            body: String(notification.body || ''),
            ...(data || {})
        },
        webpush: {
            fcmOptions: { link: '/' }
        }
    });

    const bad = [];
    resp.responses.forEach((r, i) => {
        if (r.success) return;
        const code = (r.error && r.error.code) || '';
        if (
            code.includes('registration-token-not-registered') ||
            code.includes('invalid-registration-token') ||
            code.includes('invalid-argument')
        ) {
            bad.push(tokens[i]);
        }
    });
    if (bad.length) await pruneTokens(uid, bad);
}

// Friendly Lithuanian copy per request_notification type (UI strings are Lithuanian).
function copyForRequestNotification(n) {
    const title = n.taskTitle || 'WORKZ';
    switch (n.type) {
        case 'time_extension_request':
            return { title: 'Laiko pratęsimo prašymas', body: title };
        case 'task_completion':
            return { title: 'Užduotis atlikta', body: title };
        case 'task_approval':
            return { title: 'Nauja užduotis tvirtinimui', body: title };
        case 'new_comment':
            return { title: 'Naujas komentaras', body: n.commentText ? `${title}: ${n.commentText}` : title };
        default:
            return { title: 'WORKZ pranešimas', body: title };
    }
}

exports.notifyOnRequestNotification = onDocumentCreated('request_notifications/{id}', async (event) => {
    const n = event.data && event.data.data();
    if (!n || !n.recipientId) return;
    const { title, body } = copyForRequestNotification(n);
    try {
        await sendToUser(n.recipientId, { title, body }, {
            type: String(n.type || ''),
            taskId: String(n.taskId || '')
        });
    } catch (err) {
        logger.error('notifyOnRequestNotification failed', { err: err.message });
    }
});

exports.notifyOnCalendarRequest = onDocumentCreated('calendar_requests/{id}', async (event) => {
    const r = event.data && event.data.data();
    if (!r || !r.managerId || r.status !== 'pending') return;
    const who = r.userName || 'Darbuotojas';
    try {
        await sendToUser(r.managerId, { title: 'Kalendoriaus keitimo prašymas', body: who }, {
            type: 'calendar_request'
        });
    } catch (err) {
        logger.error('notifyOnCalendarRequest failed', { err: err.message });
    }
});

// ---------------------------------------------------------------------------
// Storage attachment cleanup
// ---------------------------------------------------------------------------

// Firebase download URL → object path: .../o/<URL-ENCODED-PATH>?alt=media&token=...
function pathFromDownloadUrl(url) {
    try {
        const u = new URL(url);
        const m = u.pathname.match(/\/o\/(.+)$/);
        if (!m) return null;
        return decodeURIComponent(m[1]);
    } catch (err) {
        return null;
    }
}

async function deleteObjects(urls) {
    if (!urls || !urls.length) return;
    const bucket = getStorage().bucket();
    await Promise.all(urls.map(async (url) => {
        const path = pathFromDownloadUrl(url);
        if (!path) return; // not a Firebase Storage URL (legacy/external) — leave it
        try {
            await bucket.file(path).delete();
        } catch (err) {
            // 404 = already gone; anything else is logged but never throws (best effort).
            if (err && err.code !== 404) logger.warn('deleteObject failed', { path, err: err.message });
        }
    }));
}

function urlsOf(task) {
    if (!task) return [];
    const arr = Array.isArray(task.attachmentUrls) ? task.attachmentUrls : [];
    if (arr.length) return arr;
    return task.attachmentUrl ? [task.attachmentUrl] : [];
}

// In-modal attachment removal: delete objects that disappeared from the list.
exports.cleanupAttachmentsOnTaskUpdate = onDocumentUpdated('tasks/{id}', async (event) => {
    const before = urlsOf(event.data && event.data.before && event.data.before.data());
    const after = urlsOf(event.data && event.data.after && event.data.after.data());
    const removed = before.filter((u) => !after.includes(u));
    if (removed.length) await deleteObjects(removed);
});

// True task deletion: delete attachments — UNLESS the task was merely ARCHIVED (a copy now
// exists in archived_tasks under the same id, so the files are still referenced).
exports.cleanupAttachmentsOnTaskDelete = onDocumentDeleted('tasks/{id}', async (event) => {
    const sibling = await db.collection('archived_tasks').doc(event.params.id).get();
    if (sibling.exists) return;
    await deleteObjects(urlsOf(event.data && event.data.data()));
});

// Symmetric guard for the archived copy (skip if a live task copy still references the files).
exports.cleanupAttachmentsOnArchivedDelete = onDocumentDeleted('archived_tasks/{id}', async (event) => {
    const sibling = await db.collection('tasks').doc(event.params.id).get();
    if (sibling.exists) return;
    await deleteObjects(urlsOf(event.data && event.data.data()));
});
