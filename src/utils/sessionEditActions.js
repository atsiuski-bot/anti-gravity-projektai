import { doc, updateDoc, addDoc, collection, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import {
    getLithuanianDateString,
    addDaysToDateString,
    MAX_SESSION_MINUTES,
    MAX_BACKDATE_DAYS,
    formatMinutesToTimeString,
} from './timeUtils';
import { logError } from './errorLog';
import { notify, notifyMany } from './notify';

// The worker's OWN durationMinutes before an edit (the value already credited to their day). Used
// to phrase the "before → after" summary the worker sees when an admin corrects their paid time.
const sessionDurationOf = (session) =>
    typeof session?.durationMinutes === 'number' ? session.durationMinutes : null;

// Admin time-editing operates on work_sessions, the single canonical record of logged time:
// every report/daily aggregator sums work_sessions.durationMinutes over a Vilnius work-day
// window, so correcting a session's start/end here flows automatically into every total with
// no cached counter to backfill. A work_sessions row exposes exactly TWO derived fields to
// those aggregators — durationMinutes (credited time) and date (the day bucket) — and the admin
// only ever edits the start/end pair. These helpers turn that pair into the two derived fields,
// apply the same plausibility bound the live timer uses (the 16h single-session ceiling), and
// refuse an inverted or absurd interval rather than silently writing 0 or a clamped value.

// A single edited/created session may not exceed the same 16h ceiling clampSessionMinutes
// enforces on a live timer. A real shift never approaches it; a larger value is almost always a
// mistyped date, so we block it (with a clear message) instead of persisting implausible payable
// time — which keeps every stored duration plausible without relying on the read-side clamp.
export const MAX_EDIT_SESSION_MINUTES = MAX_SESSION_MINUTES;

// Validate an admin-entered [start, end] pair and derive the two fields the reports read.
// Returns { ok, error, durationMinutes, date }. `error` is a stable code the UI maps to copy:
//   'invalid' — un-parseable timestamp; 'order' — end not after start; 'tooLong' — > 16h.
export const deriveSessionFields = (startISO, endISO) => {
    const start = new Date(startISO);
    const end = new Date(endISO);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return { ok: false, error: 'invalid', durationMinutes: 0, date: null };
    }
    const rawMinutes = (end.getTime() - start.getTime()) / 60000;
    if (rawMinutes <= 0) {
        return { ok: false, error: 'order', durationMinutes: 0, date: null };
    }
    if (rawMinutes > MAX_EDIT_SESSION_MINUTES) {
        return { ok: false, error: 'tooLong', durationMinutes: rawMinutes, date: null };
    }
    return {
        ok: true,
        error: null,
        durationMinutes: rawMinutes,
        // Bucket by the END day, matching every other work_sessions writer (pauseTask,
        // sessionActions, the legacy time-correction). A session that runs across midnight
        // credits to the day it finished, so the day windows never double-count or drop it.
        date: getLithuanianDateString(end)
    };
};

