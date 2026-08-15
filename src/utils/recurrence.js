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

// Multi-week cadence for the weekly frequency: fire on the chosen weekdays every N weeks. A 2- or
// 4-week rotation needs a phase (which weeks are "on"), so the rule also carries an `anchorDate`
// whose week defines week 0 of the cycle. interval=1 is plain "every week" and ignores the anchor.
export const RECURRENCE_INTERVALS = [
    { value: 1, label: 'Kas savaitę' },
    { value: 2, label: 'Kas 2 savaites' },
    { value: 4, label: 'Kas 4 savaites' },
];

// ISO weekday convention: 1=Mon … 7=Sun. The recurring roster is overwhelmingly "weekly on
// Monday", so weekday selection is the core of the model. `plural` is the instrumental plural used
// when a sentence names the days a rule fires on ("Kas savaitę, pirmadieniais"); `short` is the
// dense form for the manager's cadence editor, where a 7-day picker has no room for full names.
export const WEEKDAYS = [
    { iso: 1, short: 'Pr', label: 'Pirmadienis', plural: 'pirmadieniais' },
    { iso: 2, short: 'An', label: 'Antradienis', plural: 'antradieniais' },
    { iso: 3, short: 'Tr', label: 'Trečiadienis', plural: 'trečiadieniais' },
    { iso: 4, short: 'Kt', label: 'Ketvirtadienis', plural: 'ketvirtadieniais' },
    { iso: 5, short: 'Pn', label: 'Penktadienis', plural: 'penktadieniais' },
    { iso: 6, short: 'Št', label: 'Šeštadienis', plural: 'šeštadieniais' },
    { iso: 7, short: 'Sk', label: 'Sekmadienis', plural: 'sekmadieniais' },
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

// Monday-aligned absolute week index of a YYYY-MM-DD (UTC calendar arithmetic, so DST-independent
// and identical on every device — same discipline as isoWeekday). 1970-01-01 is a Thursday, so
// +3 shifts the boundary onto Monday: each Monday increments the index by one. Two dates share an
// index iff they fall in the same Mon–Sun week. Used to phase an "every N weeks" cadence against a
// rule's anchor week.
export function weekIndex(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    if (!y || !m || !d) return null;
    const dayNum = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
    return Math.floor((dayNum + 3) / 7);
}

// A fresh recurrence object for a new recurring template — weekly on Monday, every week, active.
export function defaultRecurrence() {
    return {
        active: true,
        freq: 'weekly',
        byWeekday: [1],
        interval: 1,        // weeks between firings (weekly freq only); 1 = every week
        anchorDate: null,   // YYYY-MM-DD whose week is cycle week 0 — only used when interval > 1
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
            if (!days.includes(wd)) return false;
            // Multi-week cadence: only fire in weeks that are a whole multiple of `interval` away
            // from the anchor week. interval≤1 (or a missing/legacy interval) means every week, so
            // pre-interval rules behave exactly as before. A missing anchor also degrades to weekly.
            const interval = Math.floor(Number(recurrence.interval) || 1);
            if (interval <= 1 || !recurrence.anchorDate) return true;
            const wi = weekIndex(dateStr);
            const ai = weekIndex(recurrence.anchorDate);
            if (wi == null || ai == null) return true;
            return (((wi - ai) % interval) + interval) % interval === 0;
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

/**
 * PURE: the next occurrence that has NOT been materialized yet — the first one still ahead of the
 * generator. `nextOccurrence` counts TODAY as an occurrence, but the scheduled job runs at 05:00
 * Vilnius and stamps `recurrence.lastGeneratedDate` when it writes today's task. So once today has
 * fired, "next" must start at tomorrow, or the manager's "Praleisti kitą" targets a day whose task
 * already exists (an inert skip that still reports success) and the task preview's "Kita:" names a
 * day that is already on the board.
 */
export function nextPendingOccurrence(recurrence, today = getLithuanianDateString()) {
    if (!recurrence) return null;
    const from = recurrence.lastGeneratedDate === today ? addDaysToDateString(today, 1) : today;
    return nextOccurrence(recurrence, from);
}

// Lithuanian enumeration: "a, b ir c" — the final item joined with "ir", not a comma.
function joinLithuanian(parts) {
    if (parts.length <= 1) return parts.join('');
    return `${parts.slice(0, -1).join(', ')} ir ${parts[parts.length - 1]}`;
}

/**
 * Lithuanian one-line summary of a recurrence (formal register). One voice for every surface that
 * has to say when work repeats.
 *
 * Two registers of the SAME sentence: the default dense form for the manager's template list
 * ("Kas savaitę: Pr, Pn"), and `{ long: true }` for a worker-facing surface with room to spell the
 * days out ("Kas savaitę, pirmadieniais ir penktadieniais") — the abbreviations are the cadence
 * editor's shorthand and should not be the only way a Meistras learns which day their job lands on.
 */
export function describeRecurrence(recurrence, { long = false } = {}) {
    if (!recurrence) return '';
    // A paused RULE and a paused TIMER are different things, and the task preview shows both at
    // once — a bare "Pristabdyta" there would sit beside the status pill's "Pristabdyta" and read
    // as one claim. The long register therefore names what is paused.
    if (recurrence.active === false) return long ? 'Kartojimas pristabdytas' : 'Pristabdyta';
    switch (recurrence.freq) {
        case 'daily':
            return 'Kasdien';
        case 'weekly': {
            const days = Array.isArray(recurrence.byWeekday) ? recurrence.byWeekday : [];
            const interval = Math.floor(Number(recurrence.interval) || 1);
            // The long form reuses the interval picker's own labels ("Kas 2 savaites"), so the
            // sentence reads the way the manager set it; the dense form keeps the "sav." shorthand.
            const intervalLabel = RECURRENCE_INTERVALS.find((o) => o.value === interval)?.label;
            const cadence = long
                ? (intervalLabel || `Kas ${interval} sav.`)
                : (interval > 1 ? `Kas ${interval} sav.` : 'Kas savaitę');
            if (!days.length) return cadence;
            const picked = WEEKDAYS.filter((w) => days.includes(w.iso));
            if (long) return `${cadence}, ${joinLithuanian(picked.map((w) => w.plural))}`;
            return `${cadence}: ${picked.map((w) => w.short).join(', ')}`;
        }
        case 'monthly':
            return `Kas mėnesį, ${recurrence.byMonthDay || 1} d.`;
        default:
            return '';
    }
}
