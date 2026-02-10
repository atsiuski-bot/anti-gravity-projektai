import { parseTimeStringToMinutes } from './timeUtils';

/**
 * Formats a full name to the format "Name S."
 * Example: "Jonas Kazlauskas" -> "Jonas K."
 * Example: "Petras" -> "Petras"
 * Example: "First Middle Last" -> "First L."
 * 
 * @param {string} fullName The full name to format
 * @returns {string} The formatted name
 */
export const formatDisplayName = (fullName) => {
    if (!fullName) return '';
    const parts = fullName.trim().split(/\s+/);
    if (parts.length <= 1) return fullName;
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];
    return `${firstName} ${lastName.charAt(0).toUpperCase()}.`;
};

/**
 * Safely parses time string to hours with validation.
 * Centralized function to eliminate duplication across components.
 * 
 * @param {string} timeStr - Time string like "2h", "90m", "1h 30m", "2.5h", "2val"
 * @returns {number} Hours as decimal, returns 0 for invalid input
 * 
 * @example
 * parseTimeToHours("2h") // 2
 * parseTimeToHours("90m") // 1.5
 * parseTimeToHours("1h 30m") // 1.5
 * parseTimeToHours("2.5val") // 2.5
 * parseTimeToHours(null) // 0
 */
export const parseTimeToHours = (timeStr) => {
    try {
        if (!timeStr || typeof timeStr !== 'string') return 0;
        const minutes = parseTimeStringToMinutes(timeStr);
        if (!Number.isFinite(minutes) || minutes < 0) return 0;
        return minutes / 60;
    } catch (error) {
        console.warn('Failed to parse time string:', timeStr, error);
        return 0;
    }
};

/**
 * Formats a date string or Date object to HH:MM (24h) format.
 * 
 * @param {string|Date} dateOrString - ISO string or Date object
 * @returns {string} Formatted time string (e.g. "14:30") or "-" if invalid
 */
export const formatTime = (dateOrString) => {
    if (!dateOrString) return '-';
    const date = new Date(dateOrString);
    if (isNaN(date.getTime())) return '-';
    return date.toLocaleTimeString('lt-LT', {
        timeZone: 'Europe/Vilnius',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
};
