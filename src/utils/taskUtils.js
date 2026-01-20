// Task tags configuration
export const TASK_TAGS = ['Auto', 'Renginiams', 'Piro'];

export const filterTasksByVisibility = (tasks) => {
    // Return all tasks regardless of deadline
    // Previously this filtered out tasks with future deadlines
    if (!tasks) return [];
    return tasks;
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
