/**
 * UI color constants that are applied as inline styles (hex), not Tailwind classes.
 *
 * For Tailwind-class colors use the design tokens in tailwind.config.js
 * (see docs/design/tokens.md). This file is only for the few places that need a raw hex
 * (e.g. a user-chosen avatar color stored in Firestore).
 */

/**
 * The default worker/avatar color when a user has no custom color set.
 *
 * This is the brand indigo (`brand.DEFAULT`). It replaces the magic `#3b82f6` (blue-500)
 * that was hardcoded across the app, and deliberately keeps the brand accent distinct from
 * the "call" session blue (DESIGN_SYSTEM §3, tokens.md "Worker color fallback").
 */
export const WORKER_FALLBACK_COLOR = '#4F46E5';