// Edit an existing tracked session's start/end in place. Recomputes durationMinutes + date,
// snapshots the TRUE original exactly once, and stamps who/when/why. Returns { ok, error, ... }.
export const editWorkSession = async (session, { startTime, endTime, reason, editor } = {}) => {
    if (!session?.id) return { ok: false, error: 'missing' };
    const trimmedReason = (reason || '').trim();
    if (!trimmedReason) return { ok: false, error: 'reason' };

    const derived = deriveSessionFields(startTime, endTime);
    if (!derived.ok) return { ok: false, error: derived.error };

    const nowIso = new Date().toISOString();
    const updates = {
        startTime,
        endTime,
        durationMinutes: derived.durationMinutes,
        date: derived.date,
        edited: true,
        editedBy: editor?.uid || 'unknown',
        editedByName: editor?.displayName || editor?.email || 'Nežinomas',
        editedAt: nowIso,
        editReason: trimmedReason,
        updatedAt: nowIso
    };

    // Snapshot the original exactly once. On a second edit `session.edited` is already true, so
    // we keep the first-captured original rather than overwriting it with the previously-edited
    // values — the audit must always point back to what the worker's timer actually recorded.
    if (!session.edited) {
        updates.originalStartTime = session.startTime ?? null;
        updates.originalEndTime = session.endTime ?? null;
        updates.originalDurationMinutes =
            typeof session.durationMinutes === 'number' ? session.durationMinutes : null;
    }

    try {
        await updateDoc(doc(db, 'work_sessions', session.id), updates);
        // Tell the worker their PAID time was corrected by an admin. The notify() recipient===actor
        // guard drops an admin editing their OWN session, so this never self-notifies. Best-effort:
        // a notification failure must never undo the (already-persisted) correction, so it is fired
        // after the write and swallowed inside notify().
        const beforeMinutes = sessionDurationOf(session);
        const afterMinutes = derived.durationMinutes;
        const summary =
            beforeMinutes !== null
                ? `${formatMinutesToTimeString(beforeMinutes)} → ${formatMinutesToTimeString(afterMinutes)}`
                : `nustatyta trukmė ${formatMinutesToTimeString(afterMinutes)}`;
        await notify({
            recipientId: session.userId,
            type: 'session_edited',
            actorUid: editor?.uid,
            actorName: editor?.displayName || editor?.email,
            day: derived.date,
            summary,
            reason: trimmedReason,
            taskTitle: session.taskTitle || null,
        });
        return { ok: true, durationMinutes: derived.durationMinutes, date: derived.date };
    } catch (err) {
        logError(err, { source: 'writeFail:editWorkSession', sessionId: session.id });
        return { ok: false, error: 'write' };
    }
};

// Soft-delete an erroneous session (e.g. an orphaned timer clamped to 16h). The row is excluded
// from every aggregator (the session listener drops isDeleted rows) but stays in Firestore as an
// audit trail of what was removed and why — a hard delete would erase that record silently.
export const deleteWorkSession = async (session, { reason, editor } = {}) => {
    if (!session?.id) return { ok: false, error: 'missing' };
    const trimmedReason = (reason || '').trim();
    const nowIso = new Date().toISOString();
    const updates = {
        isDeleted: true,
        deletedBy: editor?.uid || 'unknown',
        deletedByName: editor?.displayName || editor?.email || 'Nežinomas',
        deletedAt: nowIso,
        deleteReason: trimmedReason || null,
        updatedAt: nowIso
    };
    try {
        await updateDoc(doc(db, 'work_sessions', session.id), updates);
        // Tell the worker an admin removed one of their logged (paid) sessions. Same self-edit guard
        // and best-effort posture as editWorkSession. The day comes from the stored bucket (or the
        // session's start), so the worker knows which day's total changed.
        const day = session.date || (session.startTime ? getLithuanianDateString(session.startTime) : null);
        await notify({
            recipientId: session.userId,
            type: 'session_deleted',
            actorUid: editor?.uid,
            actorName: editor?.displayName || editor?.email,
            day,
            summary: 'pašalinta sesija',
            reason: trimmedReason || null,
            taskTitle: session.taskTitle || null,
        });
        return { ok: true };
    } catch (err) {
        logError(err, { source: 'writeFail:deleteWorkSession', sessionId: session.id });
        return { ok: false, error: 'write' };
    }
};

// Create a missing session from scratch (e.g. a worker who forgot to start the timer). Stores a
// real start/end with a synthetic taskId so it can never be mistaken for a tracked task's session
// — its id never matches a Firestore task id (like quick_/call_ sessions), so the daily view's
// double-count guard treats it purely as session time.
export const createWorkSession = async ({ userId, userName, taskTitle, startTime, endTime, reason, editor } = {}) => {
    if (!userId) return { ok: false, error: 'user' };
    const trimmedReason = (reason || '').trim();
    if (!trimmedReason) return { ok: false, error: 'reason' };

    const derived = deriveSessionFields(startTime, endTime);
    if (!derived.ok) return { ok: false, error: derived.error };

    const nowIso = new Date().toISOString();
    const payload = {
        taskId: `manual_${Date.now()}`,
        taskTitle: (taskTitle || '').trim() || 'Rankinė sesija',
        userId,
        userName: userName || null,
        startTime,
        endTime,
        durationMinutes: derived.durationMinutes,
        date: derived.date,
        createdAt: nowIso,
        // Provenance: authored by an admin, not tracked by a timer.
        isManualSession: true,
        createdByAdmin: editor?.uid || 'unknown',
        createdByAdminName: editor?.displayName || editor?.email || 'Nežinomas',
        editReason: trimmedReason
    };
    try {
        const ref = await addDoc(collection(db, 'work_sessions'), payload);
        return { ok: true, id: ref.id, durationMinutes: derived.durationMinutes, date: derived.date };
    } catch (err) {
        logError(err, { source: 'writeFail:createWorkSession' });
        return { ok: false, error: 'write' };
    }
};

