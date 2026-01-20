export const parseTimeStringToMinutes = (str) => {
    // Add safety checks
    if (!str || typeof str !== 'string') return 0;

    let total = 0;
    try {
        // Handle 'val' or 'h' for hours
        const hMatch = str.match(/(\d+\.?\d*)\s*(h|val)/);
        // Handle 'min' or 'm' for minutes
        const mMatch = str.match(/(\d+)\s*(m|min)/);

        if (hMatch) {
            const hours = parseFloat(hMatch[1]);
            if (Number.isFinite(hours) && hours >= 0) {
                total += hours * 60;
            }
        }
        if (mMatch) {
            const mins = parseInt(mMatch[1], 10);
            if (Number.isFinite(mins) && mins >= 0) {
                total += mins;
            }
        }
    } catch (error) {
        console.warn('Error parsing time string:', str, error);
        return 0;
    }
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
    // Add safety check for task object
    if (!task || typeof task !== 'object') return 0;

    try {
        // 1. Try numeric fields first (New System)
        let total = (task.timerMinutes || 0) + (task.manualMinutes || 0);

        // 2. If zero, try parsing actualTime string (Old System / Fallback)
        // checking total === 0 safeguards against double counting if we have both
        if (total === 0 && (task.accumulatedMinutes || task.actualTime)) {
            total = task.accumulatedMinutes || parseTimeStringToMinutes(task.actualTime) || 0;
        }

        // 3. Add current running session
        if (task.timerStatus === 'running' && task.timerStartedAt) {
            try {
                const start = new Date(task.timerStartedAt);
                if (!isNaN(start.getTime())) {
                    const now = new Date();
                    const elapsedMinutes = (now - start) / (1000 * 60);
                    if (Number.isFinite(elapsedMinutes) && elapsedMinutes >= 0) {
                        total += elapsedMinutes;
                    }
                }
            } catch (dateError) {
                console.warn('Invalid timer start date:', task.timerStartedAt);
            }
        }

        return Number.isFinite(total) && total >= 0 ? total : 0;
    } catch (error) {
        console.error('Error calculating total minutes for task:', task?.id, error);
        return 0;
    }
};
