export const parseTimeStringToMinutes = (str) => {
    // Add safety checks
    if (!str || typeof str !== 'string') return 0;

    let total = 0;
    try {
        // Handle 'val' or 'h' for hours (supports both period and comma as decimal separator)
        const hMatch = str.replace(',', '.').match(/(\d+\.?\d*)\s*(h|val)/);
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
    const isNegative = minutes < 0;
    const totalMinutes = Math.round(Math.abs(minutes));
    const prefix = isNegative ? '-' : '';
    if (totalMinutes < 60) {
        return `${prefix}${totalMinutes}m`;
    }
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (m === 0) return `${prefix}${h}h`;
    return `${prefix}${h}h ${m}m`;
};

// Calculate current total time including active session if running
export const calculateCurrentTotalMinutes = (task) => {
    // Add safety check for task object
    if (!task || typeof task !== 'object') return 0;

    try {
        let total = 0;

        total = (task.manualMinutes || 0) + (task.timerMinutes || 0);

        // 2. If zero, try parsing actualTime string (Old System / Fallback)
        // checking total === 0 safeguards against double counting if we have both
        if (total === 0 && !task.timeChanged && (task.accumulatedMinutes || task.actualTime)) {
            total = task.accumulatedMinutes || parseTimeStringToMinutes(task.actualTime) || 0;
        }

        // Add explicit time adjustments
        if (task.timeAdjustments && Array.isArray(task.timeAdjustments)) {
            task.timeAdjustments.forEach(adj => {
                total += (adj.durationMinutes || 0);
            });
        }

        // Add currently running session time if any      
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

        return Number.isFinite(total) ? total : 0;
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
    const [y, m, d] = dateStr.split('-').map(Number);
    // 03:00 Vilnius is 01:00 UTC in winter (UTC+2) and 00:00 UTC in summer (UTC+3).
    // Read the day's offset from a noon reference (noon is never inside the DST
    // spring-forward gap) so the result is deterministic - the previous
    // step-towards-03:00 loop could oscillate on the spring-forward day, when 03:00
    // local time does not exist, and return an off-by-one-hour cutoff.
    const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const localNoonHour = parseInt(
        new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Vilnius',
            hour: 'numeric',
            hour12: false
        }).format(noonUTC),
        10
    );
    const offsetHours = localNoonHour - 12; // 2 (winter) or 3 (summer)
    return new Date(Date.UTC(y, m - 1, d, 3 - offsetHours, 0, 0));
};
