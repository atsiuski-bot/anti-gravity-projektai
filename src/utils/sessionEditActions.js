import { doc, updateDoc, addDoc, setDoc, collection, deleteDoc, getDoc, getDocs, increment, query, where } from 'firebase/firestore';
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

// Read a task's work_sessions the way THIS caller is actually allowed to read them.
//
// The work_sessions read rule grants a row to a whole-team viewer, to the row's owner, or to a
// scoped overseer of that owner. A query constrained only by `taskId` proves none of those, so
// Firestore rejects it outright for a plain worker — which silently disabled reconciliation on
// exactly the worker-facing correction paths ("Buvau darbe", "Nedirbau", the trusted backdate):
// the session was written, the denial was swallowed, and the task's cached counter never moved.
//
// The broad query is still TRIED FIRST, because it is the only one that also picks up
// pre-migration rows that carry the legacy `workerId` instead of `userId`; narrowing a whole-team
// viewer's read would drop those from the sum and write back a SMALLER total — destroying credited
// time. Only when Firestore denies the broad read do we fall back to the owner-constrained one,
// which is provably in-scope for the worker. (Two equality filters need no composite index —
// Firestore merges the automatic single-field ones.) A scoped/senior manager is provable by
// neither form, so their reconcile still reports failure rather than writing a partial sum.
// Returns { snap, partial }. `partial: true` means the broad by-taskId read was denied and we fell
// back to the caller's OWN rows — a sum that provably cannot see sessions owned by anyone else, so
// it must never be treated as the task's complete credited time. See the completeness guard in
// reconcileTaskTimerFromSessions.
const readTaskSessions = async (taskId, ownerUid) => {
    try {
        const snap = await getDocs(query(collection(db, 'work_sessions'), where('taskId', '==', taskId)));
        return { snap, partial: false };
    } catch (err) {
        if (!ownerUid || err?.code !== 'permission-denied') throw err;
        const snap = await getDocs(query(
            collection(db, 'work_sessions'),
            where('userId', '==', ownerUid),
            where('taskId', '==', taskId)
        ));
        return { snap, partial: true };
    }
};

