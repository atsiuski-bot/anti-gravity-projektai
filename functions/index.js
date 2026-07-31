/**
 * WORKZ Cloud Functions (2nd gen).
 *
 * Three responsibilities, all reacting to Firestore writes:
 *   1. FCM PUSH — when a manager-facing notification doc is created, push to the
 *      recipient's registered devices so they are alerted even with the app/tab closed.
 *   2. STORAGE CLEANUP — when task attachments are removed (in-modal edit) or a task is
 *      truly deleted, delete the orphaned Storage objects the client cannot (the client
 *      can only delete its OWN uploads; the admin SDK here can delete any).
 *   3. ACHIEVEMENT BADGES — award server-only recognition tiers (a worker can write its own
 *      user doc, so badges must be granted here, not client-side) and push the "new badge"
 *      alert. Counts are kept O(1) in a per-user _stats doc; tiers only ever move upward.
 *
 * Region pinned to europe-west1 (closest to the Vilnius user base). Requires the Blaze
 * plan (2nd-gen functions run on Cloud Run). Deploy: `firebase deploy --only functions`.
 */

const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getStorage } = require('firebase-admin/storage');
const { appendSystemDecision } = require('./decisionLog');
const { collectReferentialTaskIds, findOrphanSessions, classifySuspiciousWorkDays, findImpossibleSpanSessions, classifyEngineAdoption, isReferentialTaskSession, isCorrectedSession, findCounterDrift, claimedTaskRun, classifySessionDisagreements } = require('./integrityScans');
const { lithuanianDay, currentWorkDay, taskArchivable } = require('./workDay');

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
    // double-fires. Data-only gives the SW (firebase-messaging-sw.js) one deterministic place to
    // render the BACKGROUND case. The FOREGROUND (tab-open) case is covered separately by the
    // app's Firestore listeners (an in-app toast — see ADR 0004), not an FCM onMessage handler.
    // All values must be strings.
    const resp = await getMessaging().sendEachForMulticast({
        tokens,
        data: {
            title: String(notification.title || 'Gildija'),
            body: String(notification.body || ''),
            ...(data || {})
        },
        webpush: {
            // Delivery hints handed to the browser's push service (RFC 8030). These affect when/
            // whether the push is DELIVERED and wakes the device — NOT how the notification looks.
            headers: {
                // 'high' so a backgrounded / low-battery phone still wakes promptly for a
                // time-sensitive task/approval alert; omitting it defaults to 'normal'. Must be one
                // of very-low|low|normal|high — we only ever send this single literal. NB: this is a
                // prioritisation hint to the web push service, not an Android-native Doze guarantee.
                Urgency: 'high',
                // Keep an undelivered alert for 24h (seconds, as a string) so it still arrives when
                // an offline worker reconnects, rather than being dropped on the floor.
                TTL: '86400'
            },
            fcmOptions: {
                // Honor the per-message deep link (the SW notificationclick reads data.link too).
                link: (data && data.link) || '/',
                // Group deliveries by notification type in the FCM / BigQuery reports (observability
                // only, no delivery effect). The registry type ids are already label-charset safe.
                analyticsLabel: String((data && data.type) || 'workz_notification')
            }
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

// Friendly Lithuanian copy per request_notification type (UI strings are Lithuanian). This feed is
// two-way, so it covers both the worker→manager requests and the manager→worker decision notices.
//
// MIRROR of src/notifications/registry.js (the client's single source of truth). The client cannot be
// imported across the deploy boundary, so this is hand-copied — and src/__tests__/firebaseConsistency.test.js
// evaluates this function and fails the gate if its title/body output drifts from the registry. Change
// a string here? Change it in the registry too (and vice versa).
// MIRROR of the registry's per-type `category` ('action' = a decision is owed → floats to the top of
// the bell and gets requireInteraction on a desktop push; 'info' = FYI). The service worker has no
// access to the client registry, so the category travels in the push DATA payload; this map is the
// server side of that mirror. src/__tests__/firebaseConsistency.test.js locks it against
// notificationCategory() in the registry, exactly like the copy lockstep below. Kept OUTSIDE the
// copyForRequestNotification slice the copy-lockstep test extracts, so it never disturbs that test.
const CATEGORY_BY_TYPE = {
    task_approval: 'action',
    task_completion: 'action',
    time_extension_request: 'action',
    session_correction_request: 'action',
    task_needs_manager: 'action',
    task_waiting: 'info',
    task_reverted: 'action',
    account_approval: 'action',
    recurring_reassign: 'action',
    new_comment: 'info',
    new_photo: 'info',
    task_assigned: 'info',
    task_approved: 'info',
    task_edited: 'info',
    task_unassigned: 'info',
    task_deleted: 'info',
    task_confirmed: 'info',
    extension_granted: 'info',
    extension_denied: 'info',
    calendar_decision: 'info',
    session_edited: 'info',
    session_deleted: 'info',
    session_auto_closed: 'info',
    session_force_ended: 'info',
    timer_running_check: 'info',
    task_over_estimate: 'info',
    backdated_time_logged: 'info',
    time_self_reduced: 'info',
    task_priority_escalated: 'info',
    achievement: 'info',
    task_overdue: 'info',
};

// MIRROR of the registry's per-type `actions` — the OS-level decision buttons drawn on a BACKGROUND
// push (ADR 0024). Same reasoning as CATEGORY_BY_TYPE: the service worker cannot import the client
// registry, so the buttons travel in the push DATA payload and this map is the server side of that
// mirror. src/__tests__/firebaseConsistency.test.js locks it against notificationActions() — key set,
// order, ids and Lithuanian titles — so a button can never be renamed on one side only.
//
// A button carries NO authority: tapping it opens the app with the intent, and the app runs the same
// guarded handler the in-app card's button runs. Nothing here writes. Types absent from this map get
// a plain tap-to-open push, exactly as before. Kept OUTSIDE the copyForRequestNotification slice the
// copy-lockstep test extracts, so it never disturbs that test.
const PUSH_ACTIONS_BY_TYPE = {
    task_approval: [{ action: 'approve', title: 'Patvirtinti' }, { action: 'open', title: 'Atidaryti' }],
    task_completion: [{ action: 'confirm', title: 'Priimti' }, { action: 'open', title: 'Atidaryti' }],
    time_extension_request: [{ action: 'extend30', title: 'Pratęsti +30 min' }, { action: 'open', title: 'Atidaryti' }],
};

function copyForRequestNotification(n) {
    const title = n.taskTitle || 'Gildija';
    switch (n.type) {
        // Worker → manager
        case 'time_extension_request':
            return { title: 'Laiko pratęsimo prašymas', body: title };
        case 'task_completion':
            return { title: 'Užduotis atlikta', body: title };
        case 'task_approval':
            return { title: 'Nauja užduotis tvirtinimui', body: title };
        case 'task_needs_manager':
            // Worker → manager: the vykdytojas raised the "Reikia vadovo" flag on a task.
            return { title: 'Reikia koordinatoriaus', body: title };
        case 'task_waiting':
            // Worker → manager: the vykdytojas raised the "Laukiama" flag on a task.
            return { title: 'Pažymėta „Laukiama“', body: title };
        case 'new_comment': {
            // User-authored text crosses the app boundary onto the lockscreen — collapse
            // whitespace and clamp length so it can't be weaponised into a huge/multiline body.
            const snippet = n.commentText
                ? String(n.commentText).replace(/\s+/g, ' ').trim().slice(0, 100)
                : '';
            return { title: 'Naujas komentaras', body: snippet ? `${title}: ${snippet}` : title };
        }
        case 'new_photo':
            // Fired to the other party when a photo is added from the task sheet (uploader dropped client-side).
            return { title: 'Nauja nuotrauka', body: title };
        // Manager → worker
        case 'task_assigned':
            return { title: 'Nauja užduotis', body: title };
        case 'recurring_reassign':
            // System → manager: the recurring job's usual assignee is away; pick someone else.
            return { title: 'Priskirkite kitą meistrą', body: title };
        case 'account_approval':
            // System → admin: a new sign-up awaits approval. Body = the pending user's name/email.
            return { title: 'Naujas vartotojas laukia patvirtinimo', body: n.targetUserName || n.targetUserEmail || 'Gildija' };
        case 'task_approved':
            // `edited` collapses approve+edit into one notice (mirror of the registry variant).
            return { title: n.edited ? 'Užduotis patvirtinta ir pakeista' : 'Užduotis patvirtinta', body: title };
        case 'task_edited':
            return { title: 'Užduotis pakeista', body: title };
        case 'task_unassigned':
            return { title: 'Užduotis nebepriskirta jums', body: title };
        case 'task_deleted':
            return { title: 'Užduotis ištrinta', body: title };
        case 'task_confirmed':
            // COMPLETION-gate vocabulary is "priimta" (kept in lockstep with the toast + Reports tab).
            return { title: 'Užduotis užbaigta ir priimta', body: title };
        case 'task_reverted':
            // `edited` collapses return+edit into one notice (mirror of the registry variant).
            return { title: n.edited ? 'Užduotis grąžinta taisyti ir pakeista' : 'Užduotis grąžinta taisyti', body: title };
        case 'extension_granted':
            return { title: 'Laikas pratęstas', body: title };
        case 'extension_denied':
            return { title: 'Laikas nepratęstas', body: title };
        case 'calendar_decision':
            return {
                title: n.decision === 'approved' ? 'Kalendoriaus pakeitimas patvirtintas' : 'Kalendoriaus pakeitimas atmestas',
                body: 'Veiklos kalendorius',
            };
        case 'session_edited':
            return { title: 'Pakoreguotas veiklos laikas', body: n.day || 'Veiklos laikas' };
        case 'session_deleted':
            return { title: 'Pašalintas veiklos laikas', body: n.day || 'Veiklos laikas' };
        case 'session_auto_closed':
            // System → worker: a forgotten secondary-session timer was auto-closed + time credited.
            return { title: 'Automatiškai uždaryta sesija', body: n.day || 'Veiklos laikas' };
        case 'session_force_ended': {
            // Manager → worker: a coordinator settled a session the worker had left running, which
            // also drops anything parked underneath it. parkedSummary names what to restart; it may
            // embed a user-authored task title, so clamp identically to the registry MIRROR.
            const parked = n.parkedSummary
                ? String(n.parkedSummary).replace(/\s+/g, ' ').trim().slice(0, 100)
                : '';
            return {
                title: 'Koordinatorius užbaigė sesiją',
                body: parked || n.day || 'Veiklos laikas',
            };
        }
        case 'timer_running_check':
            // System → worker: a running task timer went heartbeat-stale — a gentle "still on it?" check.
            return { title: 'Ar laikmatis vis dar veikia?', body: title };
        case 'task_over_estimate':
            // System → worker: the running timer passed the task's planned time while the app was
            // asleep, so the client's own 100% stop + "pratęsti ar užbaigti" popup could not fire.
            return { title: 'Viršytas planuotas laikas', body: title };
        case 'backdated_time_logged': {
            // Trusted worker → admin: an approval-free backdated session was logged. Body = WHO + day.
            // userName is the only free-form field; clamp identically to the registry MIRROR.
            const name = n.userName ? String(n.userName).replace(/\s+/g, ' ').trim().slice(0, 100) : '';
            const day = n.day || 'Veiklos laikas';
            return { title: 'Įrašytas atbulinis laikas', body: name ? `${name} · ${day}` : day };
        }
        case 'time_self_reduced': {
            // Worker → admin: an approval-free REDUCTION of their own credited time (a timer left
            // running). Body = WHO + day; same clamp as the registry MIRROR.
            const name = n.userName ? String(n.userName).replace(/\s+/g, ' ').trim().slice(0, 100) : '';
            const day = n.day || 'Veiklos laikas';
            return { title: 'Meistras sumažino savo laiką', body: name ? `${name} · ${day}` : day };
        }
        case 'session_correction_request':
            // Worker → manager: a logged-time error report. Body = "day: note" (note clamped) or day.
            return {
                title: 'Pranešimas apie veiklos laiko klaidą',
                body: n.commentText
                    ? `${n.day || 'Veiklos laikas'}: ${String(n.commentText).replace(/\s+/g, ' ').trim().slice(0, 100)}`
                    : (n.day || 'Veiklos laikas'),
            };
        case 'task_priority_escalated':
            // System → worker: a task's deadline closed in, so its priority was auto-raised. The new
            // level's Lithuanian label is precomputed onto the doc (priorityLabel), so this MIRROR
            // needs no priority map — keep identical to the registry entry.
            return {
                title: 'Artėja terminas',
                body: n.priorityLabel ? `${n.taskTitle || 'Veikla'} → ${n.priorityLabel}` : (n.taskTitle || 'Gildija'),
            };
        case 'achievement':
            // System → worker: a newly-earned badge tier. Body = "Badge: Tier" (mirror of the registry).
            return { title: 'Naujas ženkliukas', body: n.badgeName ? (n.tierName ? `${n.badgeName}: ${n.tierName}` : n.badgeName) : 'Gildija' };
        case 'task_overdue':
            // System → manager: a task's deadline passed while still unfinished.
            return { title: 'Praleistas terminas', body: title };
        default:
            return { title: 'Gildijos pranešimas', body: title };
    }
}

exports.notifyOnRequestNotification = onDocumentCreated('request_notifications/{id}', async (event) => {
    const n = event.data && event.data.data();
    if (!n || !n.recipientId) return;
    const { title, body } = copyForRequestNotification(n);
    // Deep-link MIRROR of the registry: calendar decisions → the calendar, a badge → the profile,
    // everything else → tasks.
    const link = n.type === 'calendar_decision' ? '/?tab=calendar'
        : n.type === 'achievement' ? '/?tab=profile'
        : '/?tab=tasks';
    // OS-level decision buttons for this type, if it has any. FCM data values must be strings, so
    // they ride as JSON; the key is omitted entirely for the (majority) tap-only types, keeping the
    // common payload small — the whole data map shares one 4KB budget.
    const pushActions = PUSH_ACTIONS_BY_TYPE[n.type];
    try {
        await sendToUser(n.recipientId, { title, body }, {
            type: String(n.type || ''),
            taskId: String(n.taskId || ''),
            // Category rides along so the SW can render an 'action' push as requireInteraction
            // (desktop) without importing the client registry. MIRROR — see CATEGORY_BY_TYPE.
            category: CATEGORY_BY_TYPE[n.type] || 'info',
            // Per-event id → unique notification tag (so distinct alerts don't collapse).
            notifId: String(event.params.id),
            ...(pushActions ? { actions: JSON.stringify(pushActions) } : {}),
            link
        });
    } catch (err) {
        logger.error('notifyOnRequestNotification failed', { err: err.message });
    }
});

exports.notifyOnCalendarRequest = onDocumentCreated('calendar_requests/{id}', async (event) => {
    const r = event.data && event.data.data();
    if (!r || r.status !== 'pending') return;
    // Fan out to ALL of the worker's managers (any may approve). Fall back to the single managerId
    // for legacy docs written before the managerIds array existed.
    const recipients = Array.isArray(r.managerIds) && r.managerIds.length
        ? r.managerIds
        : (r.managerId ? [r.managerId] : []);
    if (!recipients.length) return;
    const who = r.userName || 'Meistras';
    try {
        await Promise.all(recipients.map((uid) =>
            sendToUser(uid, { title: 'Kalendoriaus keitimo prašymas', body: who }, {
                type: 'calendar_request',
                // A pending approval is a decision owed → 'action' (sticky on a desktop push).
                category: 'action',
                // Per-event id → unique tag, so multiple pending requests don't collapse onto one slot.
                notifId: String(event.params.id),
                link: '/?tab=team-calendar'
            })
        ));
    } catch (err) {
        logger.error('notifyOnCalendarRequest failed', { err: err.message });
    }
});

// ---------------------------------------------------------------------------
// Storage attachment cleanup
// ---------------------------------------------------------------------------

// Firebase download URL → { bucket, path }. Format:
//   https://firebasestorage.googleapis.com/v0/b/<BUCKET>/o/<URL-ENCODED-PATH>?alt=media&token=...
// We capture the BUCKET too (not just the path) so cleanup can reject an object that does not
// live in this project's own default bucket (see deleteObjects — audit R-02).
function parseStorageUrl(url) {
    try {
        const u = new URL(url);
        const m = u.pathname.match(/\/b\/([^/]+)\/o\/(.+)$/);
        if (!m) return null;
        return { bucket: decodeURIComponent(m[1]), path: decodeURIComponent(m[2]) };
    } catch (err) {
        return null;
    }
}

// The uid embedded in a task-attachment object key: `attachments/<uid>/<file>` — attachmentUpload.js
// and TaskModal always upload under the UPLOADER's own uid (storage.rules enforce that). Returns
// null for any other shape (legacy flat `attachments/<file>`, avatars, etc.), which cleanup then
// refuses to touch.
function attachmentOwnerUid(path) {
    const m = /^attachments\/([^/]+)\/[^/]+/.exec(path);
    return m ? m[1] : null;
}

// Delete Storage objects referenced by a task — but NEVER trust the client-controlled attachment
// URL as authorization to delete (audit R-02). attachmentUrls is a plain array on a client-writable
// task, so a crafted entry could point at ANOTHER user's `attachments/<victim>/…` object and turn
// this Admin-SDK cleanup (which bypasses Storage rules) into arbitrary cross-user data loss. Two
// guards make a delete safe:
//   1. the object must live in THIS project's default bucket (a foreign host/bucket is ignored), and
//   2. its `attachments/<uid>/…` owner prefix must equal a uid we can PROVE is tied to the task.
//      Only `assignedUserId` qualifies: the rules pin it (a worker cannot self-assign to a colleague
//      and, post-R-06, cannot re-point it), whereas createdBy/managerId are client-writable and could
//      be forged to smuggle a victim uid into the allow-set. A manager-uploaded file (under the
//      manager's own uid) therefore is NOT auto-deleted — it is left as a harmless orphan rather than
//      risk the confused-deputy delete.
async function deleteObjects(urls, allowedOwners) {
    if (!urls || !urls.length || !allowedOwners || !allowedOwners.size) return;
    const bucket = getStorage().bucket();
    await Promise.all(urls.map(async (url) => {
        const parsed = parseStorageUrl(url);
        if (!parsed) return;                                          // not a Storage URL (legacy/external)
        if (parsed.bucket && parsed.bucket !== bucket.name) return;   // foreign bucket — never touch
        const owner = attachmentOwnerUid(parsed.path);
        if (!owner || !allowedOwners.has(owner)) return;              // not provably this task's file
        try {
            await bucket.file(parsed.path).delete();
        } catch (err) {
            // 404 = already gone; anything else is logged but never throws (best effort).
            if (err && err.code !== 404) logger.warn('deleteObject failed', { path: parsed.path, err: err.message });
        }
    }));
}

// The rule-guaranteed uid that may own this task's attachment objects (see deleteObjects guard #2).
function taskAttachmentOwners(task) {
    return new Set(task && task.assignedUserId ? [task.assignedUserId] : []);
}

// Every storage object this task owns, across BOTH attachment fields.
//
// Work-end proof photos are uploaded through the same uploadAttachments helper (so they carry the
// same `attachments/<uid>/` key shape the owner guard parses) but are stored under a SEPARATE
// `completionPhotoUrls` field. Reading only attachmentUrls therefore computed an empty set for
// them, and all three cleanup triggers silently kept every completion photo forever — including
// after a hard delete, which removes the task from both collections so no client can ever reach
// the files again. Those are the most sensitive attachments in the app (client premises, people),
// so the deletion has to be honoured for them too.
function urlsOf(task) {
    if (!task) return [];
    const attachments = Array.isArray(task.attachmentUrls) && task.attachmentUrls.length
        ? task.attachmentUrls
        : (task.attachmentUrl ? [task.attachmentUrl] : []);
    const completion = Array.isArray(task.completionPhotoUrls) ? task.completionPhotoUrls : [];
    // De-duplicated: a url present in both fields must not be handed to deleteObjects twice.
    return [...new Set([...attachments, ...completion])];
}

// In-modal attachment removal: delete objects that disappeared from the list (only those the task's
// own assignee uploaded — deleteObjects enforces the owner guard).
exports.cleanupAttachmentsOnTaskUpdate = onDocumentUpdated('tasks/{id}', async (event) => {
    const beforeTask = event.data && event.data.before && event.data.before.data();
    const afterTask = event.data && event.data.after && event.data.after.data();
    const removed = urlsOf(beforeTask).filter((u) => !urlsOf(afterTask).includes(u));
    if (removed.length) await deleteObjects(removed, taskAttachmentOwners(afterTask || beforeTask));
});

// True task deletion: delete attachments — UNLESS the task was merely ARCHIVED (a copy now
// exists in archived_tasks under the same id, so the files are still referenced).
exports.cleanupAttachmentsOnTaskDelete = onDocumentDeleted('tasks/{id}', async (event) => {
    const sibling = await db.collection('archived_tasks').doc(event.params.id).get();
    if (sibling.exists) return;
    const deleted = event.data && event.data.data();
    await deleteObjects(urlsOf(deleted), taskAttachmentOwners(deleted));
});

// Symmetric guard for the archived copy (skip if a live task copy still references the files).
exports.cleanupAttachmentsOnArchivedDelete = onDocumentDeleted('archived_tasks/{id}', async (event) => {
    const sibling = await db.collection('tasks').doc(event.params.id).get();
    if (sibling.exists) return;
    const deleted = event.data && event.data.data();
    await deleteObjects(urlsOf(deleted), taskAttachmentOwners(deleted));
});

// ---------------------------------------------------------------------------
// Achievement badges (recognition system — Fazė 3 engine)
// ---------------------------------------------------------------------------
//
// SERVER-AWARDED only: a worker can write its own /users/{uid} doc, so earned tiers live in
// users/{uid}/achievements/{key} (rules: read team-wide, write:false — the admin SDK here
// bypasses rules). Running counts are kept O(1) in a sibling users/{uid}/achievements/_stats
// doc and advanced inside a transaction, so a badge can't be self-forged and a re-fired event
// can't double-grant a tier.
//
// Guardrails: only POSITIVE accomplishment is counted (there is no abandonment/rework badge);
// an earned tier is PERMANENT (grantTier moves only upward); R2's "streak" is cumulative and
// forgiving (a missed day never demotes). The public label is the metal name; the thresholds
// are the internal, tunable counts.

const TIER_NAMES = { 1: 'Bronza', 2: 'Sidabras', 3: 'Auksas', 4: 'Platina' };

// DECISION 2026-06-26: thresholds recalibrated against ~7 months of real production data (2670
// tasks, 5255 sessions, ~10 active people). The old tiers were hit by a committed worker in weeks,
// so the upper tiers carried no aspiration. The new ladders are scaled to a committed worker's
// accrual rate so that, per the founder's "most people stay 2-5 years" framing: bronze = first
// days, silver = first months, GOLD ≈ 1.5-2 years of steady work, PLATINUM ≈ 4-5 years / top
// performer. follow_through is additionally scaled DOWN because it no longer counts auto quick-work
// (see onTaskFinishedBadge). thorough/documented kept modest — no usable historical baseline yet
// (checklists ~unused; the completion-photo field is days old) — revisit once adoption data exists.
const BADGES = {
    // Reliability
    follow_through: { name: 'Pabaigiu, ką pradedu', stat: 'completedTasks', thresholds: [5, 60, 600, 1500] }, // R1 (EXCLUDES quick-work)
    steady_rhythm: { name: 'Pastovus ritmas', stat: 'workDays', thresholds: [10, 60, 300, 750] },            // R2 (high-water days)
    on_estimate: { name: 'Telpa į planą', stat: 'onEstimate', thresholds: [10, 80, 450, 1100] },             // R3
    plans_ahead: { name: 'Planuoja iš anksto', stat: 'planAheadWeeks', thresholds: [3, 15, 60, 150] },       // R4 (high-water weeks, ~52/yr ceiling)
    on_time_start: { name: 'Pradeda laiku', stat: 'punctualDays', thresholds: [10, 60, 280, 650] },     // R6 (planned vs actual start)
    // Quality
    approved_craft: { name: 'Priimta veikla', stat: 'confirmedTasks', thresholds: [5, 75, 600, 1800] },     // Q1
    thorough: { name: 'Kruopštus', stat: 'thorough', thresholds: [2, 10, 40, 120] },                         // Q2 (no baseline — checklists ~unused)
    hard_tasks: { name: 'Imasi sunkių', stat: 'hardTasks', thresholds: [5, 60, 300, 800] },                  // Q4
    // Accountability
    documented: { name: 'Dokumentuoja darbą', stat: 'documentedTasks', thresholds: [3, 25, 120, 350] }      // A1 (no baseline — feature is days old)
};

function tierForCount(count, thresholds) {
    let tier = 0;
    for (let i = 0; i < thresholds.length; i += 1) {
        if (count >= thresholds[i]) tier = i + 1;
    }
    return tier;
}

function statsRef(uid) {
    return db.collection('users').doc(uid).collection('achievements').doc('_stats');
}

// Award upward only — a tier, once earned, is permanent (W2). Returns the newly-reached tier
// (1-4) if this call raised it, else 0. Idempotent: a re-fired event recomputes the same tier
// and the `tier <= prev` guard makes the write a no-op.
async function grantTier(uid, key, tier) {
    if (tier < 1) return 0;
    const badge = BADGES[key];
    const ref = db.collection('users').doc(uid).collection('achievements').doc(key);
    const nowIso = new Date().toISOString();
    const reached = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const prev = snap.exists ? (snap.data().tier || 0) : 0;
        if (tier <= prev) return 0;
        const history = (snap.exists && Array.isArray(snap.data().tierHistory))
            ? snap.data().tierHistory.slice()
            : [];
        history.push({ tier, at: nowIso });
        tx.set(ref, {
            key,
            name: badge.name,
            tier,
            tierName: TIER_NAMES[tier],
            earnedAt: nowIso,
            firstEarnedAt: snap.exists ? (snap.data().firstEarnedAt || nowIso) : nowIso,
            tierHistory: history
        }, { merge: true });
        return tier;
    });
    // Audit a genuine NEW tier under the SYSTEM actor (ADR 0015) — the badge engine deciding to
    // award recognition that changes a worker's public profile. Only fires when the tier actually
    // rose (reached > 0); the deterministic id (uid+badge+tier) dedups via create(), and a re-fired
    // event that re-grants the same tier returns 0 above → no duplicate audit. Best-effort.
    if (reached) {
        await appendSystemDecision(db, {
            idempotencyKey: `badge_${uid}_${key}_${reached}`,
            command: 'recognition.grantBadge',
            source: 'achievementEngine',
            targetType: 'user',
            targetId: uid,
            reason: `Awarded "${badge.name}" — ${TIER_NAMES[reached]} (tier ${reached})`,
            before: null,
            after: { badge: key, name: badge.name, tier: reached, tierName: TIER_NAMES[reached] },
        });
    }
    return reached;
}

// Announce a newly-reached tier through the UNIFIED notification spine: one request_notifications
// doc gives the worker a bell row AND the FCM push (notifyOnRequestNotification renders it from the
// registry mirror and deep-links to the profile). Routing it here — instead of the old direct
// sendToUser push — means a badge now PERSISTS in the bell like every other notification, not just
// a transient lockscreen ping. The FOREGROUND toast stays owned by AchievementCelebrator (a client
// listener on the achievements subcollection); NotificationsContext suppresses its own toast for
// type 'achievement' so the two don't double up. The deterministic-ish create is best-effort: a
// re-fired grant can't reach here (grantTier returns 0 on a re-grant), so no dedupe key is needed.
async function announceBadge(uid, key, tier) {
    const badge = BADGES[key];
    try {
        await db.collection('request_notifications').add({
            recipientId: uid,
            type: 'achievement',
            // An earned-badge alert is FYI, not a decision owed → 'info' (not sticky).
            category: 'info',
            badgeId: key,
            badgeName: badge.name,
            tierName: TIER_NAMES[tier],
            tier: Number(tier),
            isRead: false,
            createdAt: new Date().toISOString(),
            // Provenance: system-authored (admin SDK bypasses the client provenance rule).
            createdBy: 'system_achievement',
        });
    } catch (err) {
        logger.error('announceBadge failed', { uid, key, tier, err: err.message });
    }
}

// Simple counter badge: +1 to its stat field, then (re)grant the tier the new total reaches.
/**
 * Increment a badge's running count, then award any tier that count newly reaches.
 *
 * `dedupId` (the task id) makes the count PER-TASK instead of per-event. Without it, the manager's
 * "Grąžinti taisyti" cycle re-counted the same task on every re-finish: reopenTask writes
 * completed:false, so the next finish is another false→true edge and all four completion badges
 * bumped again — inverting the signal, since the badges that measure reliability grew FASTER for a
 * worker whose work kept bouncing back. The same double-count happened on any at-least-once
 * redelivery of the Firestore event, which 2nd-gen triggers do not deduplicate. grantTier's
 * `tier <= prev` guard cannot undo this: it only blocks a repeat award at the SAME tier, while an
 * inflated count pushes the worker over the NEXT threshold early, and an earned tier is permanent.
 *
 * The marker lives in a SEPARATE `achievement_marks` subcollection, not `achievements` — the client
 * subscribes to the whole of the latter (useAchievements) and would render a marker as a badge.
 * Read-before-write inside the transaction, so two concurrent events cannot both pass the check.
 */
async function bumpAndGrant(uid, key, dedupId) {
    const badge = BADGES[key];
    const ref = statsRef(uid);
    const markRef = dedupId
        ? db.collection('users').doc(uid).collection('achievement_marks').doc(`${key}_${dedupId}`)
        : null;
    const count = await db.runTransaction(async (tx) => {
        // All reads must precede all writes in a Firestore transaction.
        const mark = markRef ? await tx.get(markRef) : null;
        if (mark && mark.exists) return 0; // this task already counted toward this badge
        const snap = await tx.get(ref);
        const next = ((snap.exists && snap.data()[badge.stat]) || 0) + 1;
        tx.set(ref, { [badge.stat]: next }, { merge: true });
        if (markRef) tx.set(markRef, { at: new Date().toISOString() });
        return next;
    });
    if (count === 0) return; // deduped — no tier can have changed
    const reached = await grantTier(uid, key, tierForCount(count, badge.thresholds));
    if (reached) await announceBadge(uid, key, reached);
}

// High-water counter badge (distinct days/weeks): advance only when `value` is strictly later
// than the last one counted, so a repeat in the same bucket can't double-count and a missed
// bucket never demotes (forgiving — W3).
async function highWaterGrant(uid, statField, lastField, value, key) {
    const badge = BADGES[key];
    const ref = statsRef(uid);
    const count = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? snap.data() : {};
        if (data[lastField] && value <= data[lastField]) return data[statField] || 0;
        const next = (data[statField] || 0) + 1;
        tx.set(ref, { [statField]: next, [lastField]: value }, { merge: true });
        return next;
    });
    const reached = await grantTier(uid, key, tierForCount(count, badge.thresholds));
    if (reached) await announceBadge(uid, key, reached);
}

