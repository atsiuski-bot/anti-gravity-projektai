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
    if (minutes === null || minutes === undefined) return '';
    const totalMinutes = Math.round(minutes);
    if (totalMinutes < 60) {
        return `${totalMinutes}m`;
    }
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
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

/**
 * Returns a Date object representing the current moment, 
 * but ensures operations can be performed in Lithuanian context.
 */
export const getLithuanianNow = () => {
    return new Date();
};

/**
 * Returns YYYY-MM-DD string according to Lithuania's current time.
 */
export const getLithuanianDateString = (date = new Date()) => {
    const d = typeof date === 'string' ? new Date(date) : date;
    const options = { timeZone: 'Europe/Vilnius', year: 'numeric', month: '2-digit', day: '2-digit' };
    const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(d);
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${year}-${month}-${day}`;
};

/**
 * Returns the weekday in Lithuanian (e.g. "Pirmadienis") according to Lithuania's time.
 */
export const getLithuanianWeekday = (date = new Date()) => {
    const d = typeof date === 'string' ? new Date(date) : date;

    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Vilnius', weekday: 'long' });
    const enWeekday = formatter.format(d);
    const enToLtMap = {
        'Sunday': 'Sekmadienis',
        'Monday': 'Pirmadienis',
        'Tuesday': 'Antradienis',
        'Wednesday': 'Trečiadienis',
        'Thursday': 'Ketvirtadienis',
        'Friday': 'Penktadienis',
        'Saturday': 'Šeštadienis'
    };
    return enToLtMap[enWeekday] || 'Nežinoma';
};

/**
 * Returns a Date object for the same day at 03:00 Lithuania time.
 */
export const getLithuanian3AMCutoff = (dateStr) => {
    // dateStr is 'YYYY-MM-DD'
    const [y, m, d] = dateStr.split('-').map(Number);
    // Create a date in local time first
    const date = new Date(y, m - 1, d, 3, 0, 0, 0);

    // We need this date to represent 3 AM in VILNIUS.
    // A trick to get the offset:
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Vilnius',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        hour12: false
    });

    // Iteratively adjust until the formatted time is 03:00:00
    // But usually, just creating it and adjusting for timezone difference is enough.
    // More robustly: 
    const targetISO = `${dateStr}T03:00:00`;
    // We want the moment where Lithuania says it's 3AM.
    // We can use the fact that Europe/Vilnius is either +02:00 or +03:00.
    // Let's use a simpler approach: get the offset in minutes.

    const parts = formatter.formatToParts(date);
    const fHour = parseInt(parts.find(p => p.type === 'hour').value);

    const diff = fHour - 3;
    date.setHours(date.getHours() - diff);
    return date;
};
