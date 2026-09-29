// Worker → manager TIME CORRECTION REQUEST ("Pranešti apie laiko klaidą").
//
// One request type covers every way a worker's logged day can be wrong. The worker picks WHAT went
// wrong from a handful of kinds; the form pre-fills the rest from the day's own rows; the request
// lands in the manager's bell as a concrete, already-worked-out fix they answer with Taip / Ne.
//
// The request is the notification itself (no new collection — the time_gap_claim precedent, ADR
// 0025): every field the manager's "Taip" needs rides on the request_notifications document as
// machine-readable data, and `commentText` carries the same thing as one human line for the push.
//
// Which kinds need a manager at all follows ADR 0023's incentive rule:
//   • missed_stop  — giving time BACK. Self-punishing, so it is applied on the spot through the
//                    existing one-way self-reduction (reduceOwnWorkSession); admins get the FYI.
//   • missed_start — ADDS paid time → request; "Taip" credits the interval (creditRequestedSession).
//   • wrong_time   — a different start/end on an existing row. An earlier END with the same start is
//                    a reduction (applied on the spot); anything else is a request, and "Taip"
//                    replays it through the admin editor (applyRequestedSessionTimes).
//   • break_was_work / other — carried to the manager as information only. Reclassifying a break
//                    is a three-part privileged write with no in-app editor yet (founder decision
//                    2026-09-29: manual in the first version), and free text has nothing to apply —
//                    unless the AI turned it into one of the kinds above, which the worker confirmed.
import { addDaysToDateString, vilniusWallClockToISO, WORK_DAY_START_HOUR, formatMinutesToTimeString } from './timeUtils';
import { formatTime } from './formatters';
import { creditRequestedSession, applyRequestedSessionTimes } from './sessionEditActions';

export const CORRECTION_KINDS = Object.freeze({
    MISSED_START: 'missed_start',
    MISSED_STOP: 'missed_stop',
    WRONG_TIME: 'wrong_time',
    BREAK_WAS_WORK: 'break_was_work',
    OTHER: 'other',
});

// Worker-facing labels (the chips) and the manager-facing one-liners. Formal "Jūs" on the worker side.
export const CORRECTION_KIND_LABELS = Object.freeze({
    missed_start: 'Pamiršau paleisti laikmatį',
    missed_stop: 'Pamiršau sustabdyti laikmatį',
    wrong_time: 'Neteisingas laikas',
    break_was_work: 'Pauzė buvo darbas',
    other: 'Kita',
});

export const CORRECTION_KIND_MANAGER_LABELS = Object.freeze({
    missed_start: 'Pamiršo paleisti laikmatį',
    missed_stop: 'Pamiršo sustabdyti laikmatį',
    wrong_time: 'Neteisingas laikas',
    break_was_work: 'Pauzė buvo darbas',
    other: 'Kita',
});

// A request becomes a one-tap "Taip" only when it carries everything the write needs.
export const isApplicableCorrection = (n) => {
    if (!n || !n.userId) return false;
    if (n.correctionKind === CORRECTION_KINDS.MISSED_START) return !!(n.requestedStartTime && n.requestedEndTime);
    if (n.correctionKind === CORRECTION_KINDS.WRONG_TIME) return !!(n.sessionRef && n.requestedStartTime && n.requestedEndTime);
    return false;
};

/**
 * A typed clock time on a WORK day → an instant. The work day runs 05:00→05:00, so a time before
 * WORK_DAY_START_HOUR belongs to the NEXT calendar date (a 01:30 entry on work day 09-29 happened on
 * 09-30). vilniusWallClockToISO needs that true calendar date, or the instant lands 24h off.
 */
export const workDayClockToISO = (workDay, hhmm) => {
    if (typeof hhmm !== 'string') return null;
    const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const calendarDay = Number(m[1]) < WORK_DAY_START_HOUR ? addDaysToDateString(workDay, 1) : workDay;
    return vilniusWallClockToISO(calendarDay, hhmm);
};

const ms = (iso) => new Date(iso).getTime();

/** The first row among `rows` whose [startTime, endTime) intersects [startISO, endISO), or null. */
export const findOverlap = (startISO, endISO, rows = [], { ignoreId } = {}) => {
    const a = ms(startISO);
    const b = ms(endISO);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return rows.find((r) => {
        if (!r || r.id === ignoreId || !r.startTime || !r.endTime) return false;
        return ms(r.startTime) < b && ms(r.endTime) > a;
    }) || null;
};

/** Duration of [startISO, endISO) in whole minutes, or null when not a forward interval. */
export const intervalMinutes = (startISO, endISO) => {
    const d = (ms(endISO) - ms(startISO)) / 60000;
    return Number.isFinite(d) && d > 0 ? Math.round(d) : null;
};

/**
 * The "Taip" preview the manager reads: the net change to paid time and one line saying what it is.
 * Pure — used by the manager card and by the worker's confirm step so both describe the same fix.
 */
