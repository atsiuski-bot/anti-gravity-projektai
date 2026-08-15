/**
 * Haptic feedback utility for mobile tactile micro-interactions.
 * Safely guards on navigator.vibrate availability and user preferences.
 */

export function triggerHaptic(pattern = 10) {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
    if (!('vibrate' in navigator) || typeof navigator.vibrate !== 'function') return;

    try {
        navigator.vibrate(pattern);
    } catch {
        // Silently ignore if haptics are blocked or unavailable
    }
}

/**
 * Light tap for buttons, timer toggles, and tab switches (~10ms).
 */
export function hapticTap() {
    triggerHaptic(10);
}

/**
 * Positive confirmation pulse for task completion or save actions.
 */
export function hapticSuccess() {
    triggerHaptic([15, 50, 20]);
}
