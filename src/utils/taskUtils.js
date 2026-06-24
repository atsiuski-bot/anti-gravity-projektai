import { getCurrentWorkDayCutoff } from './timeUtils';

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

export const sortWorkerTasks = (tasksList) => {
    return [...tasksList].sort((a, b) => {
        // 1. Completed tasks last
        if (a.completed !== b.completed) return a.completed ? 1 : -1;

        // 2. Priority (Urgent first - Higher rank first)
        const rankA = getPriorityRank(a.priority);
        const rankB = getPriorityRank(b.priority);
        if (rankA !== rankB) return rankB - rankA; // Descending order of rank

        // 3. Deadline (soonest first, null/undefined last)
        const deadlineA = a.deadline ? new Date(a.deadline).getTime() : Infinity;
        const deadlineB = b.deadline ? new Date(b.deadline).getTime() : Infinity;
        if (deadlineA !== deadlineB) return deadlineA - deadlineB;

        // 4. CreatedAt (newest first)
        return (new Date(b.createdAt || 0)) - (new Date(a.createdAt || 0));
    });
};
