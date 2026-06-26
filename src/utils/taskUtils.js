import { getCurrentWorkDayCutoff, calculateCurrentTotalMinutes, parseTimeStringToMinutes } from './timeUtils';

// Task tags configuration
export const TASK_TAGS = ['Auto', 'Renginiams', 'Piro'];

/**
 * PERSONAL-list day window. Keeps every still-active task, but drops a finished
 * (completed/confirmed) task once it rolls past the current work day's 03:00 Vilnius cutoff — so
 * a person's OWN finished work stays visible for the rest of the day, then clears to history.
 * Shared by the worker's "Mano užduotys" and the manager's "Mano darbai" so the two personal
 * surfaces behave identically.
 *
 * Note the deliberate contrast with the shared TEAM list (scopeActiveTasks), which instead hides
 * finished AND unapproved items IMMEDIATELY: a worker's pending-approval task and any completed
 * work leave the common list at once and are reviewed in the approvals / history surfaces. A
 * personal list keeps the day window because it is the person's own running tally of today.
 *
 * @param {Array}  tasks  - Task docs to scope.
 * @param {Date}  [cutoff=getCurrentWorkDayCutoff()] - Work-day start (injectable for tests).
 * @returns {Array} Tasks visible in a personal list right now.
 */
export const scopePersonalDayWindow = (tasks, cutoff = getCurrentWorkDayCutoff()) => {
    if (!tasks) return [];
    return tasks.filter(task => {
        if (task.completed || task.status === 'completed' || task.status === 'confirmed') {
            const finishedAt = task.completedAt || task.confirmedAt || task.updatedAt;
            if (!finishedAt) return false;
            return new Date(finishedAt) >= cutoff;
        }
        return true;
    });
};

// Return only non-completed tasks AND non-system tasks (Call/QuickWork)
export const filterTasksByVisibility = (tasks) => {
    if (!tasks) return [];
    return tasks.filter(task => {
        // 1. Basic completion check (but allow deleted tasks which are marked as completed)
        if (task.completed && !task.isDeleted) return false;

        // 2. Explicitly hide Quick Work and Call tasks from the main list
        // These should only appear in Reports/History, never in the active "Tasks" tab
        if (task.isQuickWork) return false;
        if (task.isSystemTask) return false; // Covers "Call" tasks

        // 3. Exclude old-style soft-deleted tasks (status === 'deleted')
        // But allow new-style deleted tasks (status === 'completed' with isDeleted flag)
        if (task.status === 'deleted') return false;

        return true;
    });
};

import { getPriorityRank } from './priority';

/**
 * Time-progress completion fraction (0..1) of a task: spent vs estimated minutes — the card's
 * primary "% done" glance signal (founder decision 2026-06-26). No (or zero) estimate, or no time
 * spent yet, => 0; this also keeps a not-yet-measurable / not-started task BELOW a started one in
 * the canonical order, since completion is a descending key there.
 */
export const taskCompletionFraction = (task) => {
    if (!task) return 0;
    const est = parseTimeStringToMinutes(task.estimatedTime || '0');
    if (est <= 0) return 0;
    const spent = calculateCurrentTotalMinutes(task);
    if (spent <= 0) return 0;
    return Math.min(1, spent / est);
};

/**
 * Coerce a stored timestamp to epoch millis. createdAt is stored as an ISO string and deadline as
 * a 'YYYY-MM-DD' string, but team data can carry legacy shapes (number / Firestore Timestamp), so
 * this stays defensive. Returns null when there is nothing comparable.
 */
const toMillis = (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const t = new Date(value).getTime();
        return Number.isNaN(t) ? null : t;
    }
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.seconds === 'number') return value.seconds * 1000;
    if (value instanceof Date) return value.getTime();
    return null;
};

/**
 * compareTasksCanonical — THE one ordering used everywhere a task list is shown (worker + manager,
 * mobile + desktop, team list + personal list). Each key only breaks a tie left by the previous
 * one (founder spec 2026-06-26):
 *   0. finished (completed) tasks sink to the bottom — personal lists keep them for the work day.
 *   1. PRIORITY, descending — Skubus > Aukštas > Vidutinis > Žemas.
 *   2. MANUAL order within the priority — a per-task `boardRank` set by dragging in the desktop
 *      priority board. A card WITH a rank sorts above one without; two ranked cards sort by rank
 *      ascending. This is the SHARED manual override (stored on the task, so everyone sees the same
 *      order); when a column has been arranged every card in it carries a rank, so the whole column
 *      follows the manual order and keys 3–5 no longer reshuffle it.
 *   3. DEADLINE, ascending — sooner first; no deadline last.
 *   4. COMPLETION, descending — more of the planned time spent = more "done" = higher.
 *   5. CREATED, ascending — older tasks first (stable final tie-break).
 */
export const compareTasksCanonical = (a, b) => {
    // 0. finished last
    const aDone = !!a.completed;
    const bDone = !!b.completed;
    if (aDone !== bDone) return aDone ? 1 : -1;

    // 1. priority, descending
    const rankDiff = getPriorityRank(b.priority) - getPriorityRank(a.priority);
    if (rankDiff !== 0) return rankDiff;

    // 2. manual boardRank within the priority (present before absent; ranked by rank asc)
    const aHasRank = typeof a.boardRank === 'number';
    const bHasRank = typeof b.boardRank === 'number';
    if (aHasRank && bHasRank) {
        if (a.boardRank !== b.boardRank) return a.boardRank - b.boardRank;
    } else if (aHasRank !== bHasRank) {
        return aHasRank ? -1 : 1;
    }

    // 3. deadline, ascending (none last)
    const aDeadline = toMillis(a.deadline);
    const bDeadline = toMillis(b.deadline);
    const aD = aDeadline === null ? Infinity : aDeadline;
    const bD = bDeadline === null ? Infinity : bDeadline;
    if (aD !== bD) return aD - bD;

    // 4. completion, descending
    const compDiff = taskCompletionFraction(b) - taskCompletionFraction(a);
    if (Math.abs(compDiff) > 1e-9) return compDiff > 0 ? 1 : -1;

    // 5. createdAt, ascending (oldest first; missing last)
    const aCreated = toMillis(a.createdAt);
    const bCreated = toMillis(b.createdAt);
    const aC = aCreated === null ? Infinity : aCreated;
    const bC = bCreated === null ? Infinity : bCreated;
    if (aC !== bC) return aC - bC;
    return 0;
};

/** Stable, non-mutating canonical sort (see compareTasksCanonical). */
export const sortTasksCanonical = (tasksList) => [...(tasksList || [])].sort(compareTasksCanonical);

/**
 * Canonical order for every personal/own-task list (worker "Mano užduotys", manager "Mano darbai",
 * the pending-approval queue). Retained as a named alias so existing call sites keep reading, but it
 * now IS the single app-wide order — no separate worker-only comparator survives.
 */
export const sortWorkerTasks = (tasksList) => sortTasksCanonical(tasksList);
