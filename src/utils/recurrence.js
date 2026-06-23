// Recurring-task cadence model. A recurrence descriptor lives on a `task_templates` doc (NOT a
// separate collection — the lean design both adversarial reviews converged on): the template's
// `data` is the task payload, and this `recurrence` object says WHEN to materialize it. The
// scheduled generator (functions/index.js) reads it server-side; the manager UI edits it and
// previews it client-side. The pure firing logic (recurrenceFiresOn) is intentionally tiny and is
// MIRRORED in the Cloud Function — keep the two copies in lockstep when changing either.

import { getLithuanianDateString, addDaysToDateString } from './timeUtils';

export const RECURRENCE_FREQS = [
    { value: 'daily', label: 'Kasdien' },
    { value: 'weekly', label: 'Kas savaitę' },
    { value: 'monthly', label: 'Kas mėnesį' },
];

// ISO weekday convention: 1=Mon … 7=Sun. The recurring roster is overwhelmingly "weekly on
// Monday", so weekday selection is the core of the model.
export const WEEKDAYS = [
    { iso: 1, short: 'Pr', label: 'Pirmadienis' },
    { iso: 2, short: 'An', label: 'Antradienis' },
    { iso: 3, short: 'Tr', label: 'Trečiadienis' },
    { iso: 4, short: 'Kt', label: 'Ketvirtadienis' },
    { iso: 5, short: 'Pn', label: 'Penktadienis' },
    { iso: 6, short: 'Št', label: 'Šeštadienis' },
    { iso: 7, short: 'Sk', label: 'Sekmadienis' },
];

// ISO weekday (1=Mon…7=Sun) of a YYYY-MM-DD string, via UTC calendar arithmetic so it is
// DST-independent and identical on every device (the same technique as getLithuanianWeekId).
export function isoWeekday(dateStr) {
    const parts = String(dateStr).split('-').map(Number);
    const [y, m, d] = parts;
    if (!y || !m || !d) return null;
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun…6=Sat
    return dow === 0 ? 7 : dow;
}

// Calendar days in a given month (month is 1-12). Day 0 of the next month is the last day of this
// one. Used to clamp a monthly rule's target day (e.g. "31st" → Feb's 28th/29th).
export function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// A fresh recurrence object for a new recurring template — weekly on Monday, active.
export function defaultRecurrence() {
    return {
        active: true,
        freq: 'weekly',
        byWeekday: [1],
        byMonthDay: 1,
        skipDates: [],
        lastGeneratedDate: null,
    };
}

/**
 * PURE: does this recurrence fire on the given Vilnius day (YYYY-MM-DD)?
 * Paused (active===false) and explicitly skipped days never fire. Monthly clamps a target day
 * past the month's length to the last day (so "31st" still fires in February).
 *
 * MIRRORED in functions/index.js (recurringFiresOn). Keep both copies identical.
 */
export function recurrenceFiresOn(recurrence, dateStr) {
    if (!recurrence || recurrence.active === false) return false;
    if (Array.isArray(recurrence.skipDates) && recurrence.skipDates.includes(dateStr)) return false;
    const wd = isoWeekday(dateStr);
    if (!wd) return false;

    switch (recurrence.freq) {
        case 'daily':
            return true;
        case 'weekly': {
            const days = Array.isArray(recurrence.byWeekday) ? recurrence.byWeekday : [];
            return days.includes(wd);
        }
        case 'monthly': {
            const [y, m, d] = dateStr.split('-').map(Number);
            const target = Math.min(recurrence.byMonthDay || 1, daysInMonth(y, m));
            return d === target;
        }
        default:
            return false;
    }
}

/**
 * Next Vilnius day (YYYY-MM-DD) on/after `fromDateStr` that the recurrence fires, scanning up to
 * `horizon` days. UI-only "next occurrence" preview. Returns null if none within the horizon.
 */
export function nextOccurrence(recurrence, fromDateStr = getLithuanianDateString(), horizon = 366) {
    if (!recurrence || recurrence.active === false) return null;
    let cur = fromDateStr;
    for (let i = 0; i < horizon; i += 1) {
        if (recurrenceFiresOn(recurrence, cur)) return cur;
        cur = addDaysToDateString(cur, 1);
    }
    return null;
}

// Lithuanian one-line summary of a recurrence for the management UI (formal register).
export function describeRecurrence(recurrence) {
    if (!recurrence) return '';
    if (recurrence.active === false) return 'Pristabdyta';
    switch (recurrence.freq) {
        case 'daily':
            return 'Kasdien';
        case 'weekly': {
            const days = Array.isArray(recurrence.byWeekday) ? recurrence.byWeekday : [];
            if (!days.length) return 'Kas savaitę';
            const names = WEEKDAYS.filter((w) => days.includes(w.iso)).map((w) => w.short);
            return `Kas savaitę: ${names.join(', ')}`;
        }
        case 'monthly':
            return `Kas mėnesį, ${recurrence.byMonthDay || 1} d.`;
        default:
            return '';
    }
}
