import {
    addDaysToDateString,
    getCurrentWorkDayCutoff,
    getLithuanianDateString,
    getLithuanianNow,
    vilniusWallClockToISO,
} from './timeUtils';

/**
 * TASK SNOOZE ("Atidėti iki") — park an active task out of the active list until a chosen instant,
 * then let it come back on its own. ADR 0033.
 *
 * Snooze changes VISIBILITY only. The task keeps its status, priority, deadline and every minute
 * of credited time; nothing about the work itself is rewritten, so a snooze is trivially
 * reversible and invisible to reports and pay. The state lives in plain task fields the assignee
 * may already write (no rules change):
 *
 *   snoozedUntil      ISO instant the task returns (null = not snoozed)
 *   snoozedBy / snoozedByName / snoozedAt   who parked it, and when
 *   snoozeReason      optional short reason chip (one of SNOOZE_REASONS)
 *   snoozeWakePending true until the server has sent the "returned" push (wakeSnoozedTasks)
 *
 * "Snoozed" is derived from the clock at read time — no job has to flip anything for the task to
 * come back. A RUNNING task is never treated as snoozed, so a live timer can never hide.
 */

// Every preset (and a custom date) returns the task at this Vilnius wall-clock time.
export const SNOOZE_RETURN_TIME = '07:00';

// Optional reason chips. Short, worker-facing, Lithuanian (formal register needs no verb here).
export const SNOOZE_REASONS = ['Laukiu medžiagų', 'Laukiu kliento', 'Oras', 'Kita'];

// The fields a snooze write owns — the undo restores exactly these.
export const SNOOZE_FIELDS = [
    'snoozedUntil',
    'snoozedBy',
    'snoozedByName',
    'snoozedAt',
    'snoozeReason',
    'snoozeWakePending',
];

const WEEKDAY_SHORT = ['sekm.', 'pirm.', 'antr.', 'treč.', 'ketv.', 'penkt.', 'šešt.'];

const toMs = (value) => {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
};

const nowMs = (now) => (now instanceof Date ? now.getTime() : Number(now));

// Weekday (0 = Sunday) of a YYYY-MM-DD calendar string. Pure UTC arithmetic — the string already
// IS the Vilnius day, so no timezone conversion belongs here.
const weekdayOf = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const isFinishedOrGone = (task) =>
    !task ||
    task.isDeleted === true ||
    task.completed === true ||
    task.status === 'deleted' ||
    task.status === 'completed' ||
    task.status === 'confirmed';

const isRunningTask = (task) => task?.timerStatus === 'running' || task?.workStatus === 'running';

/** Is the task parked right now (return instant still in the future, and not running)? */
export const isTaskSnoozed = (task, now = getLithuanianNow()) => {
    const until = toMs(task?.snoozedUntil);
    if (until == null || until <= nowMs(now)) return false;
    return !isRunningTask(task) && !isFinishedOrGone(task);
};

/**
 * Did the task come back from a snooze during the CURRENT work day? Drives the "Grįžo" badge, so
 * a returned task is recognisable in the list for the rest of the day it reappeared, then quietly
 * drops the badge.
 */
export const hasReturnedFromSnooze = (task, now = getLithuanianNow()) => {
    const until = toMs(task?.snoozedUntil);
    if (until == null || until > nowMs(now)) return false;
    if (isFinishedOrGone(task)) return false;
    return until >= getCurrentWorkDayCutoff(now instanceof Date ? now : new Date(now)).getTime();
};

/**
 * Who may snooze this task from this surface: its assignee, or a manager (the Firestore rule then
 * decides whether that manager's scope reaches the task). Only active, approved, non-running work
 * qualifies — an unapproved task is already parked in "Laukia patvirtinimo", and quick work / calls
 * never sit in the active list.
 */
export const canSnoozeTask = ({ task, currentUser, isManager = false, isRunning = false }) => {
    if (!task?.id || !currentUser?.uid) return false;
    if (task.isArchived || task.isSystemTask || task.isQuickWork) return false;
    if (isFinishedOrGone(task) || task.status === 'unapproved') return false;
    if (isRunning || isRunningTask(task)) return false;
    return task.assignedUserId === currentUser.uid || isManager;
};

/**
 * Split a list into the active part and the parked part. Order inside each part is the input's
 * (canonical) order, except the parked list, which is soonest-to-return first.
 */