// A task has a real time estimate (a non-empty string with a non-zero digit).
function hasEstimate(task) {
    return !!task.estimatedTime && /[1-9]/.test(String(task.estimatedTime));
}

// Mirrors the client's getChecklistProgress().allDone: at least one item, and every one done.
function checklistAllDone(checklist) {
    return Array.isArray(checklist) && checklist.length > 0 && checklist.every((i) => i && i.done === true);
}

function isHighPriority(priority) {
    const p = String(priority || '').toUpperCase();
    return p === 'HIGH' || p === 'URGENT';
}

// Monday (UTC) of the week containing an ISO date — the de-dupe key for "distinct weeks planned".
function mondayKey(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
}

// Length of a (possibly absent) photo-url array on a task — tolerant of the legacy/undefined shape.
function photoCount(value) {
    return Array.isArray(value) ? value.length : 0;
}

// Task-finish badges. Three independent edges on a task update:
//   • completed false→true                 → R1 follow_through (NOT quick-work), R3 on_estimate, Q2 thorough, Q4 hard_tasks
//   • status →'confirmed'                   → Q1 approved_craft (a manager accepted the worker's work)
//   • completionPhotoUrls empty→non-empty   → A1 documented (the worker attached a work-end proof photo)
// The edges are independent (a manager finishing sets completed+confirmed at once; the proof photo
// lands in a SEPARATE later write from the post-finish prompt). The per-edge guards make each count
// exactly once even across separate complete-then-confirm-then-document steps.
exports.onTaskFinishedBadge = onDocumentUpdated('tasks/{id}', async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();
    if (!before || !after) return;
    const uid = after.assignedUserId;
    if (!uid) return;
    const taskId = event.params.id;

    const justCompleted = before.completed !== true && after.completed === true;
    const justConfirmed = before.status !== 'confirmed' && after.status === 'confirmed';
    // A1 counts the FIRST work-end photo on a completed task — the empty→non-empty edge, so adding
    // more photos later never re-counts. Gated on `completed` so it can only ever be a genuine
    // completion photo (the client prompt only writes this field after the finish).
    const justDocumented = photoCount(before.completionPhotoUrls) === 0 &&
                           photoCount(after.completionPhotoUrls) > 0 &&
                           after.completed === true;
    if (!justCompleted && !justConfirmed && !justDocumented) return;

    try {
        if (justCompleted) {
            // R1 deliberately EXCLUDES auto quick-work timers: they are casual one-tap logs, not
            // tasks the worker chose to see through, so they must not inflate "Pabaigiu, ką pradedu"
            // (DECISION 2026-06-26; the other completion badges are immune already — quick-work has
            // no estimate/checklist and is MEDIUM priority).
            // Every bump is keyed by the TASK id, so a return-and-refinish cycle counts once.
            if (after.isQuickWork !== true) await bumpAndGrant(uid, 'follow_through', taskId);
            if (hasEstimate(after) && after.timeLimitReached !== true) await bumpAndGrant(uid, 'on_estimate', taskId);
            if (checklistAllDone(after.checklist)) await bumpAndGrant(uid, 'thorough', taskId);
            if (isHighPriority(after.priority)) await bumpAndGrant(uid, 'hard_tasks', taskId);
        }
        // Q1 counts a MANAGER sign-off — not a worker (in a manager role) confirming their own task.
        if (justConfirmed && after.confirmedBy && after.confirmedBy !== uid) {
            await bumpAndGrant(uid, 'approved_craft', taskId);
        }
        if (justDocumented) {
            await bumpAndGrant(uid, 'documented', taskId);
        }
    } catch (err) {
        logger.error('onTaskFinishedBadge failed', { uid, err: err.message });
    }
});

// On-time grace: starting within this many minutes of (or before) the planned shift start still
// counts as punctual. Early arrival is never a violation. Tunable.
const GRACE_MINUTES = 10;

// Vilnius-local calendar day (YYYY-MM-DD), matching the client's getLithuanianDateString — so the
// planned shift and the actual first work bucket into the SAME day across the Vilnius offset.
// lithuanianDay now lives in ./workDay alongside the work-day boundary that is derived from it —
// they are one piece of timezone reasoning and drifted apart too easily as two.

// R6 — "Punktualus startas": did the worker begin REAL work near their planned shift start?
//   plannedStart = MIN(work_hours.start) for this user/day, excluding vacation entries.
//   actualStart  = this session's startTime — it is the day's FIRST real work, because the per-day
//                  gate (lastPunctualDate high-water) only lets the first session of a day through.
//   onTime       = (actualStart - plannedStart) <= GRACE_MINUTES (early counts as on-time).
// No planned shift that day => not counted (W1: only positive accomplishment). Breaks are
// irrelevant — they can't precede the first work. Each day is judged exactly once.
async function evaluatePunctuality(uid, session) {
    if (!session.startTime) return;
    const startDate = new Date(session.startTime);
    if (Number.isNaN(startDate.getTime())) return;
    const day = lithuanianDay(startDate);

    // Gate: judge a given day's punctuality exactly once (the day's first real session passes).
    const ref = statsRef(uid);
    const firstOfDay = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const last = snap.exists ? snap.data().lastPunctualDate : null;
        if (last && day <= last) return false;
        tx.set(ref, { lastPunctualDate: day }, { merge: true });
        return true;
    });
    if (!firstOfDay) return;

    // Earliest planned (non-vacation) shift start that buckets to this Vilnius day.
    //
    // Bounded to a ±1-day ISO window instead of the worker's ENTIRE work_hours history. This runs on
    // the first work session of every worker-day, so the unbounded form cost one whole-history read
    // per worker per day — a bill that grows linearly with how long the company has used the planner
    // (~15 workers × a year of planning ≈ 3.750 reads/day, doubling each year) to answer a question
    // about ONE day.
    //
    // The window is deliberately WIDER than the day: `start` is an ISO (UTC) string while `day` is a
    // Vilnius calendar day, so the two are offset by 2-3h. Over-fetching by a day on each side keeps
    // the authoritative `lithuanianDay(ws) !== day` test below completely unchanged — this is purely
    // a read-volume bound, never a semantic filter, so no DST or midnight edge case can slip.
    //
    // Falls back to the unbounded query if the composite index (userId + start) is not deployed yet:
    // an index deploy is a separate, human-run step, and badge evaluation must not break if the
    // functions land first. Once the index exists the bounded path takes over on its own.
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    let planned;
    try {
        planned = await db.collection('work_hours')
            .where('userId', '==', uid)
            .where('start', '>=', new Date(dayMs - 24 * 3600 * 1000).toISOString())
            .where('start', '<=', new Date(dayMs + 48 * 3600 * 1000).toISOString())
            .get();
    } catch (err) {
        logger.warn('evaluatePunctuality bounded work_hours query failed — falling back to full scan (deploy the userId+start index)', { uid, err: err.message });
        planned = await db.collection('work_hours').where('userId', '==', uid).get();
    }
    let plannedStartMs = null;
    planned.forEach((d) => {
        const wh = d.data();
        if (!wh || wh.isVacation === true || !wh.start) return;
        const ws = new Date(wh.start);
        if (Number.isNaN(ws.getTime()) || lithuanianDay(ws) !== day) return;
        if (plannedStartMs === null || ws.getTime() < plannedStartMs) plannedStartMs = ws.getTime();
    });
    if (plannedStartMs === null) return; // no planned shift that day → not a punctuality day

    const lateMinutes = (startDate.getTime() - plannedStartMs) / 60000;
    if (lateMinutes > GRACE_MINUTES) return; // late → not counted (no negative badge, W1)

    const count = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const next = ((snap.exists && snap.data().punctualDays) || 0) + 1;
        tx.set(ref, { punctualDays: next }, { merge: true });
        return next;
    });
    const reached = await grantTier(uid, 'on_time_start', tierForCount(count, BADGES.on_time_start.thresholds));
    if (reached) await announceBadge(uid, 'on_time_start', reached);
}

// R2 — "Pastovus ritmas": cumulative distinct work-DAYS. Quick-work/call sessions still count as
// a worked day; deletions and manual time corrections do not. R6 (punctuality) also evaluates here.
exports.onWorkSessionBadge = onDocumentCreated('work_sessions/{id}', async (event) => {
    const s = event.data && event.data.data();
    if (!s) return;
    if (s.isDeleted === true || s.isManualAdjustment === true) return;
    if (!(s.durationMinutes > 0)) return;
    const uid = s.userId || s.assignedUserId;
    const date = s.date; // Vilnius-local 'YYYY-MM-DD' (lexicographically comparable)
    if (!uid || !date) return;

    try {
        await highWaterGrant(uid, 'workDays', 'lastWorkDate', date, 'steady_rhythm');
        await evaluatePunctuality(uid, s); // R6 — on-time start (planned shift vs first real work)
    } catch (err) {
        logger.error('onWorkSessionBadge failed', { uid, err: err.message });
    }
});

// R4 — "Planuoja iš anksto": distinct WEEKS the worker planned during the proper planning window
// (calendar_requests stamped reason 'PlanningTime'). De-duped per planned week, so editing
// several shifts for the same week counts once.
exports.onCalendarPlanBadge = onDocumentCreated('calendar_requests/{id}', async (event) => {
    const r = event.data && event.data.data();
    if (!r || r.reason !== 'PlanningTime') return;
    const uid = r.userId;
    const startIso = (r.requestedEvent && r.requestedEvent.start) || r.createdAt;
    const week = startIso ? mondayKey(startIso) : null;
    if (!uid || !week) return;

    try {
        await highWaterGrant(uid, 'planAheadWeeks', 'lastPlanWeek', week, 'plans_ahead');
    } catch (err) {
        logger.error('onCalendarPlanBadge failed', { uid, err: err.message });
    }
});

// ---------------------------------------------------------------------------
// Scoped overseer hierarchy — team stamping (ADR 0005 + ADR 0007)
//
// Each private row (a task / archived task / work or break session) carries a denormalized
// `teamManagerIds` array — the OVERSEER CLOSURE of its owner: every manager/senior uid who may
// see the row. The security rules read this field to decide whether a scoped manager OR a senior
// manager may see the row, and the client queries it with `array-contains`. Stamping is done HERE
// (server-side) rather than at the ~13 scattered client write-sites: one authoritative place,
// impossible to miss a site. The failure mode is fail-closed — an unstamped row is hidden from
// overseers (owner + admin still see it via their own predicates), never leaked.
//
// Owner field per collection: tasks/archived_tasks/deleted_tasks use `assignedUserId`;
// work_sessions/break_sessions use `userId`.
// ---------------------------------------------------------------------------

