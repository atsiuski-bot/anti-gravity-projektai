export const filterTasksByVisibility = (tasks) => {
    // dayOfWeek property is removed, so we return all tasks.
    // In the future, we could add filtering based on deadline if needed.
    return tasks;
};

export const sortWorkerTasks = (tasksList) => {
    const priorityOrder = { 'Urgent': 1, 'High': 2, 'Medium': 3, 'Low': 4 };

    return [...tasksList].sort((a, b) => {
        // 1. Completed tasks last
        if (a.completed !== b.completed) return a.completed ? 1 : -1;

        // 2. Priority (Urgent first)
        const prioA = priorityOrder[a.priority] || 99;
        const prioB = priorityOrder[b.priority] || 99;
        if (prioA !== prioB) return prioA - prioB;

        // 3. Deadline (soonest first, null/undefined last)
        const deadlineA = a.deadline ? new Date(a.deadline).getTime() : Infinity;
        const deadlineB = b.deadline ? new Date(b.deadline).getTime() : Infinity;
        if (deadlineA !== deadlineB) return deadlineA - deadlineB;

        // 4. CreatedAt (newest first)
        return (new Date(b.createdAt || 0)) - (new Date(a.createdAt || 0));
    });
};