// ── Counter reconciliation ──────────────────────────────────────────────────────────────────
// A task carries a DENORMALISED time counter (timerMinutes + manualMinutes) that the task detail
// sheet, the earnings popup and the time-limit monitor all read via calculateCurrentTotalMinutes.
// The live timer keeps that counter and the per-segment work_sessions in lock-step, but every
// CORRECTION path in this file mutates only work_sessions — so after an edit/backdate/gap the
// report (which sums work_sessions) moves while the cached counter stays stale, and the two
// surfaces disagree for the same task. Decision (founder, 2026-07-07): work_sessions is canonical;
// after a correction we re-derive the task counter from the sum of its non-deleted sessions so
// every surface shows the one true number.
//
// SAFETY — synthetic-id guard. Only genuine timer tasks key their work_sessions on the REAL task
// document id; quick-work/call/manual sessions use a synthetic taskId (quick_/call_/manual_…) whose
// time lives in the task's manualMinutes and is NOT summed by-taskId. Summing sessions-where-
// taskId==syntheticId finds ZERO, so we must never write that back. The `doc must exist` check does
// exactly this: a synthetic taskId resolves to no task/archived_tasks doc, and reconciliation skips.
// Best-effort: the session write already succeeded, so a reconcile failure (e.g. a worker path the
// task rules don't permit) is swallowed — it only leaves the pre-existing drift, never worse. The
// returned { ok } flag says whether the counter actually moved, so a caller can eventually tell the
// worker their task total is stale instead of the failure being invisible.
//
// `ownerUid` is the uid the task's sessions are owned by (always the ASSIGNEE — every work_sessions
// writer stamps userId: task.assignedUserId, never the actor). It is what makes the read possible at
// all for a non-manager: see readTaskSessions above.
//
// `deltaMinutes` is the DELTA-MODE fallback for exactly the callers a re-derive cannot serve. When
// the broad read is denied (every plain-worker correction), the owner-scoped sum is provably
// incomplete and must never be written back — but the caller usually knows the one thing the sum was
// needed for: how much credited time THIS correction added or removed. An atomic increment applies
// that delta without ever needing to see the other rows, so the task counter tracks the canonical
// ledger instead of silently drifting away from it. Two conditions make it safe, and both are the
// CALLER's responsibility: the delta must be EXACTLY-ONCE (a retried/duplicated correction must pass
// no delta, or an increment double-counts where the wholesale re-derive was naturally idempotent),
// and it must describe a change that has already been persisted. Omit it and the old fail-closed
// behaviour is unchanged.
export const reconcileTaskTimerFromSessions = async (taskId, ownerUid, deltaMinutes) => {
    if (!taskId) return { ok: true };
    const delta = Number.isFinite(deltaMinutes) ? deltaMinutes : 0;
    try {
        // Sum this task's non-deleted logged sessions — the canonical credited time.
        const { snap, partial } = await readTaskSessions(taskId, ownerUid);

        // COMPLETENESS GUARD. The counter is overwritten wholesale below, so a sum that cannot see
        // every session would not "correct" the total — it would SHRINK it, destroying credited
        // time. The narrow fallback reads only the owner's own rows, and a task legitimately carries
        // rows under another uid after a reassignment (work_sessions stamp userId at pause time,
        // while assignTask repoints assignedUserId later), as do legacy `workerId`-only rows. For a
        // plain worker the broad read is ALWAYS denied, so this is the normal path for them, not an
        // edge case. Without a delta there is nothing safe to write: bail out and leave the
        // (visible, repairable) drift rather than a confidently wrong smaller number in pay.
        if (partial && !delta) return { ok: false, error: 'partial' };

        let total = 0;
        snap.forEach((d) => {
            const s = d.data();
            if (s.isDeleted) return;
            if (typeof s.durationMinutes === 'number' && s.durationMinutes > 0) total += s.durationMinutes;
        });

        // Locate the task in the live collection first, then the nightly archive. A synthetic-id
        // session (quick-work/call/manual) matches neither → we skip without touching real pay.
        let ref = doc(db, 'tasks', taskId);
        let taskSnap = await getDoc(ref);
        if (!taskSnap.exists()) {
            ref = doc(db, 'archived_tasks', taskId);
            taskSnap = await getDoc(ref);
        }
        if (!taskSnap.exists()) return { ok: true };

        if (partial) {
            // DELTA MODE. Bound a REMOVAL by what the counter actually holds so a discard can never
            // drive credited time negative (the summed rows the worker cannot see are not in
            // timerMinutes' history to give back). `increment` is applied server-side, so two
            // concurrent corrections compose instead of clobbering each other — which a
            // read-then-write of the whole counter could not promise on this path.
            const held = taskSnap.data()?.timerMinutes;
            const floor = -(typeof held === 'number' && held > 0 ? held : 0);
            const applied = Math.max(delta, floor);
            if (!applied) return { ok: true, mode: 'delta' };
            // `actualTime` is deliberately NOT re-derived here: it is a legacy display string that
            // calculateCurrentTotalMinutes consults only while manual+timer read 0 AND timeChanged
            // is falsy, and the flag below keeps it inert. Recomputing it would need the very total
            // this path cannot see.
            await updateDoc(ref, {
                timerMinutes: increment(applied),
                timeChanged: true,
                updatedAt: new Date().toISOString(),
            });
            return { ok: true, mode: 'delta' };
        }

        // Collapse the credited time into timerMinutes and zero manualMinutes so
        // calculateCurrentTotalMinutes (manual + timer + timeAdjustments) equals the summed
        // sessions. Legacy timeAdjustments deltas are NOT sessions, so they intentionally stay
        // added on top; a task that still carries them keeps that (pre-existing) separate offset.
        await updateDoc(ref, {
            timerMinutes: total,
            manualMinutes: 0,
            actualTime: formatMinutesToTimeString(total),
            timeChanged: true,
            updatedAt: new Date().toISOString(),
        });
        return { ok: true, mode: 'sum' };
    } catch (err) {
        logError(err, { source: 'writeFail:reconcileTaskTimerFromSessions', taskId });
        return { ok: false, error: err?.code === 'permission-denied' ? 'denied' : 'write' };
    }
};