// The denormalized OVERSEER CLOSURE for a user — every manager/senior uid who may see this user's
// private rows (ADR 0007). This is the visibility key stamped onto each owned row:
//   • worker  → their managers (teamManagerIds) PLUS each of those managers' seniors
//               (seniorManagerIds) — the transitive senior-manager subtree.
//   • manager → the seniors they answer to (seniorManagerIds).
//   • senior / admin → [] (their own rows are visible only to themselves + whole-company admins).
// Missing/!array fields default to []. A worker's branch costs 1 + N user reads (N = manager
// count, typically 1-2) — on the stamp path only (create/reassign/membership change), never the
// hot read path. Computed non-recursively (exactly one hop up: worker→manager→senior), so the
// 4-level hierarchy can never recurse.
// Roles that may legitimately appear in a worker's `overseerIds` closure. Mirrors the client's
// isManagerRole (+ the legacy Lithuanian admin spelling) — see SECONDARY_MANAGER_ROLES below, kept
// separate because THIS list is a security boundary: firestore.rules grants cross-user write access
// on closure membership alone, so widening it widens who can write a colleague's document.
const OVERSEER_ROLES = ['manager', 'seniorManager', 'admin', 'Administratorius'];

/**
 * Authorize a CALLABLE. Every callable must go through this — never re-check `role` by hand.
 *
 * Blocking an account (users/{uid}.isDisabled = true) is the app's only offboarding control, and it
 * used to stop nothing here: firestore.rules isActive() denies the blocked user's DIRECT writes and
 * AuthContext signs them out of the UI, but their Firebase Auth identity and ID token keep working
 * and their user doc still says role:'manager'. A role-only gate therefore let a blocked ex-employee
 * keep calling these functions — which run under the admin SDK and bypass firestore.rules entirely,
 * so nothing downstream would stop the write either.
 *
 * Centralised deliberately: this exact check was missing from every callable independently, so the
 * defect was the repetition, not any one site. A future callable gets it by construction.
 *
 * @param {string|undefined} callerUid  request.auth?.uid
 * @param {string[]} [roles]            allowed roles; omit to require only an ACTIVE account
 * @returns {Promise<Object>} the caller's user document data
 */
async function assertActiveCaller(callerUid, roles) {
    if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const snap = await db.collection('users').doc(callerUid).get();
    if (!snap.exists) throw new HttpsError('permission-denied', 'No profile.');
    const data = snap.data();
    if (data.isDisabled === true) throw new HttpsError('permission-denied', 'Account is blocked.');
    if (roles && !roles.includes(data.role || 'worker')) {
        throw new HttpsError('permission-denied', 'Insufficient role.');
    }
    return data;
}

// Keep only the uids that still HOLD an overseer role.
//
// Demotion never clears membership: an admin flipping a Vyr. vadovas down to 'Meistras' writes
// {role:'worker'} and their uid keeps sitting in every manager's seniorManagerIds. Copying that array
// verbatim therefore re-mints a plain worker as an overseer on the very next stamp — and the users
// UPDATE gate (overseesUserDoc) grants write access on closure membership ALONE, explicitly assuming
// "a worker uid can never be in it". The manager arm below has enforced that assumption for a while;
// the SENIOR arm did not, which is the half of a demotion that kept leaking authority.
//
// Same positive-disconfirmation rule throughout: an unreadable candidate is KEPT (a Firestore blip
// must never strip a legitimate overseer from their whole team), and only a successful read showing
// a non-overseer role drops the uid.
async function keepOverseerRoles(uids) {
    const kept = await Promise.all(uids.map(async (id) => {
        try {
            const snap = await db.collection('users').doc(id).get();
            if (!snap.exists) return null; // deleted account — not an overseer of anyone
            const role = snap.data().role || 'worker';
            if (!OVERSEER_ROLES.includes(role)) {
                logger.info('overseersFor dropped a demoted overseer from the closure', { uid: id, role });
                return null;
            }
            return id;
        } catch (err) {
            logger.warn('overseer role verification failed', { uid: id, err: err.message });
            return id; // unverified ≠ disproven — keep reach rather than break it on a blip
        }
    }));
    return kept.filter(Boolean);
}

// Resolve a user's overseer closure.
//
// THROWS on a hard lookup failure — deliberately, and this is load-bearing. It used to answer an
// unreachable Firestore with `[]`, which is not "I could not tell" but the positive claim "this
// person has NO overseers". Every caller then acted on that claim: the session-stamp trigger skipped
// its write and left the row invisible to the worker's real manager forever (it fires on create only,
// so nothing ever revisits it), and the backfill would have re-stamped a whole company's rows to an
// empty team. A thrown error instead surfaces in the function log and, for the stamp triggers, is
// retried until the dependency answers. Absence of overseers is still returned as [] — but only when
// that is what the data actually says.
async function overseersFor(uid) {
    if (!uid) return [];
    try {
        const snap = await db.collection('users').doc(uid).get();
        if (!snap.exists) return [];
        const u = snap.data();
        const role = u.role || 'worker';
        if (role === 'manager') {
            const seniors = u.seniorManagerIds;
            return keepOverseerRoles(Array.isArray(seniors) ? seniors.filter(Boolean) : []);
        }
        if (role === 'seniorManager' || role === 'admin' || role === 'Administratorius') {
            return [];
        }
        // worker (or legacy/absent role): direct managers + each manager's seniors.
        //
        // Each listed uid is ROLE-CHECKED before it enters the closure. `teamManagerIds` is team
        // MEMBERSHIP and nobody clears it on demotion: an admin flipping a coordinator to 'Meistras'
        // writes only {role:'worker'}, so their uid lingers in every ex-subordinate's array. Copying
        // that array verbatim therefore left a plain worker inside `overseerIds` — and the users
        // UPDATE gate in firestore.rules (overseesUserDoc) grants write access on membership in that
        // closure ALONE, explicitly documenting the assumption that "a worker uid can never be in
        // it". That assumption is what this filter now actually enforces, so a demoted coordinator
        // stops being able to write their old crew's live-session fields.
        //
        // Self-healing and free: restampTeamOnUserChange already re-runs this for every worker whose
        // teamManagerIds contains the changed uid whenever a role changes, and the manager document
        // is already being read below for seniorManagerIds — so this costs no extra reads.
        //
        // A FAILED read keeps the uid (the pre-existing behaviour): we drop a manager only on
        // POSITIVE disconfirmation of their role, never because Firestore hiccuped, so a transient
        // error cannot strip a legitimate manager's access to their whole team until the next stamp.
        const mgrs = Array.isArray(u.teamManagerIds) ? u.teamManagerIds.filter(Boolean) : [];
        const result = new Set();
        await Promise.all(mgrs.map(async (m) => {
            try {
                const msnap = await db.collection('users').doc(m).get();
                if (!msnap.exists) return; // deleted account — not an overseer of anyone
                const mdata = msnap.data();
                if (!OVERSEER_ROLES.includes(mdata.role || 'worker')) {
                    logger.info('overseersFor dropped a demoted manager from the closure', { uid, manager: m, role: mdata.role || 'worker' });
                    return;
                }
                result.add(m);
                const seniors = mdata.seniorManagerIds;
                // Role-verified, not copied: see keepOverseerRoles — a senior demoted to worker must
                // not be folded back into this worker's closure.
                if (Array.isArray(seniors)) {
                    (await keepOverseerRoles(seniors.filter(Boolean))).forEach((s) => result.add(s));
                }
            } catch (err) {
                logger.warn('overseersFor manager read failed', { manager: m, err: err.message });
                result.add(m); // unverified ≠ disproven — keep reach rather than break it on a blip
            }
        }));
        return [...result];
    } catch (err) {
        // Log and RETHROW. This used to `return []`, turning "I could not find out" into the positive
        // claim "this person has no overseers" — see the header above for what each caller then did
        // with that claim.
        logger.warn('overseersFor failed', { uid, err: err.message });
        throw err;
    }
}

// Order-insensitive equality — the array is a set, so reordering is not a change.
function sameSet(a, b) {
    if (a.length !== b.length) return false;
    const sb = new Set(b);
    return a.every((x) => sb.has(x));
}

// Ensure a written task/archived-task row carries its assignee's current team. Fires on
// create AND update (so a REASSIGNMENT re-stamps), but skips the expensive user-doc read on a
// routine edit whose owner is unchanged and that already has a stamp — keeping the hot path
// (status/timer/checklist edits) free of extra reads. Idempotent: the write it makes re-fires
// this trigger, but the second pass finds the stamp already correct and stops (no loop).
async function stampOwnedDoc(event, ownerField) {
    const after = event.data && event.data.after;
    if (!after || !after.exists) return; // deleted — nothing to stamp
    const data = after.data();
    const ownerUid = data[ownerField];
    if (!ownerUid) return;

    const before = event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const ownerChanged = !before || before[ownerField] !== ownerUid;
    const hasStamp = Array.isArray(data.teamManagerIds);
    if (!ownerChanged && hasStamp) return; // routine edit, already stamped — no work

    const desired = await overseersFor(ownerUid);
    if (sameSet(hasStamp ? data.teamManagerIds : [], desired)) return; // already correct
    await writeStamp(after.ref, desired);
}

// Apply the stamp, treating "the row is gone" as DONE rather than as a failure.
//
// This matters only because these triggers now retry: a row can legitimately disappear between its
// create event and this handler (the recovery banner's "Nedirbau" hard-deletes a just-written gap
// session within seconds), and an un-guarded NOT_FOUND would then be retried for days against a
// document that will never exist again. A deleted row has no visibility to maintain, so stopping is
// the correct outcome, not a swallowed error.
async function writeStamp(ref, desired) {
    try {
        await ref.update({ teamManagerIds: desired });
    } catch (err) {
        if (err && (err.code === 5 || err.code === 'not-found')) return;
        throw err;
    }
}

// Stamp a freshly created session from its owner (userId). Owner never changes on a session, so
// onCreate is enough.
//
// The stamp is written AUTHORITATIVELY — including when the computed closure is EMPTY. Skipping the
// empty case looked free (the rules' .get(...,[]) default reads an absent field as "no manager sees
// it") but it silently made the CLIENT the author of record for a field only this trigger is trusted
// to set. Nothing pins teamManagerIds on session CREATE, so a worker with no managers could ship a
// forged array and, because the trigger declined to overwrite it, keep it: any uid they named gained
// update/delete authority over their canonical paid-time row. Writing [] costs one small update on a
// rare path and leaves no window in which a client-supplied value survives. A genuinely failed
// lookup no longer reaches here at all — overseersFor throws, so the invocation is retried rather
// than stamping an empty team over a real one.
async function stampOwnedCreate(event, ownerField) {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    const ownerUid = data[ownerField];
    if (!ownerUid) return;
    const desired = await overseersFor(ownerUid);
    const current = Array.isArray(data.teamManagerIds) ? data.teamManagerIds : null;
    if (current && sameSet(current, desired)) return; // client happened to supply the right value
    await writeStamp(snap.ref, desired);
}

// retry:true — the stamp decides who may SEE and ACT on a row, and these triggers are the only
// writers of that field. A transient dependency failure previously ended the invocation for good
// (create-only triggers are never revisited), leaving a legitimate session permanently invisible to
// its scoped manager. Every handler here is idempotent — it recomputes the desired set and stops
// when the row already matches — so re-running one is always safe.
exports.stampTeamOnTaskWrite = onDocumentWritten({ document: 'tasks/{id}', retry: true }, (event) => stampOwnedDoc(event, 'assignedUserId'));
exports.stampTeamOnArchivedTaskWrite = onDocumentWritten({ document: 'archived_tasks/{id}', retry: true }, (event) => stampOwnedDoc(event, 'assignedUserId'));
exports.stampTeamOnWorkSessionCreate = onDocumentCreated({ document: 'work_sessions/{id}', retry: true }, (event) => stampOwnedCreate(event, 'userId'));
exports.stampTeamOnBreakSessionCreate = onDocumentCreated({ document: 'break_sessions/{id}', retry: true }, (event) => stampOwnedCreate(event, 'userId'));

// Re-stamp ALL of a user's private rows to a desired team set. Used by the membership-change
// trigger and the one-time backfill. Chunked via BulkWriter; idempotent (skips rows already
// correct), so it is safe to run repeatedly. Returns the number of rows actually rewritten.
const OWNED_COLLECTIONS = [
    { col: 'tasks', field: 'assignedUserId' },
    { col: 'archived_tasks', field: 'assignedUserId' },
    { col: 'deleted_tasks', field: 'assignedUserId' },
    { col: 'work_sessions', field: 'userId' },
    { col: 'break_sessions', field: 'userId' },
];

async function restampUserRows(uid, desired) {
    if (!uid) return 0;
    const writer = db.bulkWriter();
    let count = 0;
    for (const { col, field } of OWNED_COLLECTIONS) {
        const snap = await db.collection(col).where(field, '==', uid).get();
        snap.forEach((docSnap) => {
            const cur = docSnap.data().teamManagerIds;
            if (sameSet(Array.isArray(cur) ? cur : [], desired)) return; // already correct
            writer.update(docSnap.ref, { teamManagerIds: desired });
            count++;
        });
    }
    await writer.close();
    return count;
}

// Maintain the user-doc overseer closure (`overseerIds`) that the CREATE/assign rule reads (the
// rule reads the target USER doc, not a row, and that doc's editable teamManagerIds never carries
// a senior). Loop-safe: written from inside the users onUpdate trigger below, the sameSet guard
// makes a re-fire inert — and the trigger deliberately does NOT watch `overseerIds`.
async function setOverseerIds(uid, desired) {
    if (!uid) return false;
    const ref = db.collection('users').doc(uid);
    try {
        const snap = await ref.get();
        if (!snap.exists) return false;
        const cur = Array.isArray(snap.data().overseerIds) ? snap.data().overseerIds : [];
        if (sameSet(cur, desired)) return false; // already correct — no write, no loop
        await ref.update({ overseerIds: desired });
        return true;
    } catch (err) {
        // RETHROW. Swallowing this made a failed re-stamp indistinguishable from "nothing to change",
        // so a demotion whose closure write failed left the ex-overseer's uid in overseerIds — and
        // that array IS the users-update write gate. The trigger above is retried, so surfacing the
        // failure is what eventually revokes the access.
        logger.warn('setOverseerIds failed', { uid, err: err.message });
        throw err;
    }
}

// When an admin changes a worker's managers OR a manager's seniors (OR anyone's role), rewrite the
// affected closures so the right overseers see the right PAST rows (full-history decision, ADR
// 0005/0007). A manager's senior change CASCADES: every worker under that manager folds the
// manager's seniors into their own closure, so they must be re-stamped too. Membership changes are
// rare and crews small, so the fan-out (one manager's workers × their rows) is acceptable.
// retry:true for the same reason the stamp triggers carry it — and here the stake is REVOCATION, not
// just visibility. A demotion is exactly one write to users/{id}; this trigger is the only thing that
// then rewrites the closures that grant the demoted person write access to their old crew. It fires
// once, so a transient failure used to be permanent: nothing revisits a role change. Idempotent by
// construction (every desired set is recomputed from current state, and sameSet skips a no-op write),
// so a retry is free.
exports.restampTeamOnUserChange = onDocumentUpdated({ document: 'users/{id}', retry: true }, async (event) => {
    const uid = event.params.id;
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};

    // Watch only the SOURCE fields that can move a closure — NOT overseerIds, which THIS function
    // writes back (watching it would loop).
    const teamChanged = !sameSet(
        Array.isArray(before.teamManagerIds) ? before.teamManagerIds : [],
        Array.isArray(after.teamManagerIds) ? after.teamManagerIds : []
    );
    const seniorChanged = !sameSet(
        Array.isArray(before.seniorManagerIds) ? before.seniorManagerIds : [],
        Array.isArray(after.seniorManagerIds) ? after.seniorManagerIds : []
    );
    const roleChanged = (before.role || '') !== (after.role || '');
    if (!teamChanged && !seniorChanged && !roleChanged) return; // nothing visibility-relevant

    try {
        // (1) Re-stamp this user's own closure (user doc) + their own private rows.
        const desiredSelf = await overseersFor(uid);
        await setOverseerIds(uid, desiredSelf);
        const selfRows = await restampUserRows(uid, desiredSelf);

        // (2) Cascade: a manager's senior change (or any role flip) staled the closure of every
        // worker under this user — re-stamp them. (For a worker whose own managers changed, there
        // are no subordinates to cascade to; the query simply returns none.)
        //
        // Membership points at this user from TWO directions and a role change staled both, but only
        // the first was ever followed. A demoted SENIOR is named in their managers' seniorManagerIds,
        // never in anyone's teamManagerIds — so the array-contains query below missed every one of
        // them, and the ex-senior's uid stayed in each of those managers' workers' overseerIds. That
        // closure is exactly what the users UPDATE rule grants write authority from, so a Vyr. vadovas
        // demoted to Meistras kept mutating their former subordinates' user docs (live-session and
        // work-status projections included) until some unrelated event happened to re-stamp them.
        // Following the senior edge as well is what makes a demotion actually revoke.
        const cascadeUids = new Set();
        if (seniorChanged || roleChanged) {
            const [asManager, asSenior] = await Promise.all([
                db.collection('users').where('teamManagerIds', 'array-contains', uid).get(),
                db.collection('users').where('seniorManagerIds', 'array-contains', uid).get(),
            ]);
            asManager.docs.forEach((d) => cascadeUids.add(d.id));
            // A manager whose senior changed is itself re-stamped, AND every worker beneath that
            // manager folds the manager's seniors into their own closure — so the subtree under each
            // affected manager has to be walked too, or the revocation stops one level short.
            for (const m of asSenior.docs) {
                cascadeUids.add(m.id);
                const under = await db.collection('users')
                    .where('teamManagerIds', 'array-contains', m.id).get();
                under.docs.forEach((d) => cascadeUids.add(d.id));
            }
        }
        cascadeUids.delete(uid); // already handled by (1)
        let cascaded = 0;
        for (const target of cascadeUids) {
            const desiredT = await overseersFor(target);
            await setOverseerIds(target, desiredT);
            cascaded += await restampUserRows(target, desiredT);
        }
        logger.info('restampTeamOnUserChange done', { uid, selfRows, cascaded, cascadeTargets: cascadeUids.size });
    } catch (err) {
        // Rethrow so the platform retries (see the retry:true note above). Logging alone turned a
        // half-applied closure rewrite into the permanent state.
        logger.error('restampTeamOnUserChange failed', { uid, err: err.message });
        throw err;
    }
});

// One-time (idempotent) migration: stamp every user's existing rows from their current
// teamManagerIds. Admin-only callable — run once after deploying these functions and assigning
// memberships. Safe to re-run.
exports.backfillTeamStamps = onCall(async (request) => {
    const callerUid = request.auth && request.auth.uid;
    // Active admin only — a BLOCKED admin account must not be able to re-stamp teamManagerIds
    // across tasks, archived_tasks, deleted_tasks, work_sessions and break_sessions company-wide.
    await assertActiveCaller(callerUid, ['admin', 'Administratorius']);
    const usersSnap = await db.collection('users').get();
    let users = 0;
    let rows = 0;
    for (const u of usersSnap.docs) {
        const desired = await overseersFor(u.id);
        await setOverseerIds(u.id, desired); // seed/refresh the user-doc closure too
        rows += await restampUserRows(u.id, desired);
        users += 1;
    }
    logger.info('backfillTeamStamps done', { users, rows });
    return { users, rows };
});

// ---------------------------------------------------------------------------
// Account approval — notify admins of a pending sign-up
// ---------------------------------------------------------------------------
//
// A new sign-up lands as { isDisabled:true, status:'pending' } in users/{uid}, and AuthContext
// signs that user out immediately — so the CLIENT cannot write a notification (it has no
// authenticated session for the new account, and no other client is watching the users
// collection for creates). This server-side onCreate closes that gap: it fans an
// `account_approval` request_notification out to every active admin so the pending account
// surfaces in the bell with inline Patvirtinti / Užblokuoti (handled in ManagerNotifications).
//
// Admin SDK writes here BYPASS firestore.rules entirely, so no rules change is needed for these
// docs (the client-side create rule's provenance check does not apply to the admin SDK). Each doc
// carries the target's uid/name/email so the card can act without an extra read, and starts unread.
exports.notifyAdminsOnPendingSignup = onDocumentCreated('users/{id}', async (event) => {
    const snap = event.data;
    if (!snap) return;
    const u = snap.data();
    // Only brand-new PENDING sign-ups (a normal admin-created/active user must not alert anyone).
    if (!u || u.status !== 'pending' || u.isDisabled !== true) return;

    const targetUserId = event.params.id;
    try {
        // Every active admin is a recipient. Both legacy role spellings are honored.
        const adminUids = new Set();
        for (const role of ['admin', 'Administratorius']) {
            const adminsSnap = await db.collection('users').where('role', '==', role).get();
            adminsSnap.forEach((d) => {
                if (d.id !== targetUserId && d.data().isDisabled !== true) adminUids.add(d.id);
            });
        }
        if (!adminUids.size) {
            logger.warn('notifyAdminsOnPendingSignup: no active admin to notify', { targetUserId });
            return;
        }

        const nowIso = new Date().toISOString();
        const targetUserName = u.displayName || '';
        const targetUserEmail = u.email || '';
        await Promise.all([...adminUids].map((adminUid) =>
            db.collection('request_notifications').add({
                recipientId: adminUid,
                type: 'account_approval',
                category: 'action',
                targetUserId,
                targetUserName,
                targetUserEmail,
                isRead: false,
                createdAt: nowIso,
                // Provenance: a system-authored notification (no human actor). The admin-SDK write
                // bypasses the client provenance rule, so this is purely for audit/readability.
                createdBy: 'system_account_approval',
            })
        ));
        logger.info('notifyAdminsOnPendingSignup done', { targetUserId, admins: adminUids.size });
    } catch (err) {
        logger.error('notifyAdminsOnPendingSignup failed', { targetUserId, err: err.message });
    }
});

