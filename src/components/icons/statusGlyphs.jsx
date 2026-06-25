/**
 * Task status glyphs — the custom shape vocabulary for a task's lifecycle/approval state
 * (icon-system, ADR 0010 §"Status circle"). Every surface renders status through
 * <TaskStatusPill> -> deriveTaskStatus, which picks one of these by status key, so the SHAPE
 * (not just the pill color) carries the state: readable in sunlight, with gloves, and for
 * colorblind users (DESIGN_SYSTEM §4-A — color is never the sole signal).
 *
 * Drawing canon: 24px grid, rounded caps/joins, ~2px stroke. Colors are baked per state (not
 * tone-driven) because each shape's meaning is fixed, not a per-surface accent: the not-started
 * states are calm grey (ink-muted), a started/paused task is heavier black (ink-strong), and the
 * running/finished states carry the semantic green that matches StatusPill's success/running tone.
 * The grey/black use theme-reactive ink tokens so they stay legible in both themes.
 *
 * The two finished states are the split the founder asked for:
 *  - completed (Laukia priėmimo) — thin green RING + green check (finished, not yet accepted)
 *  - confirmed (Priimtas)        — green FILL + white check (manager accepted)
 *
 * Each component takes `className` (size + color) and spreads the rest onto the <svg> so the
 * caller's `aria-hidden` lands on the element (StatusPill renders `<Icon aria-hidden />`).
 */

const SVG = { viewBox: '0 0 24 24', xmlns: 'http://www.w3.org/2000/svg' };

// Approved but not started yet (Patvirtintas / ready to start) — solid grey ring. The grey
// reads as "calm, waiting" against the loud running/done states; theme-reactive via the ink-muted
// token (not a fixed palette grey) so it stays legible in both themes.
export function StatusPendingGlyph({ className, ...props }) {
    return (
        <svg {...SVG} fill="none" className={className} {...props}>
            <circle cx="12" cy="12" r="9" className="stroke-ink-muted" strokeWidth="2" />
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

// Started but paused (Pradėta) — black ring + pause bars. Black (ink-strong) reads as "active,
// engaged" — a started task is heavier than a merely-approved grey one.
export function StatusPausedGlyph({ className, ...props }) {
    return (
        <svg {...SVG} fill="none" className={className} {...props}>
            <circle cx="12" cy="12" r="9" className="stroke-ink-strong" strokeWidth="2" />
            <line x1="10" y1="9" x2="10" y2="15" className="stroke-ink-strong" strokeWidth="2" strokeLinecap="round" />
            <line x1="14" y1="9" x2="14" y2="15" className="stroke-ink-strong" strokeWidth="2" strokeLinecap="round" />
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

// Creation/approval gate, waiting (Laukia patvirtinimo / Nepatvirtintas) — grey DOTTED ring.
// The dashed outline says "provisional, not yet a real commitment"; it solidifies into the
// plain grey ring once approved.
export function StatusAwaitingGlyph({ className, ...props }) {
    return (
        <svg {...SVG} fill="none" className={className} {...props}>
            <circle cx="12" cy="12" r="9" className="stroke-ink-muted" strokeWidth="2" strokeDasharray="2.5 3" />
        </svg>
    );
}

// Approval gate, passed (Patvirtintas, not started) — the plain solid grey ring (same as a
// ready-to-start task: the gate is open, work simply hasn't begun).
export const StatusApprovedGlyph = StatusPendingGlyph;

// The status-key -> glyph map lives in ./statusGlyphMap.js (a constants module): this file
// stays components-only so React Fast Refresh keeps working (react-refresh/only-export-components).
