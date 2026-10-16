// Standing duties ("Savaitiniai darbai") — the pure model.
//
// A duty is NOT a task: it carries no timer and never touches work_sessions, so it can never
// change anyone's credited hours or pay. It holds one forward-moving watermark, `coveredThrough`
// (YYYY-MM-DD, inclusive): "reviews are sent up to 10-15". The time spent doing the duty is logged
// separately as ordinary current work. Status is derived purely from the watermark, the duty's
// cadence and today's Vilnius date, so every device computes the same verdict.

import { addDaysToDateString } from './timeUtils';

export const DUTY_INTERVALS = [
    { value: 7, label: 'Kas savaitę' },
    { value: 14, label: 'Kas 2 savaites' },
    { value: 30, label: 'Kas mėnesį' },
];

export const DUTY_TITLE_MAX = 120;
export const DUTY_NOTE_MAX = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isDutyDate = (value) => typeof value === 'string' && DATE_RE.test(value);

export const dutyIntervalLabel = (days) =>
    DUTY_INTERVALS.find((i) => i.value === days)?.label || `Kas ${days} d.`;

// Whole calendar days from `fromStr` to `toStr` (both YYYY-MM-DD), via UTC arithmetic so it is
// DST-independent — the same technique as addDaysToDateString.
export function daysBetween(fromStr, toStr) {
    const toUtc = (s) => {
        const [y, m, d] = s.split('-').map(Number);
        return Date.UTC(y, m - 1, d);
    };
    return Math.round((toUtc(toStr) - toUtc(fromStr)) / 86400000);
}

/**
 * Derive a duty's status for `today`.
 *
 * The next round is due `intervalDays` after the watermark: covered through 10-15 on a weekly
 * cadence → due 10-22. Late once today passes that date; "due soon" on the day before and the day
 * itself; on time otherwise. A duty never marked has no watermark to measure from.
 *
 * @param {{coveredThrough?: string|null, intervalDays?: number}} duty
 * @param {string} today - Vilnius calendar date, YYYY-MM-DD.
 * @returns {{kind: 'never'|'late'|'soon'|'ok', tone: string, label: string, nextDue: string|null, daysLate: number}}
 */
export function dutyStatus(duty, today) {
    const covered = duty?.coveredThrough;
    if (!isDutyDate(covered)) {
        return { kind: 'never', tone: 'pending', label: 'Dar nepažymėta', nextDue: null, daysLate: 0 };
    }
    const interval = Number(duty.intervalDays) > 0 ? Number(duty.intervalDays) : 7;
    const nextDue = addDaysToDateString(covered, interval);
    const daysUntil = daysBetween(today, nextDue);
    if (daysUntil < 0) {
        const daysLate = -daysUntil;
        return { kind: 'late', tone: 'danger', label: `Vėluoja ${daysLate} d.`, nextDue, daysLate };
    }
    if (daysUntil <= 1) {
        return { kind: 'soon', tone: 'pending', label: 'Artėja terminas', nextDue, daysLate: 0 };
    }
    return { kind: 'ok', tone: 'success', label: 'Laiku', nextDue, daysLate: 0 };
}

const KIND_RANK = { late: 0, never: 1, soon: 2, ok: 3 };

/**
 * Order duties so the ones needing attention come first: late (most days late first), never
 * marked, due soon, on time; ties by title.
 */
export function sortDuties(duties, today) {
    return [...duties]
        .map((d) => ({ duty: d, status: dutyStatus(d, today) }))
        .sort((a, b) =>
            KIND_RANK[a.status.kind] - KIND_RANK[b.status.kind]
            || b.status.daysLate - a.status.daysLate
            || String(a.duty.title || '').localeCompare(String(b.duty.title || ''), 'lt'))
        .map((x) => x.duty);
}

/**
 * Validate a "covered through" mark before it is written. The watermark may move BACK (fixing a
 * mis-tap is a legitimate correction and the history keeps both marks) and also AHEAD of today:
 * a duty is often prepared in advance (e.g. reviews entered through next Friday), founder
 * decision 2026-10-17. `today` stays in the signature so callers need not change; no date bound
 * applies.
 *
 * @returns {string|null} a Lithuanian error message, or null when valid.
 */
export function validateDutyMark(dateStr, today, note = '') {
    if (!isDutyDate(dateStr)) return 'Pasirinkite datą.';
    if (String(note).length > DUTY_NOTE_MAX) return `Pastaba per ilga (daugiausia ${DUTY_NOTE_MAX} simbolių).`;
    return null;
}

/** Validate a duty's editable fields. @returns {string|null} a Lithuanian error, or null. */
export function validateDutyFields({ title, intervalDays, ownerId }) {
    const t = String(title || '').trim();
    if (!t) return 'Įveskite pavadinimą.';
    if (t.length > DUTY_TITLE_MAX) return `Pavadinimas per ilgas (daugiausia ${DUTY_TITLE_MAX} simbolių).`;
    if (!DUTY_INTERVALS.some((i) => i.value === intervalDays)) return 'Pasirinkite dažnumą.';
    if (!ownerId) return 'Pasirinkite atsakingą asmenį.';
    return null;
}
