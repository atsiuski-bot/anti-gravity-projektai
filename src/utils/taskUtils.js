// Task tags configuration
export const TASK_TAGS = ['Auto', 'Renginiams', 'Piro'];

// Return only non-completed tasks AND non-system tasks (Call/QuickWork)
export const filterTasksByVisibility = (tasks) => {
    if (!tasks) return [];
    return tasks.filter(task => {
        // 1. Basic completion check
        if (task.completed) return false;

        // 2. Explicitly hide Quick Work and Call tasks from the main list
        // These should only appear in Reports/History, never in the active "Tasks" tab
        if (task.isQuickWork) return false;
        if (task.isSystemTask) return false; // Covers "Call" tasks

        // 3. Exclude Soft-Deleted tasks
        if (task.isDeleted || task.status === 'deleted') return false;

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
