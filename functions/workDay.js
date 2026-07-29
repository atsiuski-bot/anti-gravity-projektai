/**
 * The Vilnius WORK-DAY boundary, server side — and the archive rule built on it.
 *
 * Pure and dependency-free (like integrityScans.js / decisionLog.js) so `node functions/workDay.test.cjs`
 * can assert the date math with no Firestore and no emulator. index.js does the I/O.
 *
 * These are MIRRORS of src/utils/timeUtils.js (WORK_DAY_START_HOUR, getWorkDayCutoff,
 * getCurrentWorkDayCutoff) and of the archive predicate that used to live in
 * src/utils/automationUtils.js. The client and the server must agree about which day a finished task
 * belongs to: the server decides when a task LEAVES the active lists, the client decides what it
 * SHOWS in them, so a disagreement makes tasks vanish from a manager's screen a cycle early or linger
 * a cycle late. src/__tests__/firebaseConsistency.test.js locks the pair.
 */

// The Vilnius wall-clock hour at which one work day ends and the next begins. Deliberately not
// midnight: a shift that runs past 00:00 is the same working day to the person doing it, so a task
// finished at 01:00 must not drop out of "today". MIRROR of timeUtils WORK_DAY_START_HOUR.
const WORK_DAY_START_HOUR = 5;

/** The Vilnius calendar day of an instant, as 'YYYY-MM-DD' (en-CA renders in that order). */
function lithuanianDay(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Vilnius', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
}

/**
 * The UTC instant of the work-day boundary on a given Vilnius calendar day.
 *
 * Vilnius is UTC+2 in winter and UTC+3 in summer, so the boundary's UTC hour moves with DST. The
 * offset is read from a NOON reference because noon never falls inside the spring-forward gap, where
 * a local hour can simply not exist — deriving it by stepping toward the boundary oscillates on that
 * one day a year and yields an off-by-one-hour cutoff.
 */
function workDayCutoffUtc(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const localNoonHour = parseInt(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Vilnius', hour: 'numeric', hour12: false,
    }).format(noonUtc), 10);
    const offsetHours = localNoonHour - 12; // 2 winter, 3 summer
    return new Date(Date.UTC(y, m - 1, d, WORK_DAY_START_HOUR - offsetHours, 0, 0));
}

/** 'YYYY-MM-DD' shifted by whole days, via UTC so no local timezone can bend it. */
function addDaysToDay(dateStr, delta) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/**
 * The current work day as a Vilnius date string. BEFORE the boundary the work day still belongs to
 * the previous calendar day — without that rollback, work finished just after midnight would sit
 * before today's still-future boundary and be treated as belonging to a day that has not started.
 */
function currentWorkDay(now) {
    const day = lithuanianDay(now);
    return now < workDayCutoffUtc(day) ? addDaysToDay(day, -1) : day;
}

/**
 * Is this task from a PREVIOUS work cycle, i.e. ready to leave the active lists for the archive?
 *
 * The timestamp that matters is when the task reached its terminal state (soft-deleted, else
 * accepted, else last touched). It is a UTC ISO string, so it is bucketed to its VILNIUS day before
 * comparing against the current work day — comparing the string's date prefix would take the UTC
 * date, and a task accepted between 21:00 and midnight Vilnius in summer carries a UTC date one day
 * earlier and would be archived a whole cycle too soon.
 *
 * A task with no usable timestamp is left alone rather than archived: nothing here is urgent enough
 * to justify moving a document on a guess.
 */
function taskArchivable(task, currentDay) {
    if (!task) return false;
    const relevant = task.deletedAt || task.confirmedAt || task.updatedAt;
    if (!relevant) return false;
    const at = new Date(relevant);
    if (Number.isNaN(at.getTime())) return false;
    return lithuanianDay(at) < currentDay;
}

module.exports = {
    WORK_DAY_START_HOUR,
    lithuanianDay,
    workDayCutoffUtc,
    addDaysToDay,
    currentWorkDay,
    taskArchivable,
};