// ---------------------------------------------------------------------------
// Data integrity monitor (durability safety net)
// ---------------------------------------------------------------------------
//
// A scheduled daily pass that does TWO independent things and records ONE report doc at
// integrity_reports/{YYYY-MM-DD} (manager/admin-readable; client-immutable — see firestore.rules):
//
//   1. VOLUME CANARY — the strongest signal that "an agent or a bug destroyed the data". It counts
//      each critical collection (cheap count() aggregation) and compares against the previous run
//      stored in integrity_reports/_counts. A drop beyond DROP_ALERT_RATIO (a row count falling
//      >30% day-over-day) is flagged CRITICAL: normal activity only ADDS sessions, so a large net
//      DECREASE means a mass delete/overwrite — the exact disaster PITR + scheduled backups exist to
//      undo (recovery: docs/runbooks/firestore-backup-recovery.md). The baseline is advanced only
//      AFTER the report is written, so a drop is reported once against the last good baseline rather
//      than silently absorbed into it.
//
//   2. ANOMALY SCAN — corrupt VALUES that slipped past (or predate) the rules guardrails. Scans
//      sessions created in the last LOOKBACK_DAYS (createdAt is an ISO string → range query, served
//      by the automatic single-field index, no composite needed) for: out-of-range/non-numeric
//      durationMinutes, end<start, missing owner. work_hours has no createdAt, so it is covered by
//      the volume canary only.
//
//   2b. ADDITIVE-CORRUPTION SCAN — duplicated/overlapping rows that (2) cannot see because each row
//      is individually valid (the 2026-07-01 break_sessions incident: +917 duplicate rows, none of
//      them anomalous on their own). Sums each user's work_sessions + break_sessions minutes per
//      Vilnius calendar day over the same lookback window and flags a total exceeding 24h — a
//      physically impossible number that catches duplicates/overlaps without interval-overlap math.
//
// Read-only over the data apart from its own report docs. Region inherits europe-west1.

const MONITORED_COLLECTIONS = ['work_sessions', 'break_sessions', 'work_hours', 'tasks'];
const DROP_ALERT_RATIO = 0.3;   // a >30% day-over-day row drop in a monitored collection is critical
const LOOKBACK_DAYS = 2;        // anomaly scan window (catch fresh corruption); cheap and timely
const SAMPLE_LIMIT = 20;        // cap offending-id samples kept in a report (never store unbounded)

// Every read this scan makes can fail, and each failure silently shrinks what the run actually
// covered. Recording them in one place is what lets the report distinguish "found nothing wrong"
// from "did not look" — the difference between a compensating control and a rubber stamp. Callers
// pass a shared array; helpers push and degrade as before, so a partial scan still reports whatever
// it did manage to see.
function noteScanError(scanErrors, scan, err) {
    if (Array.isArray(scanErrors)) scanErrors.push({ scan, message: err?.message || String(err) });
}

async function collectionCount(name, scanErrors) {
    try {
        const snap = await db.collection(name).count().get();
        return snap.data().count;
    } catch (err) {
        logger.warn('collectionCount failed', { name, err: err.message });
        noteScanError(scanErrors, `count:${name}`, err);
        return null;
    }
}

// ISO cutoff LOOKBACK_DAYS ago. (Date.now() is fine in a function — only the workflow sandbox bans it.)
function lookbackCutoffIso() {
    return new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// Scan one session collection's recently-created rows for corrupt values.
async function scanSessionAnomalies(name, scanErrors) {
    const cutoff = lookbackCutoffIso();
    let snap;
    try {
        snap = await db.collection(name).where('createdAt', '>=', cutoff).get();
    } catch (err) {
        logger.warn('scanSessionAnomalies query failed', { name, err: err.message });
        noteScanError(scanErrors, `anomalies:${name}`, err);
        return { scanned: 0, anomalies: 0, samples: [] };
    }
    let anomalies = 0;
    const samples = [];
    snap.forEach((docSnap) => {
        const d = docSnap.data();
        const reasons = [];
        const dur = d.durationMinutes;
        if (typeof dur !== 'number' || Number.isNaN(dur)) reasons.push('duration-not-number');
        else if (dur < 0) reasons.push('duration-negative');
        else if (dur > 960) reasons.push('duration-over-clamp'); // above the client's 16h clamp = suspect
        if (d.startTime && d.endTime && new Date(d.endTime) < new Date(d.startTime)) reasons.push('end-before-start');
        if (!d.userId) reasons.push('missing-userId');
        if (reasons.length) {
            anomalies += 1;
            if (samples.length < SAMPLE_LIMIT) samples.push({ id: docSnap.id, reasons });
        }
    });
    return { scanned: snap.size, anomalies, samples };
}

// A calendar day only has 1440 minutes. Duplicated or overlapping session rows (the 2026-07-01
// break_sessions incident: +917 duplicate rows accumulated undetected) each look individually
// valid to scanSessionAnomalies above — no single row is out of range — so per-doc checks are
// structurally blind to this class. Summing a user's work_sessions + break_sessions minutes for
// one Vilnius calendar day and flagging anything over 24h catches duplicates/overlaps/double-
// credits without needing interval-overlap math. Same LOOKBACK_DAYS window as the anomaly scan;
// report-only, never mutates.
const MINUTES_PER_DAY = 24 * 60;

async function scanDailyOverdraft(scanErrors) {
    const cutoff = lookbackCutoffIso();
    const totals = new Map(); // `${userId}|${date}` -> { userId, date, minutes }
    for (const name of ['work_sessions', 'break_sessions']) {
        let snap;
        try {
            snap = await db.collection(name).where('createdAt', '>=', cutoff).get();
        } catch (err) {
            logger.warn('scanDailyOverdraft query failed', { name, err: err.message });
            noteScanError(scanErrors, `overdraft:${name}`, err);
            continue;
        }
        snap.forEach((docSnap) => {
            const d = docSnap.data();
            const dur = d.durationMinutes;
            if (typeof dur !== 'number' || Number.isNaN(dur) || dur <= 0 || !d.userId) return;
            const anchor = d.startTime || d.createdAt;
            const parsed = anchor ? new Date(anchor) : null;
            if (!parsed || Number.isNaN(parsed.getTime())) return;
            const date = lithuanianDay(parsed);
            const key = `${d.userId}|${date}`;
            const entry = totals.get(key) || { userId: d.userId, date, minutes: 0 };
            entry.minutes += dur;
            totals.set(key, entry);
        });
    }
    const offenders = [...totals.values()]
        .filter((entry) => entry.minutes > MINUTES_PER_DAY)
        .sort((a, b) => b.minutes - a.minutes);
    return { checked: totals.size, offenders: offenders.length, samples: offenders.slice(0, SAMPLE_LIMIT) };
}

// CREDIT-INTEGRITY scan — two report-only checks that close R-04's compensating-control gaps (ADR
// 0021): (1) ORPHAN — a work_sessions row that claims task work but references no real task; (2)
// SUSPICIOUS WORK DAY — a per-worker work-only day total in the (16h, 24h] moderate-inflation band
// the combined-overdraft scan is blind to. One fetch of the recent work_sessions window feeds both;
// the decision logic lives in ./integrityScans (pure, unit-tested standalone). Read-only.
async function scanCreditIntegrity(scanErrors) {
    const empty = {
        orphan: { checked: 0, orphans: 0, samples: [] },
        suspicious: { checked: 0, count: 0, samples: [] },
        serverSpan: { checked: 0, count: 0, samples: [] },
        engineAdoption: { total: 0, engineV2: 0, legacy: 0, legacyPct: 0 },
        counterDrift: { checked: 0, drifted: 0, samples: [] },
    };
    const cutoff = lookbackCutoffIso();
    let snap;
    try {
        snap = await db.collection('work_sessions').where('createdAt', '>=', cutoff).get();
    } catch (err) {
        logger.warn('scanCreditIntegrity query failed', { err: err.message });
        noteScanError(scanErrors, 'creditIntegrity:query', err);
        return empty;
    }
    // serverAnchorMs is Firestore's OWN updateTime for the row — the one instant in a work_sessions
    // document that no client authored. The server-span check below is built on it (and on the task's
    // createTime, captured in the same getAll pass), which is what makes that check independent of the
    // device clock every other guard has to trust. updateTime rather than createTime on purpose: it is
    // the LAST server write, so a row created small and grown in place is judged against its final
    // state and never falsely accused.
    // Stamped AFTER the spread so a stored field of the same name can never shadow the server's own
    // value — the whole point of this anchor is that the client cannot author it.
    const rows = snap.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
        serverAnchorMs: docSnap.updateTime ? docSnap.updateTime.toMillis() : null,
    }));

    // Orphan: verify every REFERENTIAL row's task exists. Distinct real taskIds are few over a 2-day
    // window; batch-get them and treat any absent task as an orphaned credit row.
    const taskIds = collectReferentialTaskIds(rows);
    const existing = new Set();
    // The same pass also records each task's Firestore createTime — the second server-authored anchor
    // the span check needs. Captured here rather than in a separate query because these documents are
    // being fetched anyway, so the check costs no extra reads.
    //
    // ONLY FROM `tasks`, and that restriction is load-bearing. Archiving does not MOVE a document, it
    // writes a NEW one under the same id in another collection — so an archived copy's createTime is
    // the moment it was ARCHIVED, not the moment the task was created. Feeding that to the span check
    // measures the run against an instant AFTER it, yielding a negative span that flags every honest
    // session whose task has since been archived. Observed live on the check's first production day:
    // 26 of 97 rows flagged, every sample negative (e.g. task FnG8cwzP7WwFd6vjCWgD — real creation
    // 2026-07-27 08:41, archived 2026-07-28 05:28, its sessions reported at −1244 min). The original
    // creation instant is not recoverable server-side once archived (the surviving `createdAt` field is
    // client-authored, which is precisely what this check refuses to trust), so an archived task is
    // UNMEASURABLE, not suspicious: leaving it anchor-less makes findImpossibleSpanSessions skip it via
    // its existing fail-safe. A third documented blind spot, accepted for the same reason as the other
    // two — a missed inflation costs a line in a report, a false accusation costs a worker's wages and
    // trains admins to ignore the alarm.
    const taskCreateMs = new Map();
    // A referential row's task may legitimately live in `tasks` OR — once confirmed and archived by the
    // daily archive job (same doc id) — in `archived_tasks`, or in `deleted_tasks` after a soft delete.
    // Check all three before calling a row orphaned; otherwise EVERY normally-completed-then-archived
    // task's sessions read as orphans within the 2-day window — a daily false positive that trains
    // admins to ignore the alarm and masks a REAL fabricated-credit row when one appears. Collections
    // are checked in order and only the still-missing ids are re-queried, so the common case (task in
    // `tasks`) costs exactly one pass.
    for (const coll of ['tasks', 'archived_tasks', 'deleted_tasks']) {
        const missing = taskIds.filter((id) => !existing.has(id));
        if (missing.length === 0) break;
        for (let i = 0; i < missing.length; i += 300) {
            const chunk = missing.slice(i, i + 300);
            try {
                const docs = await db.getAll(...chunk.map((id) => db.collection(coll).doc(id)));
                docs.forEach((d) => {
                    if (!d.exists) return;
                    // Existence answers the ORPHAN question, and all three collections count for it.
                    existing.add(d.id);
                    // The span ANCHOR is a different question and only the live collection can answer
                    // it — see the taskCreateMs declaration above for why a copy's createTime lies.
                    if (coll === 'tasks' && d.createTime) taskCreateMs.set(d.id, d.createTime.toMillis());
                });
            } catch (err) {
                // Fail SAFE for a report-only check: on a read error treat this chunk as present so an
                // infra hiccup never raises a false orphan alert.
                logger.warn('scanCreditIntegrity task getAll failed', { err: err.message, coll });
                noteScanError(scanErrors, `creditIntegrity:tasks:${coll}`, err);
                chunk.forEach((id) => existing.add(id));
            }
        }
    }
    const orphan = { checked: taskIds.length, ...findOrphanSessions(rows, existing) };

    // Suspicious work day: pure classification, Vilnius-day bucketed (guard unparseable anchors).
    const dayOf = (iso) => {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? null : lithuanianDay(d);
    };
    const suspicious = classifySuspiciousWorkDays(rows, dayOf);

    // Server-span: the only credit check that trusts no client-authored instant. A timer cannot
    // credit more work than the SERVER has seen its task exist, measured between two Firestore-
    // assigned timestamps. See findImpossibleSpanSessions for why this is a detection and not a rule.
    const serverSpan = findImpossibleSpanSessions(rows, taskCreateMs);

    // Migration telemetry (ADR-0020 step 6): engineVersion==2 adoption over the same rows. The gate
    // to retire the legacy self-write sites (roadmap P8) watches this trend toward zero legacy timer
    // authorship. Dormant engine (flag absent) reads ~100% legacy — the baseline, not an alarm.
    const engineAdoption = classifyEngineAdoption(rows);

    // Counter drift — the task card's cached total vs. the canonical ledger, for tasks whose ledger
    // was actually corrected. See findCounterDrift for why this cannot be made atomic at the source.
    const counterDrift = await scanCounterDrift(rows, scanErrors);

    return { orphan, suspicious, serverSpan, engineAdoption, counterDrift };
}

// The I/O half of the counter-drift check. Two reads per corrected task — the task itself and the
// FULL by-taskId session sum — so it is bounded: only corrected tasks qualify, and the count is
// capped, with the drop REPORTED rather than silently truncated.
const COUNTER_DRIFT_TASK_CAP = 200;

async function scanCounterDrift(rows, scanErrors) {
    const empty = { checked: 0, drifted: 0, samples: [] };
    const correctedIds = [...new Set(
        rows.filter((r) => isReferentialTaskSession(r) && isCorrectedSession(r)).map((r) => r.taskId)
    )];
    if (correctedIds.length === 0) return empty;

    const ids = correctedIds.slice(0, COUNTER_DRIFT_TASK_CAP);
    if (correctedIds.length > ids.length) {
        logger.warn('scanCounterDrift capped — not every corrected task was checked this run', {
            corrected: correctedIds.length, checked: ids.length,
        });
    }

    // The task doc, from wherever it lives now (a confirmed task is archived nightly, same id).
    const tasks = new Map();
    for (const coll of ['tasks', 'archived_tasks']) {
        const missing = ids.filter((id) => !tasks.has(id));
        if (missing.length === 0) break;
        for (let i = 0; i < missing.length; i += 300) {
            const chunk = missing.slice(i, i + 300);
            try {
                const docs = await db.getAll(...chunk.map((id) => db.collection(coll).doc(id)));
                docs.forEach((d) => { if (d.exists) tasks.set(d.id, d.data()); });
            } catch (err) {
                logger.warn('scanCounterDrift task getAll failed', { coll, err: err.message });
                noteScanError(scanErrors, `counterDrift:tasks:${coll}`, err);
            }
        }
    }

    // The FULL ledger sum per task. A window-limited sum would read as drift on every task with an
    // older session, so this deliberately queries by taskId rather than reusing `rows`.
    const ledgerMinutes = new Map();
    for (const id of ids) {
        if (!tasks.has(id)) continue; // orphan — findOrphanSessions owns that signal
        try {
            const snap = await db.collection('work_sessions').where('taskId', '==', id).get();
            let total = 0;
            snap.forEach((d) => {
                const s = d.data();
                if (s.isDeleted) return;
                if (typeof s.durationMinutes === 'number' && s.durationMinutes > 0) total += s.durationMinutes;
            });
            ledgerMinutes.set(id, total);
        } catch (err) {
            // Leave the id OUT of the map: findCounterDrift treats an absent sum as "could not tell"
            // rather than as a zero ledger, which would accuse every task of drifting.
            logger.warn('scanCounterDrift ledger query failed', { taskId: id, err: err.message });
            noteScanError(scanErrors, `counterDrift:ledger:${id}`, err);
        }
    }

    return findCounterDrift(rows, tasks, ledgerMinutes, SAMPLE_LIMIT);
}

// Hard ceiling for a SINGLE continuous running timer — MIRROR of src/utils/timeUtils
// MAX_SESSION_MINUTES (16h). No real continuous session approaches this; a larger elapsed can only
// be a timer left running after the app was closed.
const MAX_RUNNING_TIMER_MINUTES = 16 * 60;
// A heartbeat (timerLastHeartbeat) older than this proves the app is no longer alive on the task —
// the worker closed it and never reopened, so the proven stretch [start → last beat] is real work
// to credit. A RECENT beat instead means the app is still open RIGHT NOW with the timer running
// (an idle "left it open" timer): crediting that would pay for non-work, so it is discarded exactly
// as before. Comfortably beyond a couple of missed beats from a slow field connection.
const HEARTBEAT_STALE_GAP_MS = 5 * 60 * 1000;
const STALE_TASK_DAYS = 30;                                   // non-terminal age that warrants review
const STALE_STATUSES = ['pending', 'in-progress', 'approved', 'unapproved'];

// ---------------------------------------------------------------------------
// Canonical (ADR-0020) active-session awareness for the nightly nets
// ---------------------------------------------------------------------------
//
// The revisioned timer engine keeps ONE authoritative record per worker in active_sessions/{uid};
// tasks/{id} and users/{uid} are merely its projections. Both nets below predate that engine and
// still close a run by writing the PROJECTIONS alone, which under the engine leaves the canonical
// record claiming 'active' for a run the server has already settled — and nothing heals it, because
// active_sessions can never be deleted and the client recovery path now (correctly) refuses to
// credit a run whose task is no longer running. The worker is then wedged: restarting the SAME task
// is refused as already-running, and starting a DIFFERENT one first "closes" the stale run and
// credits up to another 16h nobody worked.
//
// So a net that closes a run must also retire the canonical record under the same revision protocol
// the client uses, and must credit into the same deterministic ledger id the engine's own closer
// would have used — otherwise the two closers mint two rows for one stretch and can never dedupe.
const TIMER_ENGINE_VERSION = 2;   // MIRROR of src/utils/timerTransitionPlan.js TIMER_ENGINE_VERSION

// The canonical run held by `record`, but ONLY if it is the very run this net is closing. Matching
// on the start instant (not just the type/task) is what stops a slow scan from retiring a NEWER run
// the worker started in the meantime.
function canonicalRunOf(record, { type, taskId = null, startIso }) {
    if (!record || record.status !== 'active') return null;
    const run = record.run;
    if (!run || run.type !== type || !run.runId) return null;
    if (taskId && run.taskId !== taskId) return null;
    const runStartMs = new Date(run.startedAt || '').getTime();
    const closingStartMs = new Date(startIso || '').getTime();
    if (!Number.isFinite(runStartMs) || !Number.isFinite(closingStartMs)) return null;
    return runStartMs === closingStartMs ? run : null;
}

// Read-only probe: is this run canonical? Used BEFORE the close so the ledger id can be chosen.
//
// Returns { ok, run }. `ok:false` means the question could not be ANSWERED — which is not the same
// as "not canonical", though it used to be treated that way. Guessing "legacy" on a failed read is
// actively dangerous rather than merely conservative: the net then writes the LEGACY deterministic
// ledger id and leaves the canonical run active, so when that run is later closed properly it mints
// sess_run_* for the very same physical interval and the stretch is credited TWICE. The two ids are
// deliberately different, so nothing downstream can ever dedupe them. A caller that cannot get an
// answer must defer to the next run instead of picking an engine.
async function readCanonicalRun(uid, match) {
    if (!uid) return { ok: true, run: null };
    try {
        const snap = await db.collection('active_sessions').doc(uid).get();
        return { ok: true, run: snap.exists ? canonicalRunOf(snap.data(), match) : null };
    } catch (err) {
        logger.warn('canonical run read failed', { uid, err: err.message });
        return { ok: false, run: null };
    }
}

