export const parseTimeStringToMinutes = (str) => {
    if (!str) return 0;
    let total = 0;
    const hMatch = str.match(/(\d+\.?\d*)\s*h/);
    const mMatch = str.match(/(\d+)\s*m/);
    if (hMatch) total += parseFloat(hMatch[1]) * 60;
    if (mMatch) total += parseInt(mMatch[1]);
    return total;
};

export const formatMinutesToTimeString = (minutes) => {
    if (!minutes && minutes !== 0) return '';
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
};

// Calculate current total time including active session if running
export const calculateCurrentTotalMinutes = (task) => {
    // 1. Try numeric fields first (New System)
    let total = (task.timerMinutes || 0) + (task.manualMinutes || 0);

    // 2. If zero, try parsing actualTime string (Old System / Fallback)
    // checking total === 0 safeguards against double counting if we have both
    if (total === 0 && (task.accumulatedMinutes || task.actualTime)) {
        total = task.accumulatedMinutes || parseTimeStringToMinutes(task.actualTime) || 0;
    }

    // 3. Add current running session
    if (task.timerStatus === 'running' && task.timerStartedAt) {
        const start = new Date(task.timerStartedAt);
        const now = new Date();
        const elapsedMinutes = (now - start) / (1000 * 60);
        total += elapsedMinutes;
    }

    return total;
};