// A correction persisted its work_sessions row but could NOT bring the task's cached counter with
// it. The row is canonical, so the action genuinely succeeded — reports and pay are right — but the
// task card / earnings popup / time-limit monitor now read a stale total, and until now that drift
// left no trace anywhere. Record it durably so a stale counter is diagnosable after the fact instead
// of being discovered as an unexplained mismatch weeks later. Returns the flag the action reports.
const noteReconcileOutcome = (result, { source, taskId }) => {
    if (result?.ok) return true;
    logError(new Error(`task counter not reconciled (${result?.error || 'unknown'})`), { source, taskId });
    return false;
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
        updatedAt: nowIso,
        // Hand the row back to unrestricted (manager) authorship. A row a worker shortened via
        // reduceOwnWorkSession carries selfAdjusted:true, and because an updateDoc is judged on the
        // MERGED result that flag would still be set on THIS write — where the rules' one-way guard
        // would then forbid an admin from ever raising the duration again. Clearing it is both
        // semantically right (the row is now an admin correction, not a worker self-reduction) and
        // what keeps the manager's editor the unconstrained authority it has always been.
        selfAdjusted: false
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
        // Re-derive the linked task's cached counter from its sessions so the task sheet / earnings /
        // monitor match the report after this correction (no-op for a synthetic-id session). The
        // session's OWNER (not the editing admin) is what makes the sessions query readable.
        await reconcileTaskTimerFromSessions(session.taskId, session.userId);
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
        // The removed session no longer counts toward the report — re-derive the task counter so its
        // sheet/earnings/monitor drop the same time (no-op for a synthetic-id session).
        await reconcileTaskTimerFromSessions(session.taskId, session.userId);
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
        // The new backdated session counts toward the report — bring the task counter with it so its
        // sheet/earnings/monitor include the same time. The worker's own uid keeps the sessions read
        // inside what the rules grant them (a taskId-only query would be denied), and the duration is
        // safe as a delta because addDoc always MINTS a row: there is no id a retry could land on
        // twice, so this correction can be counted exactly once.
        const rec = await reconcileTaskTimerFromSessions(task.id, worker.uid, derived.durationMinutes);
        const reconciled = noteReconcileOutcome(rec, { source: 'reconcile:logBackdatedWorkerSession', taskId: task.id });
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
        return { ok: true, id: ref.id, durationMinutes: derived.durationMinutes, date: derived.date, reconciled };
    } catch (err) {
        logError(err, { source: 'writeFail:logBackdatedWorkerSession' });
        return { ok: false, error: 'write' };
    }
};

// ── Worker self-service REDUCTION (one-way, approval-free) ──────────────────────────────────────
// The commonest honest error in the field is a timer left running: the worker finished at 16:00 and
// noticed at 18:30. Until now they could only FLAG the row and wait for a manager, so over-credited
// time sat in the reports (and in pay) until someone else got to it. This lets them correct it
// themselves — but strictly in ONE direction.
//
// The asymmetry is the whole design, and it is a claim about INCENTIVE, not about trust:
//   * SHORTENING is self-punishing. A worker giving back time they were already credited has nothing
//     to gain, so requiring an approval buys no safety — it only delays a correction everyone wants
//     and leaves the wrong number in the meantime.
//   * LENGTHENING pays the person asking for it. That is exactly what an approval gate is for, so an
//     increase never travels this path at all: the UI turns it into a session_correction_request the
//     manager applies with the editor they already have.
// The rules mirror this with a one-way guard keyed on the `selfAdjusted` marker these writes set
// (firestore.rules selfAdjustOkForUpdate), so the direction is enforced at the door and not only in
// the client. It is a PRODUCT gate rather than a security boundary — the create rule still lets any
// worker mint a session, so this bounds the honest-mistake path, it does not close ADR 0021.

