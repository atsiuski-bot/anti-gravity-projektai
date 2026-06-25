/**
 * Task status glyphs — the custom shape vocabulary for a task's lifecycle/approval state
 * (icon-system, ADR 0010 §"Status circle"). Every surface renders status through
 * <TaskStatusPill> -> deriveTaskStatus, which picks one of these by status key, so the SHAPE
 * (not just the pill color) carries the state: readable in sunlight, with gloves, and for
 * colorblind users (DESIGN_SYSTEM §4-A — color is never the sole signal).
 *
 * Drawing canon: 24px grid, rounded caps/joins, ~2px stroke. The monochrome glyphs inherit the
 * pill's text color via `currentColor`; the two finished states deliberately carry the semantic
 * green that matches StatusPill's success/running tone, because "done/confirmed" is a fixed
 * meaning, not a per-surface accent.
 *
 * The two finished states are the split the founder asked for:
 *  - completed (Laukia priėmimo) — thin green RING + green check (finished, not yet accepted)
 *  - confirmed (Priimtas)        — green FILL + white check (manager accepted)
 *
 * Each component takes `className` (size + color) and spreads the rest onto the <svg> so the
 * caller's `aria-hidden` lands on the element (StatusPill renders `<Icon aria-hidden />`).
 */

const SVG = { viewBox: '0 0 24 24', xmlns: 'http://www.w3.org/2000/svg' };

// Never started — hollow dotted ring, inherits the (muted) pill text color.
export function StatusPendingGlyph({ className, ...props }) {
    return (
        <svg {...SVG} fill="none" className={className} {...props}>
            <circle cx="12" cy="12" r="9" className="stroke-current opacity-50" strokeWidth="2" strokeDasharray="2.5 3" />
        </svg>
    );
}

// Running — a solid green play wedge with NO enclosing ring (the founder's call). The "alive"
// pulse, when wanted, is applied by the caller via wz-pulse-soft rather than baked in here.
export function StatusRunningGlyph({ className, ...props }) {
    return (
        <svg {...SVG} className={className} {...props}>
            <path d="M8 5l11 7-11 7z" className="fill-green-600" />
        </svg>
    );
}

// Started but not running — two bars inside the family circle, monochrome.
export function StatusPausedGlyph({ className, ...props }) {
    return (
        <svg {...SVG} fill="none" className={className} {...props}>
            <circle cx="12" cy="12" r="9" className="stroke-current" strokeWidth="2" />
            <line x1="10" y1="9" x2="10" y2="15" className="stroke-current" strokeWidth="2" strokeLinecap="round" />
            <line x1="14" y1="9" x2="14" y2="15" className="stroke-current" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

// Finished, awaiting manager acceptance (Laukia priėmimo) — thin green ring + green check.
export function StatusCompletedGlyph({ className, ...props }) {
    return (
        <svg {...SVG} fill="none" className={className} {...props}>
            <circle cx="12" cy="12" r="9" className="stroke-green-600" strokeWidth="2" />
            <path d="M8 12.5l2.8 2.8L16 9.5" className="stroke-green-600" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

// Manager accepted (Priimtas) — green fill + white check.
export function StatusConfirmedGlyph({ className, ...props }) {
    return (
        <svg {...SVG} className={className} {...props}>
            <circle cx="12" cy="12" r="10" className="fill-green-600" />
            <path d="M7.5 12.5l2.8 2.8L16.5 9" fill="none" className="stroke-white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

// Creation/approval gate, waiting (Nepatvirtintas) — ring + hold dot. Inherits the pill's amber
// "pending" tone via currentColor (text-feedback-warning-text → amber-700 light / amber-400 dark),
// so the color is a theme-reactive semantic token, not a fixed palette amber.
export function StatusAwaitingGlyph({ className, ...props }) {
    return (
        <svg {...SVG} fill="none" className={className} {...props}>
            <circle cx="12" cy="12" r="9" className="stroke-current" strokeWidth="2" />
            <circle cx="12" cy="12" r="2.4" className="fill-current" />
        </svg>
    );
}

// Approval gate, passed (approved) — reuses the green ring + check (the gate is open). Rarely
// rendered: the app flips an approved task straight to in-progress.
export const StatusApprovedGlyph = StatusCompletedGlyph;

// The status-key -> glyph map lives in ./statusGlyphMap.js (a constants module): this file
// stays components-only so React Fast Refresh keeps working (react-refresh/only-export-components).