// Retire the canonical record for a run this net just closed. The match is re-checked INSIDE the
// transaction, so a client command landing between the probe above and this write wins the race
// intact instead of being clobbered by a stale revision.
//
// THIS IS THE ONE STEP NOTHING RETRIES, so it must not fail quietly. Both nets clear the PROJECTION
// before getting here, and both find their candidates by that projection ('timerStatus == running',
// 'activeSession != null') — so once it is cleared the run is invisible to every later scan, and a
// swallowed failure leaves active_sessions claiming an active run forever. That is the wedged worker
// the canonical nets exist to prevent: their next start is refused as already-running. Hence a
// bounded in-process retry (a transaction contention/blip is the realistic failure), and a caller
// that must record the residue rather than count the close as clean.
//
// Returns { released, error }: `error` set ONLY when the question could not be answered — a clean
// `released:false` just means the record had already moved on (a client won the race), which is the
// correct no-op, not a fault.
const CANONICAL_RELEASE_ATTEMPTS = 3;

async function releaseCanonicalRun(uid, match) {
    let lastErr = null;
    for (let attempt = 1; attempt <= CANONICAL_RELEASE_ATTEMPTS; attempt += 1) {
        const outcome = await releaseCanonicalRunOnce(uid, match);
        if (!outcome.error) return outcome;
        lastErr = outcome.error;
        logger.warn('canonical run release attempt failed', { uid, attempt, err: lastErr.message });
    }
    logger.error('canonical run release EXHAUSTED — active_sessions may still claim a closed run', {
        uid, err: lastErr && lastErr.message,
    });
    return { released: false, error: lastErr };
}

async function releaseCanonicalRunOnce(uid, match) {
    const ref = db.collection('active_sessions').doc(uid);
    try {
        const released = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) return false;
            const record = snap.data() || {};
            const run = canonicalRunOf(record, match);
            if (!run) return false;
            tx.set(ref, {
                userId: uid,
                revision: (record.revision || 0) + 1,
                expectedRevision: record.revision || 0,
                expectedRunId: run.runId,
                status: 'idle',
                run: null,
                lastCommandId: `sys_autoclose_${run.runId}`,
                updatedAt: new Date().toISOString(),
                engineVersion: TIMER_ENGINE_VERSION,
            });
            return true;
        });
        return { released, error: null };
    } catch (err) {
        return { released: false, error: err };
    }
}

// Stop timers left RUNNING longer than any real continuous session — the forgotten-timer corruption
// (the 8710-min / 1158-min cases) that the CLIENT clamp structurally cannot reach, because it only
// fires while the assignee has the app open on that task (autoStopped was 0/471 in the data). The
// unbounded running interval is DISCARDED (we never credit phantom hours) and the task is flagged
// autoStopped so a manager can add real time if the worker actually worked. Safe by construction: a
// genuine continuous session never exceeds 16h, and legitimate long (25-70h) jobs accrue via many
// PAUSED sessions, never one running run — so this never clips real work. The worker's own
// activeSession/workStatus is reconciled client-side by the orphan-recovery hook on next app load.
//
// ORDERING IS THE CORRECTNESS ARGUMENT HERE. Stopping a task is a one-way door: once timerStatus
// leaves 'running' the task no longer matches this scan's query, so nothing retries it. Every step
// that must not be lost therefore happens BEFORE that door closes — credit the ledger first, stop
// the projection second, retire the canonical record last — and any step that cannot be completed
// abandons the candidate untouched for the next run rather than half-applying the transition.
async function autoStopForgottenTimers(scanErrors) {
    let snap;
    try {
        snap = await db.collection('tasks').where('timerStatus', '==', 'running').get();
    } catch (err) {
        logger.warn('autoStopForgottenTimers query failed', { err: err.message });
        noteScanError(scanErrors, 'autoStopForgottenTimers:query', err);
        return { scanned: 0, stopped: 0, deferred: 0, samples: [] };
    }
    const nowMs = Date.now();
    const nowIso = new Date().toISOString();
    let stopped = 0;
    let deferred = 0;
    const samples = [];
    const audits = [];
    const canonicalReleases = [];
    // Filter first, then process: choosing the ledger id needs an active_sessions read per hit, and
    // forEach cannot await. The candidate set is tiny by construction (only runs past the 16h
    // ceiling), so the extra reads cost nothing.
    const candidates = [];
    snap.forEach((docSnap) => {
        const t = docSnap.data();
        if (!t.timerStartedAt) return;
        const startMs = new Date(t.timerStartedAt).getTime();
        if (Number.isNaN(startMs)) return;
        const elapsedMin = (nowMs - startMs) / 60000;
        if (elapsedMin <= MAX_RUNNING_TIMER_MINUTES) return;
        candidates.push({ docSnap, t, startMs, elapsedMin });
    });

    for (const { docSnap, t, startMs, elapsedMin } of candidates) {
        // Heartbeat-aware credit: a timer left running >16h is forgotten, but the per-minute client
        // heartbeat (timerLastHeartbeat) marks the last instant the app was actually alive on it.
        // Credit the PROVEN stretch [start → last beat] (clamped ≤16h) instead of discarding the
        // whole interval, so a worker who closed the app and never reopened still gets their real
        // work — while the unproven tail past the last beat is dropped (never credit phantom hours).
        // No beat (pre-heartbeat data, or a timer killed before its first beat) or no assignee →
        // discard, exactly as before.
        const beatMs = t.timerLastHeartbeat ? new Date(t.timerLastHeartbeat).getTime() : NaN;
        // Require the beat to be STALE (app demonstrably gone), not just present: a still-beating
        // >16h timer is an idle "left the app open" timer, not offline work — crediting it would pay
        // for non-work, so it is discarded as before. Pre-heartbeat data (no beat) also discards.
        const hasBeat = Number.isFinite(beatMs) && beatMs >= startMs && beatMs <= nowMs;
        const appLongGone = hasBeat && (nowMs - beatMs) > HEARTBEAT_STALE_GAP_MS;
        const creditedMin = appLongGone ? Math.min((beatMs - startMs) / 60000, MAX_RUNNING_TIMER_MINUTES) : 0;
        const credited = creditedMin > MIN_LOGGED_SECONDARY_MINUTES && !!t.assignedUserId;

        // Does the revisioned engine own this run? If so its canonical record has to be retired too,
        // and the credit must land on the id the engine's own closer would have used.
        const canonicalMatch = { type: 'task', taskId: docSnap.id, startIso: t.timerStartedAt };
        const probe = await readCanonicalRun(t.assignedUserId, canonicalMatch);
        // Unreadable ≠ legacy. Guessing here picks the WRONG deterministic ledger id and leaves the
        // canonical run active, so the engine's own later close mints a second row for the identical
        // interval — a double credit no downstream dedupe can catch, because the two ids differ by
        // construction. Defer the whole candidate; it is still 'running' and the next scan retries it.
        if (!probe.ok) {
            deferred += 1;
            logger.warn('autoStopForgottenTimers deferred — canonical state unreadable', { id: docSnap.id });
            continue;
        }
        const canonicalRun = probe.run;

        const update = {
            timerStatus: 'paused',
            timerStartedAt: null,
            autoStopped: true,
            autoStopReason: credited ? 'forgotten-timer-16h-credited-to-heartbeat' : 'forgotten-timer-16h',
            autoStoppedAt: nowIso,
            updatedAt: nowIso,
        };
        if (credited) update.timerMinutes = (t.timerMinutes || 0) + creditedMin;
        // Clear the run pointer on the projection too, so the task doc stops advertising a run that
        // no longer exists — the same fields the engine's own pause writes.
        if (canonicalRun) {
            update.timerRunId = null;
            update.timerProjectionVersion = TIMER_ENGINE_VERSION;
        }

        // (1) CREDIT FIRST. This write used to run after the projection had already been paused, as
        // best-effort — so a transient failure was logged, swallowed, and then permanently lost: the
        // task was no longer 'running', so no later scan could ever pick it up and pay the missing
        // stretch. Writing the ledger row first inverts the failure mode into a harmless one. If it
        // fails, the task stays running and the next scan recomputes the identical row (the id is
        // keyed on the run, and beatMs cannot move once the app is gone) and tries again. If it
        // succeeds but the stop below does not, the same deterministic id makes the retry a no-op.
        if (credited) {
            // Deterministic id so a re-fired scan hits ALREADY_EXISTS via createIfAbsent rather than
            // double-crediting — and, crucially, the SAME id the run's other possible closer would
            // mint, so the two never produce two rows for one stretch. Which id that is depends on
            // which engine owns the run: sess_run_{runId} for the revisioned engine (mirrors
            // closeTaskWrites in timerTransitionPlan.js), sess_task_{taskId}_{startMs} for the legacy
            // client closer (mirrors taskSessionDocId in taskActions.js) — both locked by
            // firebaseConsistency.test.js. The onCreate stamp trigger denormalizes teamManagerIds,
            // so reports scope it like any timer-logged session.
            const creditRef = db.collection('work_sessions').doc(
                canonicalRun ? `sess_run_${canonicalRun.runId}` : `sess_task_${docSnap.id}_${startMs}`
            );
            try {
                await createIfAbsent(creditRef, {
                    taskId: docSnap.id,
                    taskTitle: t.title || 'Nežinoma užduotis',
                    userId: t.assignedUserId,
                    userName: t.assignedUserName || null,
                    startTime: new Date(startMs).toISOString(),
                    endTime: new Date(beatMs).toISOString(),
                    durationMinutes: creditedMin,
                    date: lithuanianDay(new Date(beatMs)),
                    createdAt: nowIso,
                    autoStopped: true,
                    ...(canonicalRun
                        ? { runId: canonicalRun.runId, engineVersion: TIMER_ENGINE_VERSION }
                        : {}),
                });
            } catch (err) {
                deferred += 1;
                logger.warn('autoStopForgottenTimers deferred — credit write failed', { id: docSnap.id, err: err.message });
                continue; // leave the task running so the next scan can pay this stretch
            }
        }

        // (2) STOP THE PROJECTION, guarded on the snapshot this decision was made from. The old
        // BulkWriter update carried no precondition, so a worker who closed the stale run and started
        // a NEW one on the same task during the scan had that fresh run paused by a decision computed
        // from a document that no longer existed — while the canonical release (which DOES re-check
        // inside a transaction) correctly spared it, splitting the two authorities apart. lastUpdateTime
        // makes the write fail instead of clobbering, and a failure just defers to the next run.
        try {
            await docSnap.ref.update(update, { lastUpdateTime: docSnap.updateTime });
        } catch (err) {
            deferred += 1;
            logger.warn('autoStopForgottenTimers deferred — task changed during the scan', { id: docSnap.id, err: err.message });
            continue;
        }

        if (canonicalRun) canonicalReleases.push({ uid: t.assignedUserId, match: canonicalMatch });

        stopped += 1;
        if (samples.length < SAMPLE_LIMIT) samples.push({ id: docSnap.id, elapsedMin: Math.round(elapsedMin), creditedMin: Math.round(creditedMin) });
        // Key on the stopped running interval (taskId + its start) so a retry recomputes the SAME
        // idempotency key — the create() in appendSystemDecision then dedups the audit, not the effect.
        audits.push({ taskId: docSnap.id, startIso: t.timerStartedAt, elapsedMin: Math.round(elapsedMin), creditedMin: Math.round(creditedMin), canonical: !!canonicalRun });
    }

    // Retire the canonical record LAST — only after the task projection and its ledger row have
    // landed, so an observer never sees a run reported closed before its credited time exists. A run
    // with nothing to credit (no heartbeat → phantom interval discarded) deliberately writes no row:
    // the client-side coupling rule exists to stop a CLIENT advancing the revision while withholding
    // credited time, and there is no credited time here to withhold. Minting a 0-minute row instead
    // would put a phantom entry in the worker's own session list for work that was never proven.
    for (const r of canonicalReleases) {
        const outcome = await releaseCanonicalRun(r.uid, r.match);
        // A release that could not be COMPLETED is a coverage gap, not a quiet success: the task is
        // already paused, so no later scan will retry it, and the run stays claimed. Fold it into the
        // scan's completeness verdict so the night cannot read as clean while a worker is wedged.
        if (outcome.error) noteScanError(scanErrors, `autoStopForgottenTimers:release:${r.uid}`, outcome.error);
    }

    // Audit each auto-stop under the SYSTEM actor (ADR 0015), AFTER the writes land. Best-effort:
    // an audit failure never undoes a stop that already happened.
    for (const a of audits) {
        await appendSystemDecision(db, {
            idempotencyKey: `autostop_${a.taskId}_${a.startIso}`,
            command: 'integrity.autoStopTimer',
            source: 'dailyIntegrityScan',
            targetType: 'task',
            targetId: a.taskId,
            reason: (a.creditedMin > 0
                ? `Auto-stopped a timer left running ${a.elapsedMin} min (>16h); credited ${a.creditedMin} min up to the last heartbeat, dropped the unproven tail`
                : `Auto-stopped a timer left running ${a.elapsedMin} min (>16h); no heartbeat — phantom interval discarded`)
                + (a.canonical ? '; retired the canonical active-session record for that run' : ''),
            before: { timerStatus: 'running', timerStartedAt: a.startIso },
            after: { timerStatus: 'paused', timerStartedAt: null, autoStopped: true, creditedMinutes: a.creditedMin },
        });
    }
    // `deferred` counts candidates deliberately left running because a step could not be completed
    // safely. It is reported (and folded into the scan's completeness verdict) so a net that keeps
    // failing to close the same timer is visible instead of looking like a quiet night.
    return { scanned: snap.size, stopped, deferred, samples };
}

// ---------------------------------------------------------------------------
// Proactive stale-running-timer nudge (short cadence) — the real-time companion
// ---------------------------------------------------------------------------
//
// autoStopForgottenTimers above only reconciles timers left running PAST the 16h ceiling, once a day.
// That misses the SHORT dropped-session: a worker whose phone backgrounded / killed the PWA / lost
// signal — which freezes the per-minute client heartbeat — while a task timer is still marked running.
// They keep working, the timer's proof-of-life goes cold, and (unless reopen-recovery cleanly credits
// it) the stretch later reads as a cold "Neaktyvus" band the worker only discovers days later.
//
// There is NO server-side way to tell "pocketed but still working" from "stopped": both look like a
// stale heartbeat (a field worker with the screen off IS the normal case). So this net deliberately
// does NOT credit or stop anything — that stays the worker's (reopen → recovery) and the daily net's
// job. It fires ONE gentle "still on it?" nudge per run: a real loss is caught in minutes, and a
// worker who is still working simply ignores it.
const TIMER_STALE_NUDGE_MS = 25 * 60 * 1000; // heartbeat older than this → nudge. The feature's tuning knob.

// Pure decision (unit-tested via a source slice in firebaseConsistency.test.js): nudge this running
// task NOW? Yes when its heartbeat is stale beyond TIMER_STALE_NUDGE_MS AND the run is still under the
// 16h ceiling — past that the daily autoStopForgottenTimers owns it, so the two nets never both act on
// one run. No heartbeat at all → skip: no proof the app was ever alive on it (pre-heartbeat data, or a
// timer killed before its first beat), and nudging a never-alive timer would be noise. No assignee →
// nobody to notify. Once-per-run is enforced downstream by the deterministic notification id, not here.
function shouldNudgeStaleTimer(task, nowMs) {
    if (!task || task.timerStatus !== 'running' || !task.timerStartedAt) return false;
    if (!task.assignedUserId) return false;
    const startMs = new Date(task.timerStartedAt).getTime();
    if (!Number.isFinite(startMs)) return false;
    const beatMs = task.timerLastHeartbeat ? new Date(task.timerLastHeartbeat).getTime() : NaN;
    if (!Number.isFinite(beatMs)) return false;                              // no proof of life → not ours to nudge
    if (nowMs - beatMs < TIMER_STALE_NUDGE_MS) return false;                 // heartbeat still fresh (app alive on it)
    if (nowMs - startMs > MAX_RUNNING_TIMER_MINUTES * 60000) return false;   // >16h → the daily net owns this run
    return true;
}

// Scan running task timers and fire one gentle "still running?" nudge per stale run. The notification
// id is deterministic on (taskId + the run's start), so create() + ALREADY_EXISTS makes it fire
// exactly ONCE per run — never repeating across the 10-min cadence, while a fresh run after the worker
// resumes/restarts (new timerStartedAt) can nudge again. The existing notifyOnRequestNotification
// onCreate trigger turns the doc into the FCM push; a re-created (already-exists) doc never re-fires it.
async function notifyStaleRunningTimers(nowMs = Date.now()) {
    let snap;
    try {
        snap = await db.collection('tasks').where('timerStatus', '==', 'running').get();
    } catch (err) {
        logger.warn('notifyStaleRunningTimers query failed', { err: err.message });
        return { scanned: 0, nudged: 0 };
    }
    const nowIso = new Date(nowMs).toISOString();
    let nudged = 0;
    for (const docSnap of snap.docs) {
        const t = docSnap.data();
        // A run that is ALSO past its planned time belongs to notifyOverEstimateTimers below: that
        // message strictly dominates this one (it names a concrete problem instead of asking a
        // question), and both nets are once-per-run, so firing both would just double the push for a
        // single silent timer. The two thresholds nest (over-estimate speaks at 5 min of client
        // silence, this one at 25), so every run this net would ever see is already decided there.
        if (shouldNotifyOverEstimate(t, nowMs)) continue;
        if (!shouldNudgeStaleTimer(t, nowMs)) continue;
        const startMs = new Date(t.timerStartedAt).getTime();
        const ref = db.collection('request_notifications').doc(`timercheck_${docSnap.id}_${startMs}`);
        try {
            // create (not add): the deterministic id + ALREADY_EXISTS is the once-per-run dedup, so a
            // still-stale timer is never re-notified every 10 minutes.
            await ref.create({
                recipientId: t.assignedUserId,
                type: 'timer_running_check',
                category: 'info',
                taskId: docSnap.id,
                taskTitle: t.title || 'Užduotis',
                isRead: false,
                createdAt: nowIso,
                createdBy: 'system_timer_check',
            });
            nudged += 1;
        } catch (err) {
            if (err && (err.code === 6 || err.code === 'already-exists')) continue; // already nudged this run
            logger.warn('notifyStaleRunningTimers nudge failed', { id: docSnap.id, err: err.message });
        }
    }
    return { scanned: snap.size, nudged };
}

// Every 10 minutes — bounds "how long until a dropped timer is flagged" to ~10 min + the stale
// threshold. Cheap: one indexed query (timerStatus == running, the same index autoStopForgottenTimers
// uses) over a single company's tasks, and a write only for the rare genuinely-stale run.
exports.notifyStaleRunningTimers = onSchedule(
    { schedule: 'every 10 minutes', timeZone: 'Europe/Vilnius' },
    async () => {
        const result = await notifyStaleRunningTimers();
        if (result.nudged > 0) logger.info('notifyStaleRunningTimers fired', result);
    },
);

// ---------------------------------------------------------------------------
// Over-the-plan alert — the offline half of the 100% time-limit gate
// ---------------------------------------------------------------------------
//
// useTaskTimeMonitor stops a task the moment it reaches 100% of its estimate and forces the worker to
// choose: request more time, or finish. That gate is a 10-second interval inside the PWA, so it only
// exists while the app is open in the foreground. A worker who pockets the phone (or loses signal)
// blows straight through the plan with nothing said — confirmed in production 2026-07-27: a 45-min
// task ran 1h18m, the limit fired only on reopen, and the worker was never offered the extension.
//
// This is the server-side half of the same gate, and it deliberately does LESS than the client one:
// it only SPEAKS. It does not stop the timer and does not credit or drop anything — the server cannot
// tell "still working past the plan" from "forgot to stop", and guessing either way corrupts real
// paid time (the same reasoning that keeps notifyStaleRunningTimers advisory). Stopping stays the
// client's job on reopen; this just makes sure the worker learns about the overrun in minutes,
// through a push that reaches a locked phone, instead of at the end of the day.
//
// How long the client must be SILENT before the server speaks. Above the 1-min heartbeat interval and
// above the client's 3-min continue window, so a live app is never talked over — if the heartbeat is
// fresh, the in-app gate is running and has already stopped the task and raised its own popup.
const TIMER_OVER_ESTIMATE_QUIET_MS = 5 * 60 * 1000;

// The task's planned minutes. Prefers the numeric mirror the client writes on create/edit and on a
// granted extension; falls back to parsing the human string for docs written before that mirror.
function taskEstimateMinutes(task) {
    const stored = Number(task.estimatedTimeMinutes);
    if (Number.isFinite(stored) && stored > 0) return stored;
    return parseEstimateMinutes(task.estimatedTime || '');
}

