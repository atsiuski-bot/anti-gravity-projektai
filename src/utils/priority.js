/**
 * Priority Definitions & Configuration
 * Single source of truth for priority logic across the app.
 */

export const PRIORITIES = {
    URGENT: 'URGENT',
    HIGH: 'HIGH',
    MEDIUM: 'MEDIUM',
    LOW: 'LOW',
    VERY_LOW: 'VERY_LOW'
};

const PRIORITY_CONFIG = {
    [PRIORITIES.URGENT]: {
        id: PRIORITIES.URGENT,
        rank: 5,
        label: 'Skubus',
        color: '#000000', // Black
        textColor: '#FFFFFF',
    },
    [PRIORITIES.HIGH]: {
        id: PRIORITIES.HIGH,
        rank: 4,
        label: 'Aukštas',
        color: '#666666', // Lighter Dark Grey (was #4D4D4D)
        textColor: '#FFFFFF',
    },
    [PRIORITIES.MEDIUM]: {
        id: PRIORITIES.MEDIUM,
        rank: 3,
        label: 'Vidutinis',
        color: '#A3A3A3', // Lighter Medium Grey (was #8C8C8C)
        // No explicit textColor: white-on-#A3A3A3 is 2.52:1 (fails WCAG AA). Let
        // getContrastingTextColor pick dark text (#111) for this light-gray chip. (DESIGN_SYSTEM §6)
    },
    [PRIORITIES.LOW]: {
        id: PRIORITIES.LOW,
        rank: 2,
        label: 'Žemas',
        color: '#E0E0E0', // Lighter Grey (was #BDBDBD)
        textColor: '#111111',
    },
    [PRIORITIES.VERY_LOW]: {
        id: PRIORITIES.VERY_LOW,
        rank: 1,
        label: 'Labai žemas',
        color: '#FAFAFA', // Almost White (was #F5F5F5)
        textColor: '#111111',
    }
};

// Default fallback if priority is missing or invalid
export const DEFAULT_PRIORITY = PRIORITIES.MEDIUM;

/**
 * Normalizes priority string to uppercase valid key.
 * Handles case-insensitivity and legacy values.
 * Returns DEFAULT_PRIORITY if invalid.
 */
export const normalizePriority = (priority) => {
    if (!priority) return DEFAULT_PRIORITY;

    const normalized = String(priority).toUpperCase();

    // Direct match
    if (PRIORITY_CONFIG[normalized]) {
        return normalized;
    }

    // Attempt to map legacy capitalization (e.g. "Low" -> "LOW") - mostly covered by upper case above
    // Add specific mappings if we had different naming, but current plan is simple casing diffs.

    return DEFAULT_PRIORITY;
};

/**
 * Returns hex color for a given priority
 */
export const getPriorityColor = (priority) => {
    const p = normalizePriority(priority);
    return PRIORITY_CONFIG[p].color;
};

/**
 * Returns human-readable label for a given priority
 */
export const getPriorityLabel = (priority) => {
    const p = normalizePriority(priority);
    return PRIORITY_CONFIG[p].label;
};

/**
 * Returns text color for a given priority (explicit or calculated)
 */
export const getPriorityTextColor = (priority) => {
    const p = normalizePriority(priority);
    return PRIORITY_CONFIG[p].textColor || getContrastingTextColor(PRIORITY_CONFIG[p].color);
};

/**
 * Returns numeric rank for sorting (Higher number = Higher priority)
 */
export const getPriorityRank = (priority) => {
    const p = normalizePriority(priority);
    return PRIORITY_CONFIG[p].rank;
};

/**
 * Helper to get all priority options for dropdowns
 */
export const getPriorityOptions = () => {
    return Object.values(PRIORITY_CONFIG).sort((a, b) => b.rank - a.rank); // Sort highest to lowest for dropdown
};

/**
 * Determines text color (white or black) based on background hex.
 * Simple threshold logic for grayscale background.
 */
export const getContrastingTextColor = (bgHex) => {
    // Remove hash
    const hex = bgHex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    // Calculate brightness (standard YIQ formula)
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;

    // If dark -> white text, if light -> black text
    // Threshold ~128 is standard, tweaking slightly if needed.
    return (yiq >= 128) ? '#111111' : '#FFFFFF';
};

export const UI_COLORS = {
    DEFAULT_BORDER: '#D9D9D9',
    DEFAULT_TEXT: '#111111',
    SECONDARY_TEXT: '#444444',
    BACKGROUND: '#FFFFFF'
};