// Bound a TRUSTED worker's self-logged backdated session to the allowed window, on TOP of the
// plausibility checks deriveSessionFields already applies (order, 16h). Two extra rules, both
// expressed against the worker's local Vilnius day so they read the same way the worker thinks:
//   • 'future' — the entry must be PAST work: the end may not land after now (a 1-minute tolerance
//     absorbs second-level device-clock skew when logging up to the current moment).
//   • 'tooOld' — the start day may not be earlier than today − MAX_BACKDATE_DAYS, so an
//     approval-free entry can never reach back weeks to fabricate payable time.
// Pure (now is injectable) so the window math is unit-tested without touching Firestore. Returns
// { ok, error } with a stable code the UI maps to copy. The action layer calls this AFTER
// deriveSessionFields, so start/end are already known to parse and to be correctly ordered.
export const validateBackdateWindow = (startISO, endISO, now = new Date()) => {
    const start = new Date(startISO);
    const end = new Date(endISO);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return { ok: false, error: 'invalid' };
    }
    if (end.getTime() > now.getTime() + 60000) {
        return { ok: false, error: 'future' };
    }
    const minDay = addDaysToDateString(getLithuanianDateString(now), -MAX_BACKDATE_DAYS);
    if (getLithuanianDateString(start) < minDay) {
        return { ok: false, error: 'tooOld' };
    }
    return { ok: true, error: null };
};

// A trusted worker (canBackdateTime) logs a session they forgot to track, on one of their OWN
// tasks, at a past time — WITHOUT manager approval. The write is identical in shape to a normal
// tracked session (real taskId, so every report aggregates it exactly like timer-logged time),
// but stamped as worker-authored + backdated for audit, and it fans an INFORMATIONAL notice to the
// admins so the approval-free entry is never invisible. Returns { ok, error, ... }. Error codes
// extend createWorkSession's: 'future' / 'tooOld' from the window guard; 'task' when no task id.
// The admin notification is best-effort — fired after the (already-persisted) session write and
// swallowed inside notify() — so a notification failure can never undo the logged time.
export const logBackdatedWorkerSession = async ({ task, worker, startTime, endTime, reason, adminUids } = {}) => {
    if (!worker?.uid) return { ok: false, error: 'user' };
    if (!task?.id) return { ok: false, error: 'task' };
    const trimmedReason = (reason || '').trim();
    if (!trimmedReason) return { ok: false, error: 'reason' };

    const derived = deriveSessionFields(startTime, endTime);
    if (!derived.ok) return { ok: false, error: derived.error };

    const windowCheck = validateBackdateWindow(startTime, endTime);
    if (!windowCheck.ok) return { ok: false, error: windowCheck.error };

    const nowIso = new Date().toISOString();
    const workerName = worker.displayName || worker.email || null;
    const payload = {
        taskId: task.id,
        taskTitle: (task.title || '').trim() || 'Užduotis',
        userId: worker.uid,
        userName: workerName,
        startTime,
        endTime,
        durationMinutes: derived.durationMinutes,
        date: derived.date,
        createdAt: nowIso,
        // Provenance: hand-entered by the WORKER (not a timer, not an admin), and explicitly
        // backdated. isManualSession keeps it out of the task-assignment double-count guard exactly
        // like the admin manual path; isBackdated marks the approval-free worker origin for audit.
        isManualSession: true,
        isBackdated: true,
        createdBy: worker.uid,
        createdByName: workerName || 'Nežinomas',
        editReason: trimmedReason,
    };
    try {
        const ref = await addDoc(collection(db, 'work_sessions'), payload);
        // FYI to every admin that an approval-free backdated entry was logged. notifyMany dedupes and
        // drops the actor, so a backdating admin never self-notifies. userId == the worker's uid
        // satisfies the rules' provenance check on a worker-authored notification.
        await notifyMany(adminUids, {
            type: 'backdated_time_logged',
            actorUid: worker.uid,
            actorName: workerName,
            userId: worker.uid,
            userName: workerName,
            day: derived.date,
            taskTitle: payload.taskTitle,
            summary: formatMinutesToTimeString(derived.durationMinutes),
        });
        return { ok: true, id: ref.id, durationMinutes: derived.durationMinutes, date: derived.date };
    } catch (err) {
        logError(err, { source: 'writeFail:logBackdatedWorkerSession' });
        return { ok: false, error: 'write' };
    }
};

