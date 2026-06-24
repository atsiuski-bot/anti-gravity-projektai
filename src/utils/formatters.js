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
    // Guard against a placeholder surname (a lone "-"/"--"/"." from an SSO profile that
    // carries no real last name): only append a dotted initial when the surname token
    // starts with a letter, otherwise show the first name alone. Without this, a stored
    // name like "Jogile -" rendered as the meaningless "Jogile -." across every name
    // surface. \p{L} (with the u flag) matches Lithuanian diacritics too.
    const initial = lastName.match(/^\p{L}/u);
    return initial ? `${firstName} ${initial[0].toUpperCase()}.` : firstName;
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

// EUR formatting in the Lithuanian locale: comma decimal, the "€" glyph AFTER the number
// (e.g. "12,50 €"), per lt-LT. One Intl instance, reused. Always 2 decimals so an amount never
// renders as "12,5 €". The display layer owns formatting — Firestore stores plain numbers.
const eurFormatter = new Intl.NumberFormat('lt-LT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

/**
 * Formats a number as a Lithuanian-locale EUR amount (e.g. 12.5 -> "12,50 €").
 * @param {number} amount
 * @returns {string}
 */
export const formatEur = (amount) => {
    const n = Number(amount);
    return eurFormatter.format(Number.isFinite(n) ? n : 0);
};

/**
 * Formats an hourly rate (e.g. 12.5 -> "12,50 €/val."). The unit is appended outside Intl so it
 * reads in Lithuanian.
 * @param {number} amount
 * @returns {string}
 */
export const formatEurPerHour = (amount) => `${formatEur(amount)}/val.`;

/**
 * Checks if a role string represents a manager-or-above (manager, senior manager, or admin).
 * Eliminates repeated `role === 'manager' || role === 'admin'` checks. This gates manager-SHAPED
 * UI (team tabs, approval surfaces), NOT data breadth — visibility is scoped separately by
 * `teamScope.js`. `seniorManager` (Vyr. vadovas) is a manager-shaped rank but is SCOPED to its
 * subtree, not whole-company (ADR 0007 — `isScopedOverseer`); account management stays admin-only.
 *
 * @param {string} role - The role to check
 * @returns {boolean}
 */
export const isManagerRole = (role) =>
    role === 'manager' || role === 'admin' || role === 'seniorManager';

/**
 * True only for the ADMIN tier (both the English key and the Lithuanian display value that some
 * legacy docs store). Distinct from {@link isManagerRole}: curating the SHARED ("team") task
 * template library is an admin-only authority, so this gates that affordance specifically.
 *
 * @param {string} role - The role to check
 * @returns {boolean}
 */
export const isAdminRole = (role) =>
    role === 'admin' || role === 'Administratorius';

/**
 * Resolves a finished task's lifecycle status from the COMPLETING actor's ROLE — the single source
 * BOTH completion doors read (the timer's "Užbaigti" in TaskTimerControls and the audited
 * completeTask command), so they can never drift. Confirm authority is a manager ROLE, never a
 * per-task ownership claim: `firestore.rules` DENIES a worker self-confirming an existing task
 * (`changesApprovalFields`), so a non-manager writing `status:'confirmed'` only produced a silent
 * permission-denied that failed the whole finish. Therefore only a manager-shaped role auto-confirms
 * ('confirmed'); everyone else — INCLUDING a worker who happens to be a task's named `managerId` —
 * lands 'completed', awaiting a real manager's priėmimas. Self-direction no longer factors in; role
 * alone decides.
 *
 * @param {string} role - the completing actor's role
 * @returns {'confirmed'|'completed'}
 */
export const resolveCompletionStatus = (role) =>
    isManagerRole(role) ? 'confirmed' : 'completed';

/**
 * Resolves the user ID from a record that may use different field names
 * due to legacy schema variations.
 * 
 * @param {Object} record - A session, task, or break record
 * @returns {string} The resolved user ID
 */
export const resolveUserId = (record) => {
    if (!record) return 'unknown';
    return record.assignedUserId || record.assignedTo || record.workerId || record.userId || 'unknown';
};

/**
 * Resolves the user display name from a record that may use different field names.
 * 
 * @param {Object} record - A session, task, or break record
 * @param {string} [fallback='Nežinomas'] - Fallback value if no name found
 * @returns {string} The resolved user name
 */
export const resolveUserName = (record, fallback = 'Nežinomas') => {
    if (!record) return fallback;
    return record.userName || record.workerName || record.assignedUserName || record.creatorName || fallback;
};