// Minutes this task has accrued RIGHT NOW — a server MIRROR of the client's calculateCurrentTotalMinutes
// for a running task: banked (manual + timer) + explicit adjustments + the live stretch, with the same
// 16h clamp on that stretch so a stale timerStartedAt cannot manufacture an overrun. The client's
// legacy `actualTime`-string fallback is deliberately NOT mirrored: it only applies when nothing is
// banked, and reading a free-form string here could only ever make this net speak MORE. Silence on an
// exotic legacy doc is the safe failure.
function runningTaskMinutes(task, nowMs) {
    const startMs = new Date(task.timerStartedAt).getTime();
    if (!Number.isFinite(startMs)) return NaN;
    let total = (Number(task.manualMinutes) || 0) + (Number(task.timerMinutes) || 0);
    if (Array.isArray(task.timeAdjustments)) {
        for (const adj of task.timeAdjustments) total += Number(adj && adj.durationMinutes) || 0;
    }
    const runMinutes = (nowMs - startMs) / 60000;
    if (runMinutes > 0) total += Math.min(runMinutes, MAX_RUNNING_TIMER_MINUTES);
    return total;
}

// Pure decision (unit-tested via a source slice in firebaseConsistency.test.js): tell this worker NOW
// that their running task passed its plan? Every clause is a reason the server must stay quiet:
//   • not a running, owned, parseable run → nothing to talk about;
//   • no heartbeat at all → no proof the app was ever alive on this run (mirrors shouldNudgeStaleTimer);
//   • heartbeat still fresh → the in-app 100% gate owns it, and a push would duplicate its popup;
//   • past 16h → the daily autoStopForgottenTimers owns that run, so the nets never both act on one;
//   • no plan → there is no line to cross (a task with no estimate is untimed by design).
// Once-per-run-per-plan is enforced downstream by the deterministic notification id, not here.
function shouldNotifyOverEstimate(task, nowMs) {
    if (!task || task.timerStatus !== 'running' || !task.timerStartedAt) return false;
    if (!task.assignedUserId) return false;
    const startMs = new Date(task.timerStartedAt).getTime();
    if (!Number.isFinite(startMs)) return false;
    const beatMs = task.timerLastHeartbeat ? new Date(task.timerLastHeartbeat).getTime() : NaN;
    if (!Number.isFinite(beatMs)) return false;
    if (nowMs - beatMs < TIMER_OVER_ESTIMATE_QUIET_MS) return false;
    if (nowMs - startMs > MAX_RUNNING_TIMER_MINUTES * 60000) return false;
    const estimateMinutes = taskEstimateMinutes(task);
    if (!(estimateMinutes > 0)) return false;
    const spentMinutes = runningTaskMinutes(task, nowMs);
    return Number.isFinite(spentMinutes) && spentMinutes >= estimateMinutes;
}

// Scan running task timers and fire ONE over-the-plan alert per run per plan. The notification id is
// deterministic on (taskId + the run's start + the planned minutes), which makes create() +
// ALREADY_EXISTS do two jobs: it never repeats across the 10-min cadence, and a granted extension
// (which rewrites estimatedTimeMinutes) re-arms the alert for the new plan — exactly how the client
// latch re-arms on an estimate change. A fresh run after a resume re-arms it too. The existing
// notifyOnRequestNotification onCreate trigger turns the doc into the FCM push.
async function notifyOverEstimateTimers(nowMs = Date.now()) {
    let snap;
    try {
        snap = await db.collection('tasks').where('timerStatus', '==', 'running').get();
    } catch (err) {
        logger.warn('notifyOverEstimateTimers query failed', { err: err.message });
        return { scanned: 0, alerted: 0 };
    }
    const nowIso = new Date(nowMs).toISOString();
    let alerted = 0;
    for (const docSnap of snap.docs) {
        const t = docSnap.data();
        if (!shouldNotifyOverEstimate(t, nowMs)) continue;
        const startMs = new Date(t.timerStartedAt).getTime();
        const planMinutes = Math.round(taskEstimateMinutes(t));
        const ref = db.collection('request_notifications')
            .doc(`overest_${docSnap.id}_${startMs}_${planMinutes}`);
        try {
            await ref.create({
                recipientId: t.assignedUserId,
                type: 'task_over_estimate',
                category: 'info',
                taskId: docSnap.id,
                taskTitle: t.title || 'Užduotis',
                isRead: false,
                createdAt: nowIso,
                createdBy: 'system_over_estimate',
            });
            alerted += 1;
        } catch (err) {
            if (err && (err.code === 6 || err.code === 'already-exists')) continue; // already alerted
            logger.warn('notifyOverEstimateTimers alert failed', { id: docSnap.id, err: err.message });
        }
    }
    return { scanned: snap.size, alerted };
}

// Same 10-minute cadence as the stale-timer net: the worker learns about an overrun within ~10 min of
// the quiet window elapsing. Same single indexed query (timerStatus == running) over one company's
// tasks, and a write only for a run that actually crossed its plan.
exports.notifyOverEstimateTimers = onSchedule(
    { schedule: 'every 10 minutes', timeZone: 'Europe/Vilnius' },
    async () => {
        const result = await notifyOverEstimateTimers();
        if (result.alerted > 0) logger.info('notifyOverEstimateTimers fired', result);
    },
);

// ---------------------------------------------------------------------------
// Abandoned SECONDARY-session safety net (break / call / quick-work)
// ---------------------------------------------------------------------------
//
// The client now RESUMES a reopened same-day secondary session instead of finalizing it on every
// reload (useOrphanedSessionRecovery), so a field worker who pockets the phone keeps their timer.
// The cost: a worker who NEVER reopens the app would leave a forgotten break/call/quick-work hanging
// in users/{uid}.activeSession forever — autoStopForgottenTimers above only reconciles TASK timers.
// This is the logging counterpart: it closes a secondary session that is genuinely abandoned (same
// abandonment test the client uses — crossed a Vilnius day OR elapsed past the 16h ceiling), CREDITS
// the clamped elapsed as a real record (never discarded — data continuity is the whole point), and
// clears the live flags. Deterministic record ids + create() make a re-fired scan idempotent. A
// still-running same-day session is left untouched (the worker may resume it on their next open).
//
// Field shapes MIRROR src/utils/sessionActions.js handleLegacyLogging — keep the two in lockstep.
const AUTO_STOPPED_QUICK_WORK_TITLE = 'Greita veikla (Automatiškai išsaugota)'; // mirror sessionActions.js
const DEFAULT_TASK_PRIORITY = 'MEDIUM';            // mirror src/utils/priority.js DEFAULT_PRIORITY
const MIN_LOGGED_SECONDARY_MINUTES = 1;            // mirror src/utils/timeUtils.js MIN_LOGGED_SESSION_MINUTES
const SECONDARY_MANAGER_ROLES = ['manager', 'admin', 'seniorManager', 'Administratorius']; // mirror isManagerRole (+ legacy)

// Mirror of the client clampSessionMinutes: a non-finite/negative delta collapses to 0; an
// implausibly large one is capped at the 16h ceiling (MAX_RUNNING_TIMER_MINUTES).
function clampSecondaryMinutes(min) {
    if (!Number.isFinite(min) || min < 0) return 0;
    return Math.min(min, MAX_RUNNING_TIMER_MINUTES);
}