export const describeCorrection = (n) => {
    const span = n.requestedStartTime && n.requestedEndTime
        ? `${formatTime(n.requestedStartTime)}–${formatTime(n.requestedEndTime)}`
        : '';
    const newMin = intervalMinutes(n.requestedStartTime, n.requestedEndTime);
    if (n.correctionKind === CORRECTION_KINDS.MISSED_START) {
        return {
            delta: newMin ? `+${formatMinutesToTimeString(newMin)}` : '',
            detail: [n.taskTitle || 'Kita veikla', span].filter(Boolean).join(', '),
        };
    }
    if (n.correctionKind === CORRECTION_KINDS.WRONG_TIME) {
        const oldMin = intervalMinutes(n.originalStartTime, n.originalEndTime);
        const diff = newMin != null && oldMin != null ? newMin - oldMin : null;
        const from = n.originalStartTime && n.originalEndTime
            ? `${formatTime(n.originalStartTime)}–${formatTime(n.originalEndTime)}`
            : '';
        return {
            delta: diff == null || diff === 0 ? '' : `${diff > 0 ? '+' : '−'}${formatMinutesToTimeString(Math.abs(diff))}`,
            detail: [n.taskTitle, from && span ? `${from} → ${span}` : span].filter(Boolean).join(', '),
        };
    }
    if (n.correctionKind === CORRECTION_KINDS.BREAK_WAS_WORK) {
        return {
            delta: newMin ? `+${formatMinutesToTimeString(newMin)}` : '',
            detail: [`Pertrauka ${span}`.trim(), n.taskTitle].filter(Boolean).join(' → '),
        };
    }
    return { delta: '', detail: '' };
};

// Clamp the worker's own words before they ride on a document that reaches a lockscreen.
const clampNote = (text, max = 500) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The request_notifications payload (minus recipient) for notifyMany. `commentText` is the one human
 * line the push and older renderers show; every other field is what the manager's card acts on.
 */
export const buildCorrectionRequest = ({
    kind, day, worker, taskId, taskTitle, startTime, endTime, sessionRef, breakRef,
    originalStartTime, originalEndTime, note, aiSuggested = false,
}) => {
    const workerName = worker?.name || null;
    const base = {
        correctionKind: kind,
        day,
        requestedStartTime: startTime || null,
        requestedEndTime: endTime || null,
        taskId: taskId || null,
        taskTitle: taskTitle || null,
        originalStartTime: originalStartTime || null,
        originalEndTime: originalEndTime || null,
    };
    const { delta, detail } = describeCorrection(base);
    const workerNote = clampNote(note);
    const head = CORRECTION_KIND_MANAGER_LABELS[kind] || CORRECTION_KIND_MANAGER_LABELS.other;
    const line = [
        `${head}.`,
        [day, detail, delta].filter(Boolean).join(' · '),
        workerNote ? `„${workerNote}“` : '',
    ].filter(Boolean).join(' ');
    return {
        type: 'time_correction_request',
        actorUid: worker?.uid,
        actorName: workerName,
        userId: worker?.uid,
        userName: workerName,
        ...base,
        // sessionRef is validated by the request_notifications create rule: it must name one of the
        // caller's OWN work_sessions, so a request cannot point a manager at a colleague's row.
        sessionRef: sessionRef || null,
        breakRef: breakRef || null,
        workerNote: workerNote || null,
        aiSuggested: !!aiSuggested,
        commentText: line.slice(0, 2000),
    };
};

/**
 * The manager's "Taip". Dispatches on the request's kind to the write that settles it. Every write is
 * an existing, owner-checked admin path — nothing here trusts the notification beyond what those
 * paths re-verify. Returns the underlying { ok, error } unchanged ('unsupported' for an info-only kind).
 */
export const applyTimeCorrectionRequest = async ({ notif, editor }) => {
    if (!isApplicableCorrection(notif)) return { ok: false, error: 'unsupported' };
    const reason = notif.workerNote
        ? `Patvirtintas meistro prašymas: ${notif.workerNote}`
        : `Patvirtintas meistro prašymas: ${CORRECTION_KIND_MANAGER_LABELS[notif.correctionKind]}`;
    if (notif.correctionKind === CORRECTION_KINDS.MISSED_START) {
        return creditRequestedSession({
            taskId: notif.taskId,
            taskTitle: notif.taskTitle,
            expectedUserId: notif.userId,
            workerName: notif.userName,
            startTime: notif.requestedStartTime,
            endTime: notif.requestedEndTime,
            reason,
            editor,
        });
    }
    return applyRequestedSessionTimes({
        sessionId: notif.sessionRef,
        startTime: notif.requestedStartTime,
        endTime: notif.requestedEndTime,
        reason,
        editor,
        expectedUserId: notif.userId,
    });
};

/** Is `iso` still on or before now? A request may never ask for time that has not happened yet. */
export const isNotFuture = (iso, now = new Date()) => ms(iso) <= now.getTime() + 60000;
