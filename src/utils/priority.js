/**
 * Priority Definitions & Configuration
 * Single source of truth for priority logic across the app.
 */

export const PRIORITIES = {
    URGENT: 'URGENT',
    HIGH: 'HIGH',
    MEDIUM: 'MEDIUM',
    LOW: 'LOW'
};

// The priority chip is a contrast-tuned ramp. It is THEME-REACTIVE: the bg/text colors live in
// CSS variables (`--priority-<slug>-bg/-text`, defined per theme in index.css) and the getters
// below return `var(...)` references, so the chip re-paints with the theme. In light the ramp
// runs black(urgent) -> light-grey(low); in dark it inverts (bright urgent -> faint
// low) so "more urgent = louder against the canvas" holds and no chip glares on the dark
// surface. The literal `color` hexes are retained as the LIGHT source of truth + for the runtime
// contrast helper; `slug` keys the CSS variable.
const PRIORITY_CONFIG = {
    [PRIORITIES.URGENT]: {
        id: PRIORITIES.URGENT,
        rank: 4,
        slug: 'urgent',
        label: 'Skubus',
        color: '#000000', // Black
        textColor: '#FFFFFF',
    },
    [PRIORITIES.HIGH]: {
        id: PRIORITIES.HIGH,
        rank: 3,
        slug: 'high',
        label: 'Aukštas',
        color: '#666666', // Lighter Dark Grey (was #4D4D4D)
        textColor: '#FFFFFF',
    },
    [PRIORITIES.MEDIUM]: {
        id: PRIORITIES.MEDIUM,
        rank: 2,
        slug: 'medium',
        label: 'Vidutinis',
        color: '#A3A3A3', // Lighter Medium Grey (was #8C8C8C)
        // No explicit textColor: white-on-#A3A3A3 is 2.52:1 (fails WCAG AA). Let
        // getContrastingTextColor pick dark text (#111) for this light-gray chip. (DESIGN_SYSTEM §6)
    },
    [PRIORITIES.LOW]: {
        id: PRIORITIES.LOW,
        rank: 1,
        slug: 'low',
        label: 'Žemas',
        color: '#E0E0E0', // Lighter Grey (was #BDBDBD)
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
 * Returns the THEME-REACTIVE background color for a given priority, as a CSS `var()` reference
 * (resolves per theme via index.css). Intended for inline `style`; for the raw light hex (e.g.
 * a contrast computation) read PRIORITY_CONFIG via getPriorityHex.
 */
export const getPriorityColor = (priority) => {
    const p = normalizePriority(priority);
    return `var(--priority-${PRIORITY_CONFIG[p].slug}-bg)`;
};

/**
 * Returns human-readable label for a given priority
 */
export const getPriorityLabel = (priority) => {
    const p = normalizePriority(priority);
    return PRIORITY_CONFIG[p].label;
};

/**
 * Returns the THEME-REACTIVE text color for a given priority, as a CSS `var()` reference. The
 * per-theme value in index.css already encodes the AA-correct fg for each chip bg (e.g. dark
 * text on the light MEDIUM chip), so no runtime contrast pick is needed at the call site.
 */
export const getPriorityTextColor = (priority) => {
    const p = normalizePriority(priority);
    return `var(--priority-${PRIORITY_CONFIG[p].slug}-text)`;
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
 * WCAG 2.1 relative luminance of an sRGB color (0..1).
 * Linearizes each channel then applies the 0.2126/0.7152/0.0722 weighting.
 */
const relativeLuminance = (r, g, b) => {
    const linearize = (channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return (
        0.2126 * linearize(r) +
        0.7152 * linearize(g) +
        0.0722 * linearize(b)
    );
};

/**
 * Determines text color (dark or white) for the given background using a real
 * WCAG 2.1 contrast comparison: compute the (L1 + 0.05) / (L2 + 0.05) ratio for
 * each candidate against the background and return whichever yields the higher
 * contrast. Returns dark text for the MEDIUM chip bg (#A3A3A3).
 */
export const getContrastingTextColor = (bgHex) => {
    // Remove hash
    const hex = bgHex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    const bgLum = relativeLuminance(r, g, b);

    // Contrast ratio against the two text candidates.
    const contrast = (lum) => {
        const lighter = Math.max(bgLum, lum);
        const darker = Math.min(bgLum, lum);
        return (lighter + 0.05) / (darker + 0.05);
    };

    const DARK = '#111111';
    const LIGHT = '#FFFFFF';
    const darkLum = relativeLuminance(0x11, 0x11, 0x11);
    const lightLum = relativeLuminance(0xFF, 0xFF, 0xFF);

    // Pick whichever candidate has the higher contrast ratio against the bg.
    return contrast(darkLum) >= contrast(lightLum) ? DARK : LIGHT;
};
