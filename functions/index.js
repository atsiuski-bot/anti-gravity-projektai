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
    backdated_time_logged: 'info',
    task_priority_escalated: 'info',
    achievement: 'info',
    task_overdue: 'info',
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
        case 'backdated_time_logged': {
            // Trusted worker → admin: an approval-free backdated session was logged. Body = WHO + day.
            // userName is the only free-form field; clamp identically to the registry MIRROR.
            const name = n.userName ? String(n.userName).replace(/\s+/g, ' ').trim().slice(0, 100) : '';
            const day = n.day || 'Veiklos laikas';
            return { title: 'Įrašytas atbulinis laikas', body: name ? `${name} · ${day}` : day };
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
    try {
        await sendToUser(n.recipientId, { title, body }, {
            type: String(n.type || ''),
            taskId: String(n.taskId || ''),
            // Category rides along so the SW can render an 'action' push as requireInteraction
            // (desktop) without importing the client registry. MIRROR — see CATEGORY_BY_TYPE.
            category: CATEGORY_BY_TYPE[n.type] || 'info',
            // Per-event id → unique notification tag (so distinct alerts don't collapse).
            notifId: String(event.params.id),
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
            if (after.isQuickWork !== true) await bumpAndGrant(uid, 'follow_through');
            if (hasEstimate(after) && after.timeLimitReached !== true) await bumpAndGrant(uid, 'on_estimate');
            if (checklistAllDone(after.checklist)) await bumpAndGrant(uid, 'thorough');
            if (isHighPriority(after.priority)) await bumpAndGrant(uid, 'hard_tasks');
        }
        // Q1 counts a MANAGER sign-off — not a worker (in a manager role) confirming their own task.
        if (justConfirmed && after.confirmedBy && after.confirmedBy !== uid) {
            await bumpAndGrant(uid, 'approved_craft');
        }
        if (justDocumented) {
            await bumpAndGrant(uid, 'documented');
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
function lithuanianDay(date) {
    // en-CA renders as YYYY-MM-DD; the timeZone makes it the Vilnius calendar day.
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Vilnius', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
}

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
    const planned = await db.collection('work_hours').where('userId', '==', uid).get();
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
async function overseersFor(uid) {
    if (!uid) return [];
    try {
        const snap = await db.collection('users').doc(uid).get();
        if (!snap.exists) return [];
        const u = snap.data();
        const role = u.role || 'worker';
        if (role === 'manager') {
            const seniors = u.seniorManagerIds;
            return Array.isArray(seniors) ? seniors.filter(Boolean) : [];
        }
        if (role === 'seniorManager' || role === 'admin' || role === 'Administratorius') {
            return [];
        }
        // worker (or legacy/absent role): direct managers + each manager's seniors.
        const mgrs = Array.isArray(u.teamManagerIds) ? u.teamManagerIds.filter(Boolean) : [];
        const result = new Set(mgrs);
        await Promise.all(mgrs.map(async (m) => {
            try {
                const msnap = await db.collection('users').doc(m).get();
                if (!msnap.exists) return;
                const seniors = msnap.data().seniorManagerIds;
                if (Array.isArray(seniors)) seniors.filter(Boolean).forEach((s) => result.add(s));
            } catch (err) {
                logger.warn('overseersFor manager read failed', { manager: m, err: err.message });
            }
        }));
        return [...result];
    } catch (err) {
        logger.warn('overseersFor failed', { uid, err: err.message });
        return [];
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
    await after.ref.update({ teamManagerIds: desired });
}

// Stamp a freshly created session from its owner (userId). Owner never changes on a session,
// so onCreate is enough. Skip the write when the worker has no managers (leave the field absent
// — the rules' .get(...,[]) default treats absent as "no manager sees it").
async function stampOwnedCreate(event, ownerField) {
    const snap = event.data;
    if (!snap) return;
    const ownerUid = snap.data()[ownerField];
    if (!ownerUid) return;
    const desired = await overseersFor(ownerUid);
    if (!desired.length) return;
    await snap.ref.update({ teamManagerIds: desired });
}

exports.stampTeamOnTaskWrite = onDocumentWritten('tasks/{id}', (event) => stampOwnedDoc(event, 'assignedUserId'));
exports.stampTeamOnArchivedTaskWrite = onDocumentWritten('archived_tasks/{id}', (event) => stampOwnedDoc(event, 'assignedUserId'));
exports.stampTeamOnWorkSessionCreate = onDocumentCreated('work_sessions/{id}', (event) => stampOwnedCreate(event, 'userId'));
exports.stampTeamOnBreakSessionCreate = onDocumentCreated('break_sessions/{id}', (event) => stampOwnedCreate(event, 'userId'));

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
        logger.warn('setOverseerIds failed', { uid, err: err.message });
        return false;
    }
}

// When an admin changes a worker's managers OR a manager's seniors (OR anyone's role), rewrite the
// affected closures so the right overseers see the right PAST rows (full-history decision, ADR
// 0005/0007). A manager's senior change CASCADES: every worker under that manager folds the
// manager's seniors into their own closure, so they must be re-stamped too. Membership changes are
// rare and crews small, so the fan-out (one manager's workers × their rows) is acceptable.
exports.restampTeamOnUserChange = onDocumentUpdated('users/{id}', async (event) => {
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
        let cascaded = 0;
        if (seniorChanged || roleChanged) {
            const workersSnap = await db.collection('users')
                .where('teamManagerIds', 'array-contains', uid).get();
            for (const w of workersSnap.docs) {
                const desiredW = await overseersFor(w.id);
                await setOverseerIds(w.id, desiredW);
                cascaded += await restampUserRows(w.id, desiredW);
            }
        }
        logger.info('restampTeamOnUserChange done', { uid, selfRows, cascaded });
    } catch (err) {
        logger.error('restampTeamOnUserChange failed', { uid, err: err.message });
    }
});

// One-time (idempotent) migration: stamp every user's existing rows from their current
// teamManagerIds. Admin-only callable — run once after deploying these functions and assigning
// memberships. Safe to re-run.
exports.backfillTeamStamps = onCall(async (request) => {
    const callerUid = request.auth && request.auth.uid;
    if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const callerSnap = await db.collection('users').doc(callerUid).get();
    const role = callerSnap.exists ? callerSnap.data().role : '';
    if (role !== 'admin' && role !== 'Administratorius') {
        throw new HttpsError('permission-denied', 'Admin only.');
    }
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
// Read-only over the data apart from its own report docs. Region inherits europe-west1.

const MONITORED_COLLECTIONS = ['work_sessions', 'break_sessions', 'work_hours', 'tasks'];
const DROP_ALERT_RATIO = 0.3;   // a >30% day-over-day row drop in a monitored collection is critical
const LOOKBACK_DAYS = 2;        // anomaly scan window (catch fresh corruption); cheap and timely
const SAMPLE_LIMIT = 20;        // cap offending-id samples kept in a report (never store unbounded)

async function collectionCount(name) {
    try {
        const snap = await db.collection(name).count().get();
        return snap.data().count;
    } catch (err) {
        logger.warn('collectionCount failed', { name, err: err.message });
        return null;
    }
}

// ISO cutoff LOOKBACK_DAYS ago. (Date.now() is fine in a function — only the workflow sandbox bans it.)
function lookbackCutoffIso() {
    return new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// Scan one session collection's recently-created rows for corrupt values.
async function scanSessionAnomalies(name) {
    const cutoff = lookbackCutoffIso();
    let snap;
    try {
        snap = await db.collection(name).where('createdAt', '>=', cutoff).get();
    } catch (err) {
        logger.warn('scanSessionAnomalies query failed', { name, err: err.message });
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

// Hard ceiling for a SINGLE continuous running timer — MIRROR of src/utils/timeUtils
// MAX_SESSION_MINUTES (16h). No real continuous session approaches this; a larger elapsed can only
// be a timer left running after the app was closed.
const MAX_RUNNING_TIMER_MINUTES = 16 * 60;
const STALE_TASK_DAYS = 30;                                   // non-terminal age that warrants review
const STALE_STATUSES = ['pending', 'in-progress', 'approved', 'unapproved'];

// Stop timers left RUNNING longer than any real continuous session — the forgotten-timer corruption
// (the 8710-min / 1158-min cases) that the CLIENT clamp structurally cannot reach, because it only
// fires while the assignee has the app open on that task (autoStopped was 0/471 in the data). The
// unbounded running interval is DISCARDED (we never credit phantom hours) and the task is flagged
// autoStopped so a manager can add real time if the worker actually worked. Safe by construction: a
// genuine continuous session never exceeds 16h, and legitimate long (25-70h) jobs accrue via many
// PAUSED sessions, never one running run — so this never clips real work. The worker's own
// activeSession/workStatus is reconciled client-side by the orphan-recovery hook on next app load.
async function autoStopForgottenTimers() {
    let snap;
    try {
        snap = await db.collection('tasks').where('timerStatus', '==', 'running').get();
    } catch (err) {
        logger.warn('autoStopForgottenTimers query failed', { err: err.message });
        return { scanned: 0, stopped: 0, samples: [] };
    }
    const nowMs = Date.now();
    const nowIso = new Date().toISOString();
    let stopped = 0;
    const samples = [];
    const audits = [];
    const writer = db.bulkWriter();
    snap.forEach((docSnap) => {
        const t = docSnap.data();
        if (!t.timerStartedAt) return;
        const startMs = new Date(t.timerStartedAt).getTime();
        if (Number.isNaN(startMs)) return;
        const elapsedMin = (nowMs - startMs) / 60000;
        if (elapsedMin <= MAX_RUNNING_TIMER_MINUTES) return;
        writer.update(docSnap.ref, {
            timerStatus: 'paused',
            timerStartedAt: null,
            autoStopped: true,
            autoStopReason: 'forgotten-timer-16h',
            autoStoppedAt: nowIso,
            updatedAt: nowIso,
        });
        stopped += 1;
        if (samples.length < SAMPLE_LIMIT) samples.push({ id: docSnap.id, elapsedMin: Math.round(elapsedMin) });
        // Key on the stopped running interval (taskId + its start) so a retry recomputes the SAME
        // idempotency key — the create() in appendSystemDecision then dedups the audit, not the effect.
        audits.push({ taskId: docSnap.id, startIso: t.timerStartedAt, elapsedMin: Math.round(elapsedMin) });
    });
    await writer.close();

    // Audit each auto-stop under the SYSTEM actor (ADR 0015), AFTER the writes land. Best-effort:
    // an audit failure never undoes a stop that already happened.
    for (const a of audits) {
        await appendSystemDecision(db, {
            idempotencyKey: `autostop_${a.taskId}_${a.startIso}`,
            command: 'integrity.autoStopTimer',
            source: 'dailyIntegrityScan',
            targetType: 'task',
            targetId: a.taskId,
            reason: `Auto-stopped a timer left running ${a.elapsedMin} min (>16h); phantom interval discarded`,
            before: { timerStatus: 'running', timerStartedAt: a.startIso },
            after: { timerStatus: 'paused', timerStartedAt: null, autoStopped: true, autoStopReason: 'forgotten-timer-16h' },
        });
    }
    return { scanned: snap.size, stopped, samples };
}

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
const AUTO_STOPPED_QUICK_WORK_TITLE = 'Greitas darbas (Automatiškai išsaugotas)'; // mirror sessionActions.js
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
async function writeSecondaryCloseRecords({ uid, userName, session, startMs, durationMinutes, date, nowIso, now, userData }) {
    const startTime = session.startTime;
    const timeString = vilniusHHMM(now);

    if (session.type === 'break') {
        await createIfAbsent(db.collection('break_sessions').doc(`sess_break_${uid}_${startMs}`), {
            userId: uid, userName, startTime, endTime: nowIso, durationMinutes, date,
            createdAt: nowIso, completedAt: nowIso, isBreak: true,
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
async function autoCloseForgottenSessions() {
    let snap;
    try {
        snap = await db.collection('users').get();
    } catch (err) {
        logger.warn('autoCloseForgottenSessions query failed', { err: err.message });
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
            // (1) Credit the clamped time as a record (sub-minute taps are discarded, as on the client).
            if (durationMinutes > MIN_LOGGED_SECONDARY_MINUTES) {
                await writeSecondaryCloseRecords({ uid, userName, session, startMs, durationMinutes, date, nowIso, now, userData: u });
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

// Surface (do NOT mutate) non-terminal tasks sitting unfinished beyond STALE_TASK_DAYS — the
// backlog the data found (91 tasks >14d, oldest 'pending' 159d). Report-only: a manager decides to
// finish, reassign, or drop them. createdAt is an ISO string, so the cutoff compares lexically.
async function scanStaleTasks() {
    const cutoffIso = new Date(Date.now() - STALE_TASK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    let snap;
    try {
        snap = await db.collection('tasks').where('status', 'in', STALE_STATUSES).get();
    } catch (err) {
        logger.warn('scanStaleTasks query failed', { err: err.message });
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

        // (1) Volume canary — compare current counts against the previous stored snapshot.
        const counts = {};
        await Promise.all(MONITORED_COLLECTIONS.map(async (name) => {
            counts[name] = await collectionCount(name);
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
            const r = await scanSessionAnomalies(name);
            anomalyReport[name] = r;
            totalAnomalies += r.anomalies;
        }

        // (3) Task timer integrity — stop forgotten running timers, and surface the stale backlog.
        const autoStoppedTimers = await autoStopForgottenTimers();
        // (3b) Secondary-session integrity — close abandoned break/call/quick-work sessions the
        //      client resume logic deliberately leaves running until the worker reopens.
        const autoClosedSessions = await autoCloseForgottenSessions();
        const staleBacklog = await scanStaleTasks();

        const critical = drops.length > 0;
        const warning = totalAnomalies > 0 || autoStoppedTimers.stopped > 0 || autoClosedSessions.closed > 0;
        const report = {
            day,
            ranAt: nowIso,
            severity: critical ? 'critical' : (warning ? 'warning' : 'ok'),
            counts,
            drops,
            anomalies: anomalyReport,
            totalAnomalies,
            autoStoppedTimers,
            autoClosedSessions,
            staleBacklog
        };

        try {
            await db.collection('integrity_reports').doc(day).set(report, { merge: true });
            await countsRef.set({ counts, updatedAt: nowIso }, { merge: true });
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
        if (autoStoppedTimers.stopped > 0) logger.warn('INTEGRITY: auto-stopped forgotten timers', autoStoppedTimers);
        if (autoClosedSessions.closed > 0) logger.warn('INTEGRITY: auto-closed abandoned secondary sessions', autoClosedSessions);
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
    if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');
    const callerSnap = await db.collection('users').doc(callerUid).get();
    const role = callerSnap.exists ? callerSnap.data().role : '';
    if (!['admin', 'Administratorius', 'manager', 'seniorManager'].includes(role)) {
        throw new HttpsError('permission-denied', 'Managers only.');
    }
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
        if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');
        // Any signed-in user may request a DRAFT. Workers self-create tasks too, and this callable
        // never writes anything — the assignee is still resolved server-side from the caller-supplied
        // (client-scoped) roster, so it cannot invent a user. The previous manager-only gate left the
        // ✨ button visible to workers but ALWAYS failing for them ("AI nepavyko"); opening the
        // callable makes the button honest for everyone who can see it.
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
