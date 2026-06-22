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
    // double-fires. Data-only gives the SW (firebase-messaging-sw.js) one deterministic place to
    // render the BACKGROUND case. The FOREGROUND (tab-open) case is covered separately by the
    // app's Firestore listeners (an in-app toast — see ADR 0004), not an FCM onMessage handler.
    // All values must be strings.
    const resp = await getMessaging().sendEachForMulticast({
        tokens,
        data: {
            title: String(notification.title || 'WORKZ'),
            body: String(notification.body || ''),
            ...(data || {})
        },
        webpush: {
            // Honor the per-message deep link (the SW notificationclick reads data.link too).
            fcmOptions: { link: (data && data.link) || '/' }
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
        case 'new_comment': {
            // User-authored text crosses the app boundary onto the lockscreen — collapse
            // whitespace and clamp length so it can't be weaponised into a huge/multiline body.
            const snippet = n.commentText
                ? String(n.commentText).replace(/\s+/g, ' ').trim().slice(0, 100)
                : '';
            return { title: 'Naujas komentaras', body: snippet ? `${title}: ${snippet}` : title };
        }
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
            taskId: String(n.taskId || ''),
            // Per-event id → unique notification tag (so distinct alerts don't collapse).
            notifId: String(event.params.id),
            // Manager approvals/alerts surface under the team-tasks tab.
            link: '/?tab=tasks'
        });
    } catch (err) {
        logger.error('notifyOnRequestNotification failed', { err: err.message });
    }
});

exports.notifyOnCalendarRequest = onDocumentCreated('calendar_requests/{id}', async (event) => {
    const r = event.data && event.data.data();
    if (!r || !r.managerId || r.status !== 'pending') return;
    const who = r.userName || 'Vykdytojas';
    try {
        await sendToUser(r.managerId, { title: 'Kalendoriaus keitimo prašymas', body: who }, {
            type: 'calendar_request',
            // Per-event id → unique tag, so multiple pending requests don't collapse onto one slot.
            notifId: String(event.params.id),
            link: '/?tab=team-calendar'
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

const BADGES = {
    // Reliability
    follow_through: { name: 'Pabaigiu, ką pradedu', stat: 'completedTasks', thresholds: [1, 10, 40, 120] }, // R1
    steady_rhythm: { name: 'Pastovus ritmas', stat: 'workDays', thresholds: [5, 25, 75, 200] },             // R2 (high-water days)
    on_estimate: { name: 'Telpa į planą', stat: 'onEstimate', thresholds: [5, 20, 60, 150] },               // R3
    plans_ahead: { name: 'Planuoja iš anksto', stat: 'planAheadWeeks', thresholds: [2, 8, 20, 40] },        // R4 (high-water weeks)
    // Quality
    approved_craft: { name: 'Priimtas darbas', stat: 'confirmedTasks', thresholds: [3, 15, 50, 120] },      // Q1
    thorough: { name: 'Kruopštus', stat: 'thorough', thresholds: [3, 15, 40, 100] },                        // Q2
    hard_tasks: { name: 'Imasi sunkių', stat: 'hardTasks', thresholds: [3, 12, 30, 75] }                    // Q4
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
    return db.runTransaction(async (tx) => {
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
}

// Background push for a newly-reached tier. The FOREGROUND in-app toast is a client listener on
// the same subcollection (added with the profile phase); this is the closed-app case. Reuses the
// existing FCM sender, which honours the recipient's notification toggle.
async function announceBadge(uid, key, tier) {
    const badge = BADGES[key];
    try {
        await sendToUser(uid, { title: 'Naujas ženkliukas', body: `${badge.name}: ${TIER_NAMES[tier]}` }, {
            type: 'achievement',
            badgeId: key,
            tier: String(tier),
            notifId: `${key}:${tier}`,
            link: '/?tab=profile'
        });
    } catch (err) {
        logger.error('announceBadge failed', { uid, key, tier, err: err.message });
    }
}

// Simple counter badge: +1 to its stat field, then (re)grant the tier the new total reaches.
async function bumpAndGrant(uid, key) {
    const badge = BADGES[key];
    const ref = statsRef(uid);
    const count = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const next = ((snap.exists && snap.data()[badge.stat]) || 0) + 1;
        tx.set(ref, { [badge.stat]: next }, { merge: true });
        return next;
    });
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

// Task-finish badges. Two independent edges on a task update:
//   • completed false→true  → R1 follow_through, R3 on_estimate, Q2 thorough, Q4 hard_tasks
//   • status →'confirmed'    → Q1 approved_craft (a manager accepted the worker's work)
// Both can fire on the same update (a manager finishing sets completed+confirmed at once); the
// per-edge guards make each count exactly once even across separate complete-then-confirm steps.
exports.onTaskFinishedBadge = onDocumentUpdated('tasks/{id}', async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();
    if (!before || !after) return;
    const uid = after.assignedUserId;
    if (!uid) return;

    const justCompleted = before.completed !== true && after.completed === true;
    const justConfirmed = before.status !== 'confirmed' && after.status === 'confirmed';
    if (!justCompleted && !justConfirmed) return;

    try {
        if (justCompleted) {
            await bumpAndGrant(uid, 'follow_through');
            if (hasEstimate(after) && after.timeLimitReached !== true) await bumpAndGrant(uid, 'on_estimate');
            if (checklistAllDone(after.checklist)) await bumpAndGrant(uid, 'thorough');
            if (isHighPriority(after.priority)) await bumpAndGrant(uid, 'hard_tasks');
        }
        // Q1 counts a MANAGER sign-off — not a worker (in a manager role) confirming their own task.
        if (justConfirmed && after.confirmedBy && after.confirmedBy !== uid) {
            await bumpAndGrant(uid, 'approved_craft');
        }
    } catch (err) {
        logger.error('onTaskFinishedBadge failed', { uid, err: err.message });
    }
});

// R2 — "Pastovus ritmas": cumulative distinct work-DAYS. Quick-work/call sessions still count as
// a worked day; deletions and manual time corrections do not.
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