// A worker claims the untracked GAP that the crash/reload recovery surfaced — the stretch between
// their timer's last heartbeat and the app reopening, when the app was closed (no signal in the
// field, phone killed the tab) but they kept working. The recovery already credited up to the last
// beat and paused; this credits the proven-by-the-worker remainder as one self-authored session.
//
// Shape mirrors logBackdatedWorkerSession (real taskId so reports aggregate it like timer time;
// worker-authored provenance), with an `isRecoveredGap` flag for audit. It is gated to the same
// 16h ceiling via deriveSessionFields. Unlike the backdate path it carries NO approval-window
// check: by construction the gap is recent and in the past (the recovery hook only offers gaps
// ≤16h that end at the reopen instant), and it is the worker confirming their OWN just-worked
// time, so the base work_sessions create rule (createOwnsUserId + durationInRange) already covers
// it — no canBackdateTime privilege required. Returns { ok, error, ... }.
export const claimRecoveredGap = async ({ task, worker, startTime, endTime, reason } = {}) => {
    if (!worker?.uid) return { ok: false, error: 'user' };
    if (!task?.id) return { ok: false, error: 'task' };

    const derived = deriveSessionFields(startTime, endTime);
    if (!derived.ok) return { ok: false, error: derived.error };

    const nowIso = new Date().toISOString();
    const workerName = worker.displayName || worker.email || null;
    const payload = {
        taskId: task.id,
        taskTitle: (task.title || '').trim() || 'Užduotis',
        userId: worker.uid,
        userName: workerName,
        startTime,
        endTime,
        durationMinutes: derived.durationMinutes,
        date: derived.date,
        createdAt: nowIso,
        // Provenance: hand-confirmed by the WORKER from the recovery banner (not a live timer),
        // for an offline stretch the timer could not record. isManualSession keeps it out of the
        // task-assignment double-count guard like the other manual paths; isRecoveredGap marks the
        // origin so reports/admins can tell apart auto-claimed offline time.
        isManualSession: true,
        isRecoveredGap: true,
        createdBy: worker.uid,
        createdByName: workerName || 'Nežinomas',
        editReason: (reason || '').trim() || 'Atkurtas neužfiksuotas darbo laikas (be ryšio)',
    };
    try {
        const ref = await addDoc(collection(db, 'work_sessions'), payload);
        return { ok: true, id: ref.id, durationMinutes: derived.durationMinutes, date: derived.date };
    } catch (err) {
        logError(err, { source: 'writeFail:claimRecoveredGap' });
        return { ok: false, error: 'write' };
    }
};

/**
 * Undo an auto-credited recovered gap — the "Nedirbau" opt-out on the recovery banner. Recovery now
 * AUTO-credits a plausible offline gap (the worker was almost certainly working with the phone
 * pocketed); this hard-deletes that one recovered-gap session if the worker says they were not. A
 * hard delete (not the admin soft-delete) is correct here: the session was auto-created seconds ago
 * and never seen by anyone, so there is nothing to preserve an audit trail against.
 *
 * @param {Object} args - { sessionId } the work_sessions id returned by claimRecoveredGap.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export const discardRecoveredGap = async ({ sessionId } = {}) => {
    if (!sessionId) return { ok: false, error: 'session' };
    try {
        await deleteDoc(doc(db, 'work_sessions', sessionId));
        return { ok: true };
    } catch (err) {
        logError(err, { source: 'writeFail:discardRecoveredGap' });
        return { ok: false, error: 'write' };
    }
};