/** The smallest duration a self-reduction may leave behind. Shorter than this is a deletion, which
 *  stays an admin action (it needs the soft-delete audit trail, not a 0-minute row). */
export const MIN_SELF_REDUCED_MINUTES = 1;

// Validate a worker's proposed new END for one of their OWN sessions. PURE — the caller supplies the
// stored row and the candidate instant, so the UI can show the consequence live and the action layer
// can re-check it before writing, from the one definition. Returns { ok, error, durationMinutes,
// date, deltaMinutes }; `error` is a stable code the UI maps to copy. Codes extend
// deriveSessionFields' (invalid/order/tooLong) with:
//   'missing'    — no row / no start instant to measure from;
//   'deleted'    — already soft-deleted, nothing to correct;
//   'running'    — the session has not finished yet (stop the timer instead);
//   'unsupported'— the row carries no numeric credited duration, so "less than before" is undefined
//                  and the rules' one-way guard could not judge the write either;
//   'notShorter' — the proposed end is not EARLIER than the stored one (an increase — needs approval);
//   'tooShort'   — the remainder falls under MIN_SELF_REDUCED_MINUTES.
export const validateSelfReduction = (session, endISO) => {
    if (!session?.id || !session?.startTime || !session?.endTime) return { ok: false, error: 'missing' };
    if (session.isDeleted) return { ok: false, error: 'deleted' };
    if (session.isActive) return { ok: false, error: 'running' };
    const before = sessionDurationOf(session);
    if (before === null) return { ok: false, error: 'unsupported' };

    const derived = deriveSessionFields(session.startTime, endISO);
    if (!derived.ok) return { ok: false, error: derived.error };

    const currentEndMs = new Date(session.endTime).getTime();
    const nextEndMs = new Date(endISO).getTime();
    if (isNaN(currentEndMs)) return { ok: false, error: 'unsupported' };
    // BOTH ends of the claim must move down: the wall-clock end AND the credited minutes. They can
    // disagree on a row whose stored duration was clamped (a 20h orphan capped at 16h), and it is the
    // credited number that reaches pay — so requiring both is what makes "shorter" unambiguous, and
    // it is the same pair the rules and the UI reason about.
    if (nextEndMs >= currentEndMs || derived.durationMinutes >= before) return { ok: false, error: 'notShorter' };
    if (derived.durationMinutes < MIN_SELF_REDUCED_MINUTES) return { ok: false, error: 'tooShort' };

    return {
        ok: true,
        error: null,
        durationMinutes: derived.durationMinutes,
        date: derived.date,
        // Negative by construction — what the task's cached counter must give back.
        deltaMinutes: derived.durationMinutes - before,
    };
};

