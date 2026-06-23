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

// Friendly Lithuanian copy per request_notification type (UI strings are Lithuanian). This feed is
// two-way, so it covers both the worker→manager requests and the manager→worker decision notices.
function copyForRequestNotification(n) {
    const title = n.taskTitle || 'WORKZ';
    switch (n.type) {
        // Worker → manager
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
        // Manager → worker
        case 'task_assigned':
            return { title: 'Nauja užduotis', body: title };
        case 'recurring_reassign':
            // System → manager: the recurring job's usual assignee is away; pick someone else.
            return { title: 'Priskirkite kitą vykdytoją', body: title };
        case 'task_approved':
            return { title: 'Užduotis patvirtinta', body: title };
        case 'task_confirmed':
            return { title: 'Užduotis užbaigta ir patvirtinta', body: title };
        case 'task_reverted':
            return { title: 'Užduotis grąžinta taisyti', body: title };
        case 'extension_granted':
            return { title: 'Laikas pratęstas', body: title };
        case 'extension_denied':
            return { title: 'Laikas nepratęstas', body: title };
        case 'calendar_decision':
            return {
                title: n.decision === 'approved' ? 'Kalendoriaus pakeitimas patvirtintas' : 'Kalendoriaus pakeitimas atmestas',
                body: 'Darbo kalendorius',
            };
        default:
            return { title: 'WORKZ pranešimas', body: title };
    }
}

exports.notifyOnRequestNotification = onDocumentCreated('request_notifications/{id}', async (event) => {
    const n = event.data && event.data.data();
    if (!n || !n.recipientId) return;
    const { title, body } = copyForRequestNotification(n);
    // Calendar decisions land the worker on their calendar; everything else on tasks.
    const link = n.type === 'calendar_decision' ? '/?tab=calendar' : '/?tab=tasks';
    try {
        await sendToUser(n.recipientId, { title, body }, {
            type: String(n.type || ''),
            taskId: String(n.taskId || ''),
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
    const who = r.userName || 'Vykdytojas';
    try {
        await Promise.all(recipients.map((uid) =>
            sendToUser(uid, { title: 'Kalendoriaus keitimo prašymas', body: who }, {
                type: 'calendar_request',
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

const BADGES = {
    // Reliability
    follow_through: { name: 'Pabaigiu, ką pradedu', stat: 'completedTasks', thresholds: [1, 10, 40, 120] }, // R1
    steady_rhythm: { name: 'Pastovus ritmas', stat: 'workDays', thresholds: [5, 25, 75, 200] },             // R2 (high-water days)
    on_estimate: { name: 'Telpa į planą', stat: 'onEstimate', thresholds: [5, 20, 60, 150] },               // R3
    plans_ahead: { name: 'Planuoja iš anksto', stat: 'planAheadWeeks', thresholds: [2, 8, 20, 40] },        // R4 (high-water weeks)
    on_time_start: { name: 'Punktualus startas', stat: 'punctualDays', thresholds: [5, 20, 50, 120] },      // R6 (planned vs actual start)
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
        const staleBacklog = await scanStaleTasks();

        const critical = drops.length > 0;
        const warning = totalAnomalies > 0 || autoStoppedTimers.stopped > 0;
        const report = {
            day,
            ranAt: nowIso,
            severity: critical ? 'critical' : (warning ? 'warning' : 'ok'),
            counts,
            drops,
            anomalies: anomalyReport,
            totalAnomalies,
            autoStoppedTimers,
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
const RECURRING_PRIORITIES = ['URGENT', 'HIGH', 'MEDIUM', 'LOW', 'VERY_LOW'];
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
// MIRROR of src/utils/recurrence.js recurrenceFiresOn — keep both copies identical.
function recurringFiresOn(recurrence, dateStr) {
    if (!recurrence || recurrence.active === false) return false;
    if (Array.isArray(recurrence.skipDates) && recurrence.skipDates.includes(dateStr)) return false;
    const wd = recurringIsoWeekday(dateStr);
    if (!wd) return false;
    switch (recurrence.freq) {
        case 'daily':
            return true;
        case 'weekly':
            return Array.isArray(recurrence.byWeekday) && recurrence.byWeekday.includes(wd);
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
            title: data.title || template.templateName || 'Pasikartojantis darbas',
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
            creatorName: 'Pasikartojantis darbas',
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
                title: data.title || template.templateName || 'Pasikartojantis darbas',
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
                taskTitle: data.title || template.templateName || 'Pasikartojantis darbas',
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
        const callerSnap = await db.collection('users').doc(callerUid).get();
        const role = callerSnap.exists ? callerSnap.data().role : '';
        if (!['admin', 'Administratorius', 'manager', 'seniorManager'].includes(role)) {
            throw new HttpsError('permission-denied', 'Managers only.');
        }
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
            '(vienas iš: URGENT, HIGH, MEDIUM, LOW, VERY_LOW), estimate (pvz. "30min","1h","2h","1,5h" ' +
            'arba ""), deadline (YYYY-MM-DD arba ""). Šiandien yra ' + today + ' (Europe/Vilnius), ' +
            'savaitė prasideda pirmadienį — "rytoj","poryt","pirmadienį" ir pan. paversk į konkrečią ' +
            'datą. Vykdytojų sąrašas: ' + (names.join(', ') || '(nėra)') + '. Jei prioritetas ' +
            'nenurodytas, naudok MEDIUM. Atsakyk TIK JSON, be jokio kito teksto.';

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
        const deadline = (typeof parsed.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.deadline))
            ? parsed.deadline
            : '';
        return {
            title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '',
            assignedUserId: resolveAssigneeId(parsed.assigneeName, roster),
            priority: normalizeRecurringPriority(parsed.priority),
            estimatedTime: estimate,
            estimatedTimeMinutes: parseEstimateMinutes(estimate),
            deadline,
        };
    }
);