export const splitSnoozedTasks = (tasks, now = getLithuanianNow()) => {
    const active = [];
    const snoozed = [];
    for (const task of tasks || []) {
        if (isTaskSnoozed(task, now)) snoozed.push(task);
        else active.push(task);
    }
    snoozed.sort((a, b) => toMs(a.snoozedUntil) - toMs(b.snoozedUntil));
    return { active, snoozed };
};

/** The soonest future return instant (epoch ms) among the tasks, or null when none is parked. */
export const nextSnoozeWakeMs = (tasks, now = getLithuanianNow()) => {
    let next = null;
    for (const task of tasks || []) {
        if (!isTaskSnoozed(task, now)) continue;
        const until = toMs(task.snoozedUntil);
        if (next == null || until < next) next = until;
    }
    return next;
};

/**
 * The quick-pick return instants, all at {@link SNOOZE_RETURN_TIME} Vilnius:
 *   - next WORK day (tomorrow, or Monday when tomorrow is a weekend day)
 *   - next Monday (dropped when it is the same day as the first preset)
 *   - one week from today
 *
 * @returns {Array<{key:string,label:string,until:string,dateStr:string}>}
 */
export const getSnoozePresets = (now = getLithuanianNow()) => {
    const today = getLithuanianDateString(now);
    const tomorrow = addDaysToDateString(today, 1);
    const tomorrowWd = weekdayOf(tomorrow);
    const nextWorkDay = tomorrowWd === 6
        ? addDaysToDateString(tomorrow, 2)
        : tomorrowWd === 0 ? addDaysToDateString(tomorrow, 1) : tomorrow;
    const todayWd = weekdayOf(today);
    const nextMonday = addDaysToDateString(today, ((8 - todayWd) % 7) || 7);
    const inAWeek = addDaysToDateString(today, 7);

    const at = (dateStr) => vilniusWallClockToISO(dateStr, SNOOZE_RETURN_TIME);
    const presets = [{
        key: 'next-work-day',
        label: nextWorkDay === tomorrow ? 'Rytoj rytą' : 'Pirmadienį rytą',
        until: at(nextWorkDay),
        dateStr: nextWorkDay,
    }];
    if (nextMonday !== nextWorkDay) {
        presets.push({ key: 'monday', label: 'Pirmadienį', until: at(nextMonday), dateStr: nextMonday });
    }
    presets.push({ key: 'week', label: 'Po savaitės', until: at(inAWeek), dateStr: inAWeek });
    return presets;
};

/** The earliest date a custom snooze may pick (tomorrow, Vilnius) as YYYY-MM-DD. */
export const getSnoozeMinDate = (now = getLithuanianNow()) =>
    addDaysToDateString(getLithuanianDateString(now), 1);

/** A custom date (YYYY-MM-DD) → its return instant at {@link SNOOZE_RETURN_TIME} Vilnius. */
export const snoozeUntilForDate = (dateStr) => vilniusWallClockToISO(dateStr, SNOOZE_RETURN_TIME);

const vilniusClock = (date) =>
    new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Vilnius',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(date);

/**
 * Short, relative description of a return instant: "šiandien 15:00", "rytoj 07:00",
 * "pirm. 07:00" (within the coming week), else "10.28 07:00" (the deadline chip's MM.DD style).
 */
export const formatSnoozeUntil = (untilIso, now = getLithuanianNow()) => {
    const ms = toMs(untilIso);
    if (ms == null) return '';
    const date = new Date(ms);
    const day = getLithuanianDateString(date);
    const today = getLithuanianDateString(now);
    const clock = vilniusClock(date);
    if (day === today) return `šiandien ${clock}`;
    if (day === addDaysToDateString(today, 1)) return `rytoj ${clock}`;
    if (day > today && day <= addDaysToDateString(today, 6)) return `${WEEKDAY_SHORT[weekdayOf(day)]} ${clock}`;
    return `${day.slice(5, 7)}.${day.slice(8, 10)} ${clock}`;
};

/**
 * Would returning at `untilIso` land AFTER the task's deadline day? A warning only — the snooze is
 * still allowed (the worker may know the deadline is soft); the sheet just says so.
 */
export const snoozePassesDeadline = (task, untilIso) => {
    if (!task?.deadline) return false;
    const deadlineMs = toMs(task.deadline);
    const untilMs = toMs(untilIso);
    if (deadlineMs == null || untilMs == null) return false;
    return getLithuanianDateString(new Date(untilMs)) > getLithuanianDateString(new Date(deadlineMs));
};