/**
 * A worker shortens one of their OWN already-logged sessions, without approval.
 *
 * Only the END moves: the start stays exactly as the timer recorded it, so the correction can never
 * relocate a session into another day or over another one. durationMinutes + date are re-derived from
 * the new pair by the same derivation reports read, the TRUE original is snapshotted once (shared
 * with the admin editor's audit fields, so one "Koreguota" badge explains both), and the row is
 * stamped selfAdjusted so the rules' one-way guard applies to it from here on.
 *
 * The admins get an INFORMATIONAL notice — the same posture as an approval-free backdated entry: the
 * change stands on its own, but it is never invisible. Best-effort and fired after the (already
 * persisted) write, so a notification failure can never undo the correction.
 *
 * EXACTLY-ONCE (caller contract): the task counter is moved by a DELTA, because a plain worker's
 * by-taskId session read is denied and the owner-scoped sum is provably incomplete. Submitting the
 * same correction twice would therefore subtract twice, so the caller must not re-issue it on an
 * unknown outcome — the modal gates on `busy` for exactly this reason. (The reconcile floors a
 * removal at what the counter actually holds, so the worst case is a stale counter, never a negative
 * one.)
 *
 * @param {Object} args - { session, worker, endTime, reason, adminUids }
 * @returns {Promise<{ok:boolean, error?:string, durationMinutes?:number, date?:string, reconciled?:boolean}>}
 */
