import { doc, updateDoc, addDoc, collection } from 'firebase/firestore';
import { db } from '../firebase';
import { getLithuanianDateString, MAX_SESSION_MINUTES } from './timeUtils';
import { logError } from './errorLog';

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