// Vilnius "HH:MM" for the record description, matching the client's now.toLocaleTimeString('lt-LT').
function vilniusHHMM(d) {
    return new Intl.DateTimeFormat('lt-LT', {
        timeZone: 'Europe/Vilnius', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
}

// Admin-SDK mirror of the client getSecondarySession: resolve a live break/call/quick-work session
// from either the canonical activeSession or the legacy per-type flags. Tasks are NOT secondary.
function resolveSecondarySession(u) {
    const as = u.activeSession;
    if (as && (as.type === 'break' || as.type === 'call' || as.type === 'quickWork') && as.startTime) {
        return { type: as.type, startTime: as.startTime, customTitle: as.customTitle || null };
    }
    if (u.breakState && u.breakState.isTakingBreak && u.breakState.lastStartedAt) return { type: 'break', startTime: u.breakState.lastStartedAt };
    if (u.callState && u.callState.isCalling && u.callState.lastStartedAt) return { type: 'call', startTime: u.callState.lastStartedAt };
    if (u.quickWorkState && u.quickWorkState.isQuickWorking && u.quickWorkState.lastStartedAt) return { type: 'quickWork', startTime: u.quickWorkState.lastStartedAt };
    return null;
}

// Mirror of the client isAbandonedSession (src/hooks/useOrphanedSessionRecovery.js): abandoned when
// it crossed a Vilnius calendar day OR elapsed beyond the 16h single-session ceiling. A corrupt
// start is also treated as abandoned so a ghost with a broken timestamp cannot live forever (it
// credits 0 via the clamp). Otherwise the session is a legitimate same-day run — leave it alone.
function secondarySessionAbandoned(startIso, now) {
    const startMs = new Date(startIso).getTime();
    if (Number.isNaN(startMs)) return true;
    if (lithuanianDay(new Date(startMs)) !== lithuanianDay(now)) return true;
    if ((now.getTime() - startMs) / 60000 > MAX_RUNNING_TIMER_MINUTES) return true;
    return false;
}

// create() the doc only if absent — a re-fired scan recomputes the SAME deterministic id and hits
// ALREADY_EXISTS, which is the expected dedup path, not an error.
async function createIfAbsent(ref, data) {
    try {
        await ref.create(data);
    } catch (err) {
        if (err && (err.code === 6 || err.code === 'already-exists')) return;
        throw err;
    }
}

// Write the credited record(s) for one closed secondary session, mirroring handleLegacyLogging.
// The doc ids are pinned to (kind + uid + session start), a VERBATIM MIRROR of the client
// sessionActions.js handleLegacyLogging ids (sess_break_ / sess_call_task_ / sess_call_ws_ /
// sess_qw_task_ / sess_qw_ws_) — locked by firebaseConsistency.test.js. This is what makes the two
// independent closers idempotent against EACH OTHER: if the worker reopens the app at ~scan time,
// the client and this net both resolve the same session, but both write the SAME id, so only one
// row survives (create() here / setDoc on the client) — no double-credit.
async function writeSecondaryCloseRecords({ uid, userName, session, startMs, durationMinutes, date, nowIso, now, userData, canonicalRun = null }) {
    const startTime = session.startTime;
    const timeString = vilniusHHMM(now);

    if (session.type === 'break') {
        // Call and quick-work already key their ids on (uid + start) in BOTH engines, so those
        // dedupe as-is. A break does not: the revisioned engine keys its break row on the run
        // (closeBreakWrites → sess_break_run_{runId}), so when the engine owns this run the net must
        // use that id or the same break is credited twice under two ids that can never converge.
        const breakId = canonicalRun
            ? `sess_break_run_${canonicalRun.runId}`
            : `sess_break_${uid}_${startMs}`;
        await createIfAbsent(db.collection('break_sessions').doc(breakId), {
            userId: uid, userName, startTime, endTime: nowIso, durationMinutes, date,
            createdAt: nowIso, completedAt: nowIso, isBreak: true,
            ...(canonicalRun
                ? { runId: canonicalRun.runId, engineVersion: TIMER_ENGINE_VERSION }
                : {}),
        });
        return;
    }

    if (session.type === 'call') {
        // An abandoned call carries no contactType (it is chosen only at the stop screen), so the
        // title is the plain "Skambutis", exactly as buildCallTitle(null) yields on the client.
        const callTitle = 'Skambutis';
        await createIfAbsent(db.collection('tasks').doc(`sess_call_task_${uid}_${startMs}`), {
            title: callTitle, description: timeString, contactType: null,
            status: 'confirmed', priority: DEFAULT_TASK_PRIORITY,
            assignedUserId: uid, assignedUserName: userName,
            createdBy: uid, creatorName: userName,
            createdAt: nowIso, completedAt: nowIso, completed: true,
            confirmedBy: uid, confirmedAt: nowIso,
            manualMinutes: durationMinutes, isSystemTask: true,
        });
        await createIfAbsent(db.collection('work_sessions').doc(`sess_call_ws_${uid}_${startMs}`), {
            taskId: `call_${startMs}`, taskTitle: callTitle, contactType: null,
            userId: uid, userName, startTime, endTime: nowIso, durationMinutes, date,
            createdAt: nowIso, isSystemTask: true,
        });
        return;
    }

    if (session.type === 'quickWork') {
        // The worker was absent (never reopened to name it), so this is the auto-stopped, unnamed
        // path: placeholder title + autoStopped:true, routed to the worker's primary manager for
        // confirmation (managers/admins self-confirm). No completion notification (it would be noise
        // for an unnamed entry) — it can be described retroactively via the "describe later" banner.
        const title = session.customTitle || AUTO_STOPPED_QUICK_WORK_TITLE;
        const autoStopped = !session.customTitle;
        const isManager = SECONDARY_MANAGER_ROLES.includes(userData.role || 'worker');
        const routedManagerId = isManager ? null : (userData.defaultManager || null);
        const wsId = `sess_qw_ws_${uid}_${startMs}`;
        await createIfAbsent(db.collection('tasks').doc(`sess_qw_task_${uid}_${startMs}`), {
            title,
            description: session.customTitle ? timeString : `${timeString} (Automatiškai sukurtas)`,
            status: isManager ? 'confirmed' : 'completed', priority: DEFAULT_TASK_PRIORITY,
            assignedUserId: uid, assignedUserName: userName,
            createdBy: uid, creatorName: userName,
            createdAt: nowIso, completedAt: nowIso, completed: true,
            confirmedBy: isManager ? uid : null, confirmedAt: isManager ? nowIso : null,
            taskAuditor: routedManagerId, managerId: routedManagerId,
            manualMinutes: durationMinutes, isQuickWork: true, autoStopped, workSessionId: wsId,
        });
        await createIfAbsent(db.collection('work_sessions').doc(wsId), {
            taskId: `quick_${startMs}`, taskTitle: title,
            userId: uid, userName, startTime, endTime: nowIso, durationMinutes, date,
            createdAt: nowIso, isQuickWork: true,
        });
    }
}

// Scan every user for a genuinely-abandoned secondary session and close it, crediting the clamped
// time. Read-then-write per user; deterministic ids keep a retry idempotent. The user base is small
// (one company), so a full users scan once a day is cheap.
async function autoCloseForgottenSessions(scanErrors) {
    let snap;
    try {
        snap = await db.collection('users').get();
    } catch (err) {
        // A failed read here means this net did not run AT ALL — and its zeroed result is otherwise
        // indistinguishable from "no abandoned sessions", which the severity derivation would read as
        // clean. Recording it is what makes the scan's completeness verdict honest about this check.
        logger.warn('autoCloseForgottenSessions query failed', { err: err.message });
        noteScanError(scanErrors, 'autoCloseSessions:users', err);
        return { scanned: 0, closed: 0, samples: [] };
    }
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const date = lithuanianDay(now);
    let closed = 0;
    const samples = [];
    const audits = [];

    for (const docSnap of snap.docs) {
        const u = docSnap.data() || {};
        const session = resolveSecondarySession(u);
        if (!session) continue;
        if (!secondarySessionAbandoned(session.startTime, now)) continue; // legitimate same-day run

        const uid = docSnap.id;
        const startMs = new Date(session.startTime).getTime();
        const durationMinutes = clampSecondaryMinutes((nowMs - startMs) / 60000);
        const userName = u.displayName || 'Nežinomas';

        try {
            // Does the revisioned engine own this session? Probed BEFORE the close, because it picks
            // the ledger id, and retired AFTER it, so the record is never idled ahead of its credit.
            const canonicalMatch = { type: session.type, startIso: session.startTime };
            const probe = await readCanonicalRun(uid, canonicalMatch);
            // An UNREADABLE canonical record is not a legacy one. Choosing an engine on a guess picks
            // the ledger id, and the wrong id is what lets one physical interval be credited twice.
            // Leave this session for the next run; nothing here is time-critical.
            if (!probe.ok) {
                logger.warn('autoCloseForgottenSessions deferred — canonical state unreadable', { uid });
                continue;
            }
            const canonicalRun = probe.run;

            // (1) Credit the clamped time as a record (sub-minute taps are discarded, as on the client).
            if (durationMinutes > MIN_LOGGED_SECONDARY_MINUTES) {
                await writeSecondaryCloseRecords({ uid, userName, session, startMs, durationMinutes, date, nowIso, now, userData: u, canonicalRun });
            }
            // (2) Clear the live flags so the session no longer hangs (and the client won't re-close it).
            // We deliberately do NOT touch breakState.dailyAccumulatedMinutes: it is a display-only
            // counter (no report reads it) that useTimerState resets to 0 on a new day anyway, and an
            // abandoned break is almost always cross-day, so adding to "today's" total would be both
            // pointless (wiped on the worker's next open) and mis-attributed. The durable, report-read
            // truth is the break_sessions row written above.
            const updates = { activeSession: null };
            if (session.type === 'break') {
                updates['breakState.isTakingBreak'] = false;
            } else if (session.type === 'call') {
                updates['callState.isCalling'] = false;
            } else if (session.type === 'quickWork') {
                updates['quickWorkState.isQuickWorking'] = false;
            }
            await docSnap.ref.update(updates);

            // (3) Retire the canonical record for the same run. Clearing users/{uid}.activeSession
            // alone would leave active_sessions still claiming an active break/call/quick-work, and
            // every later transition is planned from that record — so the worker would be refused a
            // new session on a run the server had already closed.
            if (canonicalRun) {
                const outcome = await releaseCanonicalRun(uid, canonicalMatch);
                // The live flags are already cleared above, so this user no longer matches the scan's
                // own candidate test — nothing retries. Report the residue instead of losing it.
                if (outcome.error) noteScanError(scanErrors, `autoCloseForgottenSessions:release:${uid}`, outcome.error);
            }

            // Tell the worker their forgotten timer was auto-closed and time credited — so recovered
            // paid time is never an unexplained entry. Only when real time was logged (a sub-minute
            // orphan closes invisibly, mirroring the client recovery notice). One doc → bell + push.
            if (durationMinutes > MIN_LOGGED_SECONDARY_MINUTES) {
                try {
                    await db.collection('request_notifications').add({
                        recipientId: uid,
                        type: 'session_auto_closed',
                        category: 'info',
                        day: date,
                        isRead: false,
                        createdAt: nowIso,
                        createdBy: 'system_session_autoclose',
                    });
                } catch (err) {
                    logger.warn('autoCloseForgottenSessions notify failed', { uid, err: err.message });
                }
            }

            closed += 1;
            if (samples.length < SAMPLE_LIMIT) samples.push({ uid, type: session.type, durationMinutes: Math.round(durationMinutes) });
            audits.push({ uid, type: session.type, startIso: session.startTime, durationMinutes: Math.round(durationMinutes) });
        } catch (err) {
            logger.warn('autoCloseForgottenSessions close failed', { uid, type: session.type, err: err.message });
            noteScanError(scanErrors, `autoCloseForgottenSessions:close:${uid}`, err);
        }
    }

    // Audit each close under the SYSTEM actor (ADR 0015), keyed on (uid + start) so a retry dedups.
    for (const a of audits) {
        await appendSystemDecision(db, {
            idempotencyKey: `autoclose_${a.uid}_${a.startIso}`,
            command: 'integrity.autoCloseSession',
            source: 'dailyIntegrityScan',
            targetType: 'user',
            targetId: a.uid,
            reason: `Auto-closed an abandoned ${a.type} session (${a.durationMinutes} min, clamped ≤16h); credited as a logged record`,
            before: { activeSessionType: a.type, startTime: a.startIso },
            after: { activeSession: null, loggedMinutes: a.durationMinutes },
        });
    }

    return { scanned: snap.size, closed, samples };
}

// CROSS-STORE SESSION RECONCILIATION — the I/O half of classifySessionDisagreements. Report-only:
// it reads three collections and writes nothing. See the classifier for why the three stores can
// disagree and why this measures rather than repairs.
//
// Reads are scoped to what the claims actually reference: all users (the collection is small and is
// already read whole by autoCloseForgottenSessions), the running-task query the auto-stop net
// already uses, the canonical records, and then a batched lookup of ONLY the task ids somebody
// claims. A task that cannot be read is left out of taskStates entirely, which the classifier treats
// as unmeasurable rather than as a disagreement.
async function scanSessionDisagreements(scanErrors) {
    const empty = { checked: 0, count: 0, byKind: { staleUserRun: 0, multipleRunningTasks: 0, canonicalOrphanRun: 0 }, samples: [] };

    let userSnap;
    try {
        userSnap = await db.collection('users').get();
    } catch (err) {
        logger.warn('scanSessionDisagreements users query failed', { err: err.message });
        noteScanError(scanErrors, 'sessionDisagreements:users', err);
        return empty;
    }
    const users = userSnap.docs.map((d) => {
        const u = d.data() || {};
        return { id: d.id, activeSession: u.activeSession, workStatus: u.workStatus };
    });

    let runningTasks = [];
    try {
        const snap = await db.collection('tasks').where('timerStatus', '==', 'running').get();
        runningTasks = snap.docs.map((d) => {
            const t = d.data() || {};
            return { id: d.id, assignedUserId: t.assignedUserId || null, timerStartedAt: t.timerStartedAt || null };
        });
    } catch (err) {
        logger.warn('scanSessionDisagreements running-task query failed', { err: err.message });
        noteScanError(scanErrors, 'sessionDisagreements:runningTasks', err);
        return empty;
    }

    let canonicalRecords = [];
    try {
        const snap = await db.collection('active_sessions').where('status', '==', 'active').get();
        canonicalRecords = snap.docs.map((d) => {
            const r = d.data() || {};
            return { uid: d.id, status: r.status, run: r.run };
        });
    } catch (err) {
        // The engine is live for a couple of workers, so this collection is normally tiny or empty.
        // A failure still counts against completeness rather than passing as "no canonical runs".
        logger.warn('scanSessionDisagreements canonical query failed', { err: err.message });
        noteScanError(scanErrors, 'sessionDisagreements:canonical', err);
    }

    // Every task id somebody claims is running — from the user documents and the canonical records.
    // The running-task query already carries its own state, so those ids need no second read.
    const claimedIds = new Set();
    for (const u of users) {
        const claim = claimedTaskRun(u);
        if (claim) claimedIds.add(claim.taskId);
    }
    for (const rec of canonicalRecords) {
        if (rec.run && rec.run.type === 'task' && rec.run.taskId) claimedIds.add(rec.run.taskId);
    }
    const taskStates = new Map();
    for (const task of runningTasks) taskStates.set(task.id, { exists: true, timerStatus: 'running' });
    const toFetch = [...claimedIds].filter((id) => !taskStates.has(id));
    for (let i = 0; i < toFetch.length; i += 300) {
        const chunk = toFetch.slice(i, i + 300);
        try {
            const docs = await db.getAll(...chunk.map((id) => db.collection('tasks').doc(id)));
            docs.forEach((d) => {
                const t = d.exists ? (d.data() || {}) : null;
                taskStates.set(d.id, { exists: d.exists, timerStatus: t ? (t.timerStatus || null) : null });
            });
        } catch (err) {
            // Leave the chunk OUT of taskStates: unknown, therefore not a finding.
            logger.warn('scanSessionDisagreements task getAll failed', { err: err.message });
            noteScanError(scanErrors, 'sessionDisagreements:tasks', err);
        }
    }

    return classifySessionDisagreements({
        users,
        runningTasks,
        canonicalRecords,
        taskStates,
        nowMs: Date.now(),
    });
}

// Surface (do NOT mutate) non-terminal tasks sitting unfinished beyond STALE_TASK_DAYS — the
// backlog the data found (91 tasks >14d, oldest 'pending' 159d). Report-only: a manager decides to
// finish, reassign, or drop them. createdAt is an ISO string, so the cutoff compares lexically.
async function scanStaleTasks(scanErrors) {
    const cutoffIso = new Date(Date.now() - STALE_TASK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    let snap;
    try {
        snap = await db.collection('tasks').where('status', 'in', STALE_STATUSES).get();
    } catch (err) {
        // Same reasoning as autoCloseForgottenSessions: a swallowed failure here reports an empty
        // backlog, which reads as good news rather than as no news.
        logger.warn('scanStaleTasks query failed', { err: err.message });
        noteScanError(scanErrors, 'staleTasks:query', err);
        return { count: 0, samples: [] };
    }
    let count = 0;
    const samples = [];
    snap.forEach((docSnap) => {
        const t = docSnap.data();
        if (t.isDeleted || !t.createdAt || t.createdAt >= cutoffIso) return;
        count += 1;
        if (samples.length < SAMPLE_LIMIT) samples.push({ id: docSnap.id, status: t.status, createdAt: t.createdAt });
    });
    return { count, samples };
}

exports.dailyIntegrityScan = onSchedule(
    { schedule: 'every day 06:00', timeZone: 'Europe/Vilnius' },
    async () => {
        const nowIso = new Date().toISOString();
        const day = lithuanianDay(new Date()); // reuse the Vilnius-day formatter defined above
        // Anything that stopped this run from seeing the whole picture. Collected, not swallowed —
        // see the severity derivation below for why an incomplete scan must never read as clean.
        const scanErrors = [];

        // (1) Volume canary — compare current counts against the previous stored snapshot.
        const counts = {};
        await Promise.all(MONITORED_COLLECTIONS.map(async (name) => {
            counts[name] = await collectionCount(name, scanErrors);
        }));
        const countsRef = db.collection('integrity_reports').doc('_counts');
        const prevSnap = await countsRef.get();
        const prev = prevSnap.exists ? (prevSnap.data().counts || {}) : {};
        const drops = [];
        MONITORED_COLLECTIONS.forEach((name) => {
            const before = prev[name];
            const after = counts[name];
            if (typeof before === 'number' && typeof after === 'number' && before > 0 &&
                after < before * (1 - DROP_ALERT_RATIO)) {
                drops.push({ collection: name, before, after, lost: before - after });
            }
        });

        // (2) Anomaly scan over recently-created sessions.
        const anomalyReport = {};
        let totalAnomalies = 0;
        for (const name of ['work_sessions', 'break_sessions']) {
            const r = await scanSessionAnomalies(name, scanErrors);
            anomalyReport[name] = r;
            totalAnomalies += r.anomalies;
        }

        // (2b) Additive-corruption scan — same lookback window, catches duplicated/overlapping
        //      rows that (2) cannot see because no single row is out of range.
        const dailyOverdraft = await scanDailyOverdraft(scanErrors);

        // (2c) Credit-integrity — orphaned task-credit rows + moderate work-day inflation the (2b)
        //      24h wire misses (ADR 0021 R-04 compensating-control tightening). Report-only.
        const creditIntegrity = await scanCreditIntegrity(scanErrors);

        // (3) Task timer integrity — stop forgotten running timers, and surface the stale backlog.
        const autoStoppedTimers = await autoStopForgottenTimers(scanErrors);
        // (3b) Secondary-session integrity — close abandoned break/call/quick-work sessions the
        //      client resume logic deliberately leaves running until the worker reopens.
        const autoClosedSessions = await autoCloseForgottenSessions(scanErrors);
        // (3c) Cross-store reconciliation — do users/, tasks/ and active_sessions/ agree about who is
        //      working right now? Runs AFTER the two auto-repair nets on purpose: they settle what
        //      they can first, so what this reports is the residue they left behind rather than work
        //      still in flight. Report-only.
        const sessionDisagreements = await scanSessionDisagreements(scanErrors);
        const staleBacklog = await scanStaleTasks(scanErrors);

        // COMPLETENESS IS PART OF THE VERDICT. Severity used to be derived purely from what the scan
        // FOUND, so a run whose reads had failed reported 'ok' — the one word an operator reads as
        // "the ledger is fine". That is the worst possible failure mode for a control ADR 0021 names
        // as the compensating check for accepted risk R-04: real corruption and a transient backend
        // fault at the same time produced a clean bill of health. An incomplete run is now at least a
        // warning, and says so explicitly, so "clean" only ever means "looked everywhere and found
        // nothing".
        const complete = scanErrors.length === 0;
        const critical = drops.length > 0;
        const warning = !complete || totalAnomalies > 0 || dailyOverdraft.offenders > 0 ||
            creditIntegrity.orphan.orphans > 0 || creditIntegrity.suspicious.count > 0 ||
            creditIntegrity.serverSpan.count > 0 || creditIntegrity.counterDrift.drifted > 0 ||
            autoStoppedTimers.stopped > 0 || autoStoppedTimers.deferred > 0 ||
            autoClosedSessions.closed > 0 || sessionDisagreements.count > 0;
        const report = {
            day,
            ranAt: nowIso,
            severity: critical ? 'critical' : (warning ? 'warning' : 'ok'),
            complete,
            scanErrors,
            counts,
            drops,
            anomalies: anomalyReport,
            totalAnomalies,
            dailyOverdraft,
            creditIntegrity,
            autoStoppedTimers,
            autoClosedSessions,
            sessionDisagreements,
            staleBacklog
        };

        try {
            await db.collection('integrity_reports').doc(day).set(report, { merge: true });
            // Persist ONLY the counts that were actually measured. A failed count returns null, and
            // writing that null replaced the previous day's real number with a non-number — which the
            // drop comparison then skips, quietly disarming the mass-delete canary for the following
            // run as well. Keeping the last known-good value means one failed count costs one day of
            // comparison, not two, and never destroys the baseline it is supposed to be compared to.
            const measured = {};
            MONITORED_COLLECTIONS.forEach((name) => {
                if (typeof counts[name] === 'number') measured[name] = counts[name];
            });
            await countsRef.set({ counts: measured, updatedAt: nowIso }, { merge: true });
        } catch (err) {
            logger.error('dailyIntegrityScan write failed', { err: err.message });
        }

        if (critical) {
            logger.error('INTEGRITY: volume drop detected — possible data loss', { drops, counts });
        } else if (warning) {
            logger.warn('INTEGRITY: anomalies / auto-stops detected', { totalAnomalies, anomalyReport, autoStoppedTimers });
        } else {
            logger.info('INTEGRITY: clean', { counts });
        }
        if (!complete) {
            logger.error('INTEGRITY: scan INCOMPLETE — coverage gaps, do not read this run as clean', { scanErrors });
        }
        if (dailyOverdraft.offenders > 0) {
            logger.warn('INTEGRITY: user-day overdraft (>24h combined session minutes) — possible duplicate rows', dailyOverdraft);
        }
        if (creditIntegrity.orphan.orphans > 0) {
            logger.warn('INTEGRITY: orphaned task-credit rows — work_sessions referencing no real task', creditIntegrity.orphan);
        }
        if (creditIntegrity.suspicious.count > 0) {
            logger.warn('INTEGRITY: suspicious work-day total (>16h work, <24h) — possible moderate inflation', creditIntegrity.suspicious);
        }
        if (creditIntegrity.counterDrift.drifted > 0) {
            logger.warn('INTEGRITY: task counter disagrees with the session ledger after a correction — the card/earnings total is stale, work_sessions is canonical', creditIntegrity.counterDrift);
        }
        if (creditIntegrity.serverSpan.count > 0) {
            logger.warn('INTEGRITY: session credits more work than the SERVER has seen its task exist — clock-independent inflation signal', creditIntegrity.serverSpan);
        }
        // Migration telemetry (ADR-0020 step 6): report the revisioned-engine adoption baseline every
        // run, so the legacy-drain trend is visible before retiring the legacy write sites (roadmap P8).
        logger.info('INTEGRITY: engine adoption (work_sessions engineVersion==2 share)', creditIntegrity.engineAdoption);
        if (autoStoppedTimers.stopped > 0) logger.warn('INTEGRITY: auto-stopped forgotten timers', autoStoppedTimers);
        if (autoClosedSessions.closed > 0) logger.warn('INTEGRITY: auto-closed abandoned secondary sessions', autoClosedSessions);
        if (sessionDisagreements.count > 0) {
            logger.warn('INTEGRITY: session stores disagree about who is working — user doc vs task vs canonical record', sessionDisagreements);
        }
        if (staleBacklog.count > 0) logger.info('INTEGRITY: stale backlog surfaced', { count: staleBacklog.count });
    }
);

// ---------------------------------------------------------------------------
// Recurring tasks — scheduled generator + on-demand "run now"
// ---------------------------------------------------------------------------
//
// A task_template may carry a `recurrence` descriptor (see src/utils/recurrence.js). Each morning
// generateRecurringTasks materializes a real task in `tasks` for every active rule that fires today
// (Vilnius). IDEMPOTENT: the generated task's id is deterministic (`rec_<templateId>_<YYYY-MM-DD>`),
// so a retry, redeploy, OR a manual "run now" can never double-create — the prior 247-corrupt-
// break_sessions incident is exactly the unguarded-write class this design forecloses. Each task
// carries `sourceTemplateId` + `generatedForDate` (the provenance the data analysis had to infer).
//
// ABSENCE: if the baked assignee is on an absence (work_hours.isVacation) that buckets to the target
// day, the task is STILL created (the work isn't lost) but flagged `needsReassignment` and the
// template's manager is notified to assign someone else (request_notifications → FCM push + in-app).
//
// The created task is a normal `tasks` doc, so stampTeamOnTaskWrite denormalizes its teamManagerIds
// and the approval/timer/archival flows all work unchanged — this generator reuses, it doesn't fork.

// Canonical UPPERCASE priority — MIRROR of src/utils/priority.js normalizePriority.
const RECURRING_PRIORITIES = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
function normalizeRecurringPriority(p) {
    const up = String(p || '').toUpperCase();
    return RECURRING_PRIORITIES.includes(up) ? up : 'MEDIUM';
}

// Parse a free-text estimate to minutes — MIRROR of src/utils/timeUtils.js parseTimeStringToMinutes
// (handles comma decimals "1,5h" and the Lithuanian "val" suffix). Keep in lockstep.
function parseEstimateMinutes(str) {
    if (!str || typeof str !== 'string') return 0;
    const norm = str.trim().toLowerCase().replace(',', '.');
    const m = norm.match(/^(?:(\d+(?:\.\d+)?)\s*(?:h|val))?\s*(?:(\d+)\s*(?:m|min))?$/);
    if (!m) return 0;
    let total = 0;
    const hours = m[1] ? parseFloat(m[1]) : 0;
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    if (Number.isFinite(hours) && hours >= 0) total += hours * 60;
    if (Number.isFinite(mins) && mins >= 0) total += mins;
    return Number.isFinite(total) ? total : 0;
}

function recurringIsoWeekday(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    if (!y || !m || !d) return null;
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return dow === 0 ? 7 : dow;
}
function recurringDaysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
// MIRROR of src/utils/recurrence.js weekIndex — Monday-aligned absolute week index.
function recurringWeekIndex(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    if (!y || !m || !d) return null;
    const dayNum = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
    return Math.floor((dayNum + 3) / 7);
}
// MIRROR of src/utils/recurrence.js recurrenceFiresOn — keep both copies identical.
function recurringFiresOn(recurrence, dateStr) {
    if (!recurrence || recurrence.active === false) return false;
    if (Array.isArray(recurrence.skipDates) && recurrence.skipDates.includes(dateStr)) return false;
    const wd = recurringIsoWeekday(dateStr);
    if (!wd) return false;
    switch (recurrence.freq) {
        case 'daily':
            return true;
        case 'weekly': {
            if (!Array.isArray(recurrence.byWeekday) || !recurrence.byWeekday.includes(wd)) return false;
            const interval = Math.floor(Number(recurrence.interval) || 1);
            if (interval <= 1 || !recurrence.anchorDate) return true;
            const wi = recurringWeekIndex(dateStr);
            const ai = recurringWeekIndex(recurrence.anchorDate);
            if (wi == null || ai == null) return true;
            return (((wi - ai) % interval) + interval) % interval === 0;
        }
        case 'monthly': {
            const [y, m, d] = dateStr.split('-').map(Number);
            const target = Math.min(recurrence.byMonthDay || 1, recurringDaysInMonth(y, m));
            return d === target;
        }
        default:
            return false;
    }
}

// Is the user on an absence (any kind) that buckets to the given Vilnius day? Reads work_hours by
// userId (the automatic single-field index) and checks isVacation (the absence gate). Off the hot
// path (only at generation time), so the client-side day-bucket filter is fine.
async function isUserAbsentOn(uid, dayStr) {
    if (!uid) return false;
    try {
        const snap = await db.collection('work_hours').where('userId', '==', uid).get();
        let absent = false;
        snap.forEach((d) => {
            const wh = d.data();
            if (!wh || wh.isVacation !== true || !wh.start) return;
            if (lithuanianDay(new Date(wh.start)) === dayStr) absent = true;
        });
        return absent;
    } catch (err) {
        logger.warn('isUserAbsentOn failed', { uid, err: err.message });
        return false;
    }
}

// Materialize one template's task for `dayStr` (Vilnius). Idempotent via the deterministic id.
// `force` (run-now) bypasses the fires-today / paused checks so a manager can fire on demand.
async function generateOneRecurring(templateId, template, dayStr, force, source) {
    const recurrence = template.recurrence || null;
    if (!force) {
        if (!recurrence) return { created: false, reason: 'no-recurrence' };
        if (recurrence.active === false) return { created: false, reason: 'paused' };
        if (!recurringFiresOn(recurrence, dayStr)) return { created: false, reason: 'not-due' };
    }

    const data = template.data || {};
    const assignee = data.assignedUserId || data.assignedWorkerId || '';
    const managerId = data.managerId || template.createdBy || null;

    // Resolve the assignee's display name (the app denormalizes assignedUserName onto task rows).
    let assignedUserName = '';
    if (assignee) {
        try {
            const us = await db.collection('users').doc(assignee).get();
            if (us.exists) assignedUserName = us.data().displayName || us.data().email || '';
        } catch (err) {
            logger.warn('recurring assignee name lookup failed', { assignee, err: err.message });
        }
    }

    const absent = assignee ? await isUserAbsentOn(assignee, dayStr) : false;

    // Deterministic id → at most one task per template per Vilnius day, no matter how many runs.
    const taskId = `rec_${templateId}_${dayStr}`;
    const ref = db.collection('tasks').doc(taskId);

    const result = await db.runTransaction(async (tx) => {
        const existing = await tx.get(ref);
        if (existing.exists) return { created: false, deduped: true, taskId };

        const nowIso = new Date().toISOString();
        const task = {
            title: data.title || template.templateName || 'Pasikartojanti veikla',
            description: data.description || '',
            priority: normalizeRecurringPriority(data.priority),
            estimatedTime: data.estimatedTime || '',
            estimatedTimeMinutes: parseEstimateMinutes(data.estimatedTime || ''),
            assignedUserId: assignee,
            assignedUserName,
            managerId,
            taskAuditor: managerId,
            tag: data.tag || '',
            links: Array.isArray(data.links) ? data.links : [],
            checklist: Array.isArray(data.checklist) ? data.checklist : [],
            comments: [],
            status: 'pending',
            completed: false,
            createdAt: nowIso,
            createdBy: 'system_recurring',
            creatorName: 'Pasikartojanti veikla',
            assignedAt: nowIso,
            updatedAt: nowIso,
            // Provenance — makes recurring-vs-adhoc reporting exact instead of inferred.
            sourceTemplateId: templateId,
            generatedForDate: dayStr,
            isRecurringInstance: true,
            ...(absent ? { needsReassignment: true, reassignReason: 'assignee-absent' } : {}),
        };
        tx.set(ref, task);
        return { created: true, taskId, needsReassignment: absent };
    });

    // Audit the automatic creation under the SYSTEM actor (ADR 0015) — populate the decision_log
    // event spine with real system-job traffic so the human/agent/system audit surface is exercised
    // (and validatable) before agents go live. Best-effort: never aborts the already-applied create.
    if (result.created) {
        await appendSystemDecision(db, {
            idempotencyKey: `gen_${result.taskId}`,
            command: 'recurring.generate',
            source: source || 'generateRecurringTasks',
            targetType: 'task',
            targetId: result.taskId,
            reason: `Recurring template ${templateId} materialized a task for ${dayStr}`
                + (result.needsReassignment ? ' (assignee absent — flagged for reassignment)' : ''),
            before: null,
            after: {
                title: data.title || template.templateName || 'Pasikartojanti veikla',
                assignedUserId: assignee || null,
                priority: normalizeRecurringPriority(data.priority),
                generatedForDate: dayStr,
                needsReassignment: !!result.needsReassignment,
            },
        });
    }

    // Notify the manager to reassign when the usual assignee is away (outside the transaction).
    if (result.created && result.needsReassignment && managerId) {
        try {
            await db.collection('request_notifications').add({
                recipientId: managerId,
                type: 'recurring_reassign',
                taskId: result.taskId,
                taskTitle: data.title || template.templateName || 'Pasikartojanti veikla',
                userId: assignee,
                isRead: false,
                createdAt: new Date().toISOString(),
                createdBy: 'system_recurring',
            });
        } catch (err) {
            logger.warn('recurring reassign notify failed', { templateId, err: err.message });
        }
    }
    return result;
}

exports.generateRecurringTasks = onSchedule(
    // 05:00 Vilnius — before the managers' ~09:00 creation peak, after the 03:00 work-day flip.
    { schedule: 'every day 05:00', timeZone: 'Europe/Vilnius' },
    async () => {
        const dayStr = lithuanianDay(new Date());
        let scanned = 0;
        let created = 0;
        let deduped = 0;
        let reassign = 0;

        let snap;
        try {
            snap = await db.collection('task_templates').get(); // small collection — full scan is fine
        } catch (err) {
            logger.error('generateRecurringTasks list failed', { err: err.message });
            return;
        }

        for (const docSnap of snap.docs) {
            const template = docSnap.data();
            const recurrence = template.recurrence;
            if (!recurrence || recurrence.active === false) continue;
            if (!recurringFiresOn(recurrence, dayStr)) continue;
            scanned += 1;
            try {
                const r = await generateOneRecurring(docSnap.id, template, dayStr, false, 'generateRecurringTasks');
                if (r.created) {
                    created += 1;
                    if (r.needsReassignment) reassign += 1;
                    // Observability only (the deterministic id, not this field, is the dedup).
                    await docSnap.ref.update({ 'recurrence.lastGeneratedDate': dayStr }).catch(() => {});
                } else if (r.deduped) {
                    deduped += 1;
                }
            } catch (err) {
                logger.error('generateRecurringTasks one failed', { id: docSnap.id, err: err.message });
            }
        }

        logger.info('generateRecurringTasks done', { dayStr, scanned, created, deduped, reassign });
    }
);

// On-demand "Sukurti dabar" — the manager's manual trigger over the SAME generation logic (shared
// dedup / provenance / absence-notify). Manager+ only. force=true so it fires regardless of the
// rule's schedule/pause, but the deterministic id still prevents a same-day duplicate.
exports.runRecurringTasksNow = onCall(async (request) => {
    const callerUid = request.auth && request.auth.uid;
    // Active manager+ only — a blocked ex-manager kept a valid ID token and a role:'manager' doc,
    // so a role-only gate still let them inject real tasks onto the live board via the admin SDK.
    await assertActiveCaller(callerUid, ['admin', 'Administratorius', 'manager', 'seniorManager']);
    const templateId = request.data && request.data.templateId;
    if (!templateId) throw new HttpsError('invalid-argument', 'templateId required.');

    const tSnap = await db.collection('task_templates').doc(templateId).get();
    if (!tSnap.exists) throw new HttpsError('not-found', 'Template not found.');

    const dayStr = lithuanianDay(new Date());
    try {
        return await generateOneRecurring(templateId, tSnap.data(), dayStr, true, 'runRecurringTasksNow');
    } catch (err) {
        logger.error('runRecurringTasksNow failed', { templateId, err: err.message });
        throw new HttpsError('internal', 'Generation failed.');
    }
});

// ---------------------------------------------------------------------------
// Deadline priority escalation — scheduled (moved server-side from the client)
// ---------------------------------------------------------------------------
//
// This WAS a browser-side once-per-day pass (src/utils/automationUtils.checkAndPromoteTasks) gated
// to whole-team admins/managers — so on any day nobody with that role opened the app, NOTHING was
// escalated, and even when it ran it NEVER told the worker. Moving it to a schedule makes it
// deterministic AND lets it notify the assignee, which a same-origin client write could not do
// reliably (the worker is rarely the one running the pass).
//
// Buckets (Vilnius calendar days, lexically comparable — MIRROR of the old client logic):
//   • deadline today / tomorrow / overdue  → URGENT (Skubus)
//   • deadline the day after tomorrow       → HIGH   (Aukštas)
//   • 3+ days out                           → untouched
// Only ever RAISES priority, and only past the canonical current value, so a task already at (or
// above) the target is skipped. That guard is also the idempotency net: a Cloud Scheduler retry
// re-scans, finds the task already escalated, and re-notifies nothing.

// Add whole calendar days to a YYYY-MM-DD string — MIRROR of src/utils/timeUtils addDaysToDateString
// (pure UTC calendar arithmetic, DST-independent). Day strings sort lexically, so the buckets above
// are plain string comparisons against today±N.
function addDaysToDayStr(dayStr, days) {
    const [y, m, d] = dayStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// User-facing Lithuanian labels for the only two priorities this job assigns — MIRROR of the
// matching PRIORITY_CONFIG labels in src/utils/priority.js. Stamped onto the notification doc so the
// in-app copy and the push MIRROR both read one field (no priority→label map needed on either side).
const ESCALATION_LABELS = { URGENT: 'Skubus', HIGH: 'Aukštas' };

// ---------------------------------------------------------------------------
// Daily archiving — sweep confirmed/deleted tasks into `archived_tasks`
// ---------------------------------------------------------------------------
//
// This is a RUNTIME PORT, not a new behaviour: the same sweep already exists in the browser
// (src/utils/automationUtils.js → archiveOldTasks), and it is deleted in the same change that adds
// this. The rule, the statuses and the work-day boundary are carried over unchanged; only the
// trigger moves.
//
// WHY IT HAD TO MOVE. The browser version ran behind a localStorage once-per-day latch, so it fired
// only when an admin or unscoped manager happened to open the app on a browser whose storage had not
// already recorded today. Nobody opens the app → nothing archives → Istorija quietly stops filling
// and the active lists keep growing, with no error anywhere. Priority escalation was moved server-
// side for exactly this reason (escalateTaskPriorities below); this is the other half of that same
// client automation finally following it.
//
// ONE BATCH PER TASK-GROUP, and that is a correctness requirement rather than an optimisation. The
// client wrote the archive copy and deleted the original as two sequential calls, and
// cleanupAttachmentsOnTaskDelete permanently deletes a task's Storage objects when it finds no
// archived sibling. A create that lands without its delete merely leaves the task to be swept again
// tomorrow; a delete that lands without its create destroys completion photos irrecoverably. Both
// writes therefore commit together or not at all.

exports.archiveFinishedTasks = onSchedule(
    // 05:30 Vilnius — after the 05:00 work-day boundary has rolled (so "yesterday" is settled) and
    // after the 05:00 recurring generator, but before the 06:00 integrity scan, so the day's counts
    // are measured against a swept collection rather than mid-sweep.
    { schedule: 'every day 05:30', timeZone: 'Europe/Vilnius' },
    async () => {
        const now = new Date();
        const currentDay = currentWorkDay(now);
        const nowIso = now.toISOString();

        // Same two source sets as the client sweep: confirmed tasks, plus tasks soft-deleted with
        // their work hours kept. 'completed' is deliberately NOT included — a completed task is still
        // waiting to be accepted and must stay in the active pipeline.
        const candidates = new Map();
        for (const [field, value] of [['status', 'confirmed'], ['isDeleted', true]]) {
            try {
                const snap = await db.collection('tasks').where(field, '==', value).get();
                snap.forEach((d) => candidates.set(d.id, { id: d.id, ...d.data() }));
            } catch (err) {
                // Abandon the whole run rather than sweep a partial view: archiving is a move, and a
                // half-seen candidate set is not dangerous, just incomplete. Tomorrow re-runs it.
                logger.error('archiveFinishedTasks query failed', { field, err: err.message });
                return;
            }
        }

        const due = [...candidates.values()].filter((t) => taskArchivable(t, currentDay));
        if (due.length === 0) {
            logger.info('ARCHIVE: nothing due', { currentDay, candidates: candidates.size });
            return;
        }

        // 2 writes per task; the Firestore batch ceiling is 500 operations.
        const CHUNK = 200;
        let archived = 0;
        const failures = [];
        for (let i = 0; i < due.length; i += CHUNK) {
            const chunk = due.slice(i, i + CHUNK);
            const batch = db.batch();
            for (const task of chunk) {
                const { id, ...data } = task;
                batch.set(db.collection('archived_tasks').doc(id), {
                    ...data,
                    archivedAt: nowIso,
                    archivedBy: 'system_automation',
                });
                batch.delete(db.collection('tasks').doc(id));
            }
            try {
                await batch.commit();
                archived += chunk.length;
            } catch (err) {
                // A failed batch changed nothing (batches are atomic), so the tasks simply stay put
                // and the next run retries them. Recorded so a chunk that keeps failing is visible.
                logger.error('archiveFinishedTasks batch failed', { size: chunk.length, err: err.message });
                failures.push({ size: chunk.length, error: err.message });
            }
        }

        logger.info('ARCHIVE: swept finished tasks', {
            currentDay, archived, due: due.length, failures: failures.length,
        });
    }
);

exports.escalateTaskPriorities = onSchedule(
    // 04:30 Vilnius — after the 03:00 work-day flip, before the 05:00 recurring generator and the
    // managers' ~09:00 creation peak, so a freshly-urgent task is escalated before the day starts.
    { schedule: 'every day 04:30', timeZone: 'Europe/Vilnius' },
    async () => {
        const todayStr = lithuanianDay(new Date());
        const dayAfterTomorrowStr = addDaysToDayStr(todayStr, 2); // today+2
        const threeDaysStr = addDaysToDayStr(todayStr, 3);        // today+3

        let snap;
        try {
            // Same status set as the old client pass: not-yet-finished work that still warrants a
            // deadline-driven bump. The single-field `status in` query needs no composite index.
            snap = await db.collection('tasks')
                .where('status', 'in', ['pending', 'in-progress', 'approved']).get();
        } catch (err) {
            logger.error('escalateTaskPriorities query failed', { err: err.message });
            return;
        }

        let escalated = 0;
        let notified = 0;

        for (const docSnap of snap.docs) {
            const t = docSnap.data();
            if (!t.deadline) continue;

            const deadlineDate = new Date(t.deadline);
            if (Number.isNaN(deadlineDate.getTime())) continue;
            const deadlineStr = lithuanianDay(deadlineDate); // bucket to its Vilnius calendar day

            // Compare against the CANONICAL priority (data carries mixed casing historically), so an
            // already-urgent task is not re-written or re-notified on every run.
            const current = normalizeRecurringPriority(t.priority);
            let target = null;
            if (deadlineStr < dayAfterTomorrowStr) {
                if (current !== 'URGENT') target = 'URGENT';
            } else if (deadlineStr < threeDaysStr) {
                if (current !== 'URGENT' && current !== 'HIGH') target = 'HIGH';
            }
            if (!target) continue;

            const nowIso = new Date().toISOString();
            try {
                await docSnap.ref.update({ priority: target, updatedAt: nowIso });
                escalated += 1;
            } catch (err) {
                logger.warn('escalateTaskPriorities update failed', { taskId: docSnap.id, err: err.message });
                continue; // don't notify about an escalation that did not actually land
            }

            // Tell the assignee their task got more urgent: one request_notifications doc drives the
            // in-app toast + bell row AND the FCM push (via notifyOnRequestNotification). Best-effort —
            // a notify failure never undoes the escalation, and the guard above keeps a retry quiet.
            const uid = t.assignedUserId;
            if (uid) {
                try {
                    await db.collection('request_notifications').add({
                        recipientId: uid,
                        type: 'task_priority_escalated',
                        category: 'info',
                        taskId: docSnap.id,
                        taskTitle: t.title || 'Veikla',
                        priorityLabel: ESCALATION_LABELS[target] || '',
                        isRead: false,
                        createdAt: nowIso,
                        // Provenance: a system-authored notice (no human actor). The admin SDK write
                        // bypasses the client provenance rule; this is for audit/readability.
                        createdBy: 'system_priority_escalation',
                    });
                    notified += 1;
                } catch (err) {
                    logger.warn('escalateTaskPriorities notify failed', { taskId: docSnap.id, err: err.message });
                }
            }
        }

        logger.info('escalateTaskPriorities done', { todayStr, escalated, notified });
    }
);

// ---------------------------------------------------------------------------
// Overdue-deadline oversight — tell the MANAGER when an unfinished task's deadline has passed.
// ---------------------------------------------------------------------------
//
// Runs once a day, just after the priority escalation. A task is overdue when its deadline day is
// strictly BEFORE today (Vilnius) and it is still unfinished (same not-done status set the
// escalation scans). The recipient is the TASK's manager (managerId) — oversight, not the worker.
//
// Re-notify guard: the task carries `overdueNotifiedFor = <deadline day>`. We notify once per
// deadline value, so a daily re-run does NOT re-ping; moving the deadline to a new (still-past) day
// re-arms it exactly once. The single-field `status in` query needs no composite index.
exports.notifyOverdueTasks = onSchedule(
    { schedule: 'every day 04:45', timeZone: 'Europe/Vilnius' },
    async () => {
        const todayStr = lithuanianDay(new Date());

        let snap;
        try {
            snap = await db.collection('tasks')
                .where('status', 'in', ['pending', 'in-progress', 'approved']).get();
        } catch (err) {
            logger.error('notifyOverdueTasks query failed', { err: err.message });
            return;
        }

        let notified = 0;
        for (const docSnap of snap.docs) {
            const t = docSnap.data();
            if (!t.deadline) continue;

            const deadlineDate = new Date(t.deadline);
            if (Number.isNaN(deadlineDate.getTime())) continue;
            const deadlineStr = lithuanianDay(deadlineDate);
            if (deadlineStr >= todayStr) continue;            // not past yet
            if (t.overdueNotifiedFor === deadlineStr) continue; // already pinged for this deadline

            const recipientId = t.managerId;
            if (!recipientId) continue;                        // no manager to inform

            const nowIso = new Date().toISOString();
            try {
                await db.collection('request_notifications').add({
                    recipientId,
                    type: 'task_overdue',
                    category: 'info',
                    taskId: docSnap.id,
                    taskTitle: t.title || 'Veikla',
                    isRead: false,
                    createdAt: nowIso,
                    createdBy: 'system_overdue',
                });
                // Latch on the deadline value so a daily re-run stays quiet (best-effort: a failed
                // notify above leaves the latch unset, so the next run retries).
                await docSnap.ref.update({ overdueNotifiedFor: deadlineStr });
                notified += 1;
            } catch (err) {
                logger.warn('notifyOverdueTasks notify failed', { taskId: docSnap.id, err: err.message });
            }
        }

        logger.info('notifyOverdueTasks done', { todayStr, notified });
    }
);

// ---------------------------------------------------------------------------
// AI task-draft parser — free-text → structured task (server-side, manager-only)
// ---------------------------------------------------------------------------
//
// Mirrors the GODSGLOOM AI pattern: the key NEVER touches the client — a callable forwards to
// OpenRouter (model google/gemini-2.5-flash) using a server-side secret. The model extracts a
// DRAFT only; the client opens it in the normal create flow for the manager to confirm, so AI
// never writes a task and the userId-pin / scoping rules are untouched. The assignee is resolved
// SERVER-side from the caller-supplied roster (the model returns a name, not an id, so it can't
// invent a user). Priority/estimate are run through the same canonicalizers as every other writer.

const OPENROUTER_API_KEY = defineSecret('OPENROUTER_API_KEY');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PARSE_MODEL = 'google/gemini-2.5-flash';
const MAX_PARSE_INPUT = 2000;
// MIRROR of ALL_TIMES in src/components/TaskModal.jsx — the canonical estimate chips. A model
// guess is clamped to this set so it always lands on a real chip; keep both copies in lockstep.
const ESTIMATE_SCALE = [
    '5min', '15min', '30min', '45min', '1h', '1,5h', '2h', '2,5h', '3h', '4h', '5h', '6h',
    '7,5h', '8h', '10h', '12,5h', '12h', '15h', '20h', '25h', '40h', '50h', '70h', '80h',
    '90h', '100h', '110h', '120h', '150h', '200h',
];
// Short common subset shown to the model as guidance for its guess (full set is clamped above).
const ESTIMATE_HINT = '15min, 30min, 45min, 1h, 1,5h, 2h, 3h, 4h, 6h, 8h';

// Accent-insensitive lowercase, for matching Lithuanian names regardless of inflection/diacritics.
function foldName(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Map the model's chosen assignee NAME back to a roster id — exact, then first-name, then contains.
// Returns '' when nothing matches confidently (the manager then picks), so a hallucinated name can
// never route to the wrong person.
function resolveAssigneeId(name, roster) {
    const target = foldName(name);
    if (!target || !Array.isArray(roster)) return '';
    const folded = roster.map((r) => ({ id: r.id, n: foldName(r.name) })).filter((r) => r.id && r.n);
    let hit = folded.find((r) => r.n === target);
    if (hit) return hit.id;
    const targetFirst = target.split(' ')[0];
    hit = folded.find((r) => r.n.split(' ')[0] === targetFirst);
    if (hit) return hit.id;
    hit = folded.find((r) => r.n.includes(target) || target.includes(r.n.split(' ')[0]));
    return hit ? hit.id : '';
}

exports.parseTaskDraft = onCall(
    { secrets: [OPENROUTER_API_KEY], timeoutSeconds: 30, memory: '256MiB' },
    async (request) => {
        const callerUid = request.auth && request.auth.uid;
        // Any ACTIVE signed-in user may request a DRAFT. Workers self-create tasks too, and this
        // callable never writes anything — the assignee is still resolved server-side from the
        // caller-supplied (client-scoped) roster, so it cannot invent a user. The previous
        // manager-only gate left the ✨ button visible to workers but ALWAYS failing for them
        // ("AI nepavyko"); opening the callable makes the button honest for everyone who can see it.
        // No role requirement, but the account must still be active: this call spends real money on
        // the OpenRouter API, and a blocked ex-employee holds a working ID token indefinitely.
        await assertActiveCaller(callerUid);
        const apiKey = OPENROUTER_API_KEY.value();
        if (!apiKey) throw new HttpsError('failed-precondition', 'AI not configured.');

        const text = String((request.data && request.data.text) || '').slice(0, MAX_PARSE_INPUT).trim();
        if (!text) throw new HttpsError('invalid-argument', 'No text provided.');
        const roster = Array.isArray(request.data && request.data.roster)
            ? request.data.roster.slice(0, 60)
            : [];
        const names = roster.map((r) => r.name).filter(Boolean);
        const today = lithuanianDay(new Date());

        const system =
            'Tu ištrauki VIENĄ darbo užduotį iš vadovo laisvo teksto (lietuvių kalba). Grąžink TIK ' +
            'JSON objektą su laukais: title (trumpas darbo pavadinimas BE vykdytojo/laiko/prioriteto ' +
            'žodžių), assigneeName (geriausiai atitinkantis vardas iš sąrašo arba ""), priority ' +
            '(vienas iš: URGENT, HIGH, MEDIUM, LOW), estimate (laikas TIK jei AIŠKIAI ' +
            'nurodytas tekste, pvz. "30min","1h","2h","1,5h"; kitaip ""), estimateGuess (jei laiko ' +
            'tekste NĖRA — tavo protingas spėjimas, kiek toks darbas užtruktų, VIENA reikšmė iš: ' +
            ESTIMATE_HINT + '; jei estimate užpildytas, palik ""), deadline (YYYY-MM-DD arba ""). ' +
            'Šiandien yra ' + today + ' (Europe/Vilnius), savaitė prasideda pirmadienį — "rytoj",' +
            '"poryt","pirmadienį" ir pan. paversk į konkrečią datą. Vykdytojų sąrašas: ' +
            (names.join(', ') || '(nėra)') + '. Jei prioritetas nenurodytas, naudok MEDIUM. ' +
            'Atsakyk TIK JSON, be jokio kito teksto.';

        const body = {
            model: PARSE_MODEL,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: text },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
            max_tokens: 300,
        };

        let resp;
        try {
            resp = await fetch(OPENROUTER_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://anti-gravity-projektai.pages.dev',
                    'X-Title': 'WORKZ task parser',
                },
                body: JSON.stringify(body),
            });
        } catch (e) {
            logger.error('parseTaskDraft fetch failed', { err: e.message });
            throw new HttpsError('unavailable', 'AI laikinai nepasiekiamas.');
        }

        if (!resp.ok) {
            const t = await resp.text().catch(() => '');
            logger.warn('parseTaskDraft non-OK', { status: resp.status, body: t.slice(0, 200) });
            if (resp.status === 429) throw new HttpsError('resource-exhausted', 'AI kvota viršyta.');
            throw new HttpsError('internal', 'AI grąžino klaidą.');
        }

        let json;
        try {
            json = await resp.json();
        } catch (e) {
            throw new HttpsError('internal', 'AI atsakymas netinkamas.');
        }
        const content = json && json.choices && json.choices[0] &&
            json.choices[0].message && json.choices[0].message.content;
        let parsed = {};
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            const m = String(content || '').match(/\{[\s\S]*\}/);
            if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = {}; } }
        }

        const estimate = typeof parsed.estimate === 'string' ? parsed.estimate.trim() : '';
        // A best-guess time is surfaced ONLY when nothing was stated, and only if it lands on a real
        // chip — the client prefers the manager's own history over this guess (history > guess).
        const guessRaw = typeof parsed.estimateGuess === 'string' ? parsed.estimateGuess.trim() : '';
        const estimatedGuess = (!estimate && ESTIMATE_SCALE.includes(guessRaw)) ? guessRaw : '';
        const deadline = (typeof parsed.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.deadline))
            ? parsed.deadline
            : '';
        return {
            title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '',
            assignedUserId: resolveAssigneeId(parsed.assigneeName, roster),
            priority: normalizeRecurringPriority(parsed.priority),
            estimatedTime: estimate,
            estimatedTimeMinutes: parseEstimateMinutes(estimate),
            estimatedGuess,
            deadline,
        };
    }
);