export const reduceOwnWorkSession = async ({ session, worker, endTime, reason, adminUids } = {}) => {
    if (!worker?.uid) return { ok: false, error: 'user' };
    if (!session?.id) return { ok: false, error: 'missing' };
    // Own rows only. The rules allow an owner OR a manager to update a session, so without this an
    // accidental manager call would take the worker-facing (guarded, one-way) path over someone
    // else's time instead of the admin editor's audited one.
    if (session.userId && session.userId !== worker.uid) return { ok: false, error: 'owner' };
    const trimmedReason = (reason || '').trim();
    if (!trimmedReason) return { ok: false, error: 'reason' };

    const check = validateSelfReduction(session, endTime);
    if (!check.ok) return { ok: false, error: check.error };

    const nowIso = new Date().toISOString();
    const workerName = worker.displayName || worker.email || null;
    const updates = {
        endTime,
        durationMinutes: check.durationMinutes,
        date: check.date,
        // Audit, shared with the admin editor so every corrected row reads the same way in the UI…
        edited: true,
        editedBy: worker.uid,
        editedByName: workerName || 'Nežinomas',
        editedAt: nowIso,
        editReason: trimmedReason,
        // …plus the marker that says WHO corrected it and, to the rules, that this row's duration may
        // only ever move down from here (until a manager edit clears it).
        selfAdjusted: true,
        selfAdjustedAt: nowIso,
        updatedAt: nowIso,
    };
    // Snapshot the TRUE original exactly once — same rule as editWorkSession: on an already-edited
    // row the first-captured original is kept, so the audit always points back at what the timer
    // actually recorded rather than at the previous correction.
    if (!session.edited) {
        updates.originalStartTime = session.startTime ?? null;
        updates.originalEndTime = session.endTime ?? null;
        updates.originalDurationMinutes = sessionDurationOf(session);
    }

    try {
        await updateDoc(doc(db, 'work_sessions', session.id), updates);
        const rec = await reconcileTaskTimerFromSessions(session.taskId, worker.uid, check.deltaMinutes);
        const reconciled = noteReconcileOutcome(rec, { source: 'reconcile:reduceOwnWorkSession', taskId: session.taskId });
        // FYI to every admin that credited time was reduced without approval. notifyMany dedupes and
        // drops the actor, so an admin correcting their own row never self-notifies; userId == the
        // worker's uid satisfies the rules' provenance check on a worker-authored notification.
        await notifyMany(adminUids, {
            type: 'time_self_reduced',
            actorUid: worker.uid,
            actorName: workerName,
            userId: worker.uid,
            userName: workerName,
            day: check.date,
            taskTitle: session.taskTitle || null,
            summary: `${formatMinutesToTimeString(sessionDurationOf(session))} → ${formatMinutesToTimeString(check.durationMinutes)}`,
            reason: trimmedReason,
        });
        return { ok: true, durationMinutes: check.durationMinutes, date: check.date, reconciled };
    } catch (err) {
        logError(err, { source: 'writeFail:reduceOwnWorkSession', sessionId: session.id });
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
        // Deterministic id keyed on (taskId, gap start): the same gap auto-claimed by two tabs or
        // devices (each ran orphan recovery on its own snapshot) converges on ONE row — and the
        // recovery notice's sessionId then points at THE row, so a "Nedirbau" opt-out removes all
        // of the credited time, never leaving an invisible sibling duplicate behind.
        const ref = doc(db, 'work_sessions', `sess_gap_${task.id}_${new Date(startTime).getTime()}`);
        // That same deterministic id is what makes a DELTA unsafe by default here: unlike the
        // backdate's addDoc, a second claim of the same gap lands on the SAME row and adds no
        // credited time at all, so incrementing the counter for it would inflate the task above the
        // ledger. Prove the row is genuinely new before treating this as an addition — and if the
        // read cannot answer (offline, denied), claim nothing and fall back to the old fail-closed
        // behaviour. Over-stating a task's time is worse than a stale, repairable counter.
        let isNewClaim = false;
        try {
            isNewClaim = !(await getDoc(ref)).exists();
        } catch {
            // unreadable → not provably new → no delta
        }
        await setDoc(ref, payload, { merge: true });
        // Fold the just-claimed offline gap into the task counter so its sheet/earnings/monitor match
        // the report (recovery already credited the pre-gap segments; this adds the remainder). The
        // worker's own uid keeps the sessions read inside what the rules grant them.
        const rec = await reconcileTaskTimerFromSessions(
            task.id, worker.uid, isNewClaim ? derived.durationMinutes : undefined
        );
        const reconciled = noteReconcileOutcome(rec, { source: 'reconcile:claimRecoveredGap', taskId: task.id });
        return { ok: true, id: ref.id, durationMinutes: derived.durationMinutes, date: derived.date, reconciled };
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
 * @param {Object} args - { sessionId, taskId } sessionId is the work_sessions id returned by
 *   claimRecoveredGap; taskId (optional) is the gap's task, so the counter can be re-derived after
 *   the gap is removed (omit for a synthetic/unknown task — reconciliation then no-ops). The
 *   session's owner uid is read off the row itself, so the caller does not have to supply it.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export const discardRecoveredGap = async ({ sessionId, taskId } = {}) => {
    if (!sessionId) return { ok: false, error: 'session' };
    const ref = doc(db, 'work_sessions', sessionId);
    try {
        // Read the row BEFORE deleting it, purely to learn its OWNER: the recovery banner only knows
        // the session + task ids, and without the owner uid the reconcile query below is denied for a
        // plain worker — which is how "Nedirbau" used to drop the session from the reports while
        // leaving the credited minutes sitting on the task card. Best-effort: an unreadable row just
        // reconciles without the hint, exactly as before.
        // The SAME read also yields the exactly-once delta: `durationMinutes` is the credited time
        // this row is about to take away, and reading it BEFORE the delete is what makes the removal
        // countable at most once — a repeat "Nedirbau" on an already-deleted gap finds nothing, so it
        // subtracts nothing. An unreadable row yields no delta and keeps the old fail-closed path.
        let ownerUid = null;
        let removedMinutes;
        try {
            const snap = await getDoc(ref);
            if (snap.exists()) {
                ownerUid = snap.data()?.userId || null;
                const held = snap.data()?.durationMinutes;
                if (typeof held === 'number' && held > 0) removedMinutes = -held;
            }
        } catch {
            // ignore — removing the gap is the operation that must not be blocked
        }
        await deleteDoc(ref);
        // The gap is gone — bring the task counter down with it so its sheet/earnings/monitor stop
        // showing time the report no longer contains.
        const rec = await reconcileTaskTimerFromSessions(taskId, ownerUid, removedMinutes);
        const reconciled = noteReconcileOutcome(rec, { source: 'reconcile:discardRecoveredGap', taskId });
        return { ok: true, reconciled };
    } catch (err) {
        logError(err, { source: 'writeFail:discardRecoveredGap' });
        return { ok: false, error: 'write' };
    }
};
