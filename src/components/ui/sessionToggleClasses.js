import { cn } from '../../utils/cn';

/**
 * Class resolver for SessionToggleButton — kept in its own (non-component) module so the
 * component file can export ONLY the component (react-refresh), and so this byte-level mapping
 * is unit-testable WITHOUT a DOM (the suite runs in the node env). See SessionToggleButton.jsx
 * for the affordance's rationale.
 *
 * The per-session ACTIVE styles are full LITERAL class strings (NOT `bg-session-${x}`
 * interpolation) so Tailwind's content scanner — which globs `src/**` incl. `.js` — still emits
 * them, and they reproduce each old timer button's classes byte-for-byte.
 */

// Per-variant base scaffold (shared by every session/state).
const BASE = {
    compact:
        'inline-flex items-center justify-center min-h-touch min-w-touch rounded-control transition-all active:scale-95 ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
    labeled:
        'inline-flex items-center justify-center gap-2 min-h-touch px-4 py-2.5 rounded-control text-body font-medium transition-colors shadow-sm ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
};

const DISABLED = {
    compact: 'opacity-50 cursor-not-allowed bg-surface-sunken text-ink-muted',
    labeled: 'bg-surface-sunken text-ink-muted cursor-not-allowed border border-line',
};

const REST = {
    compact: 'bg-surface-sunken text-ink hover:bg-line',
    labeled: 'bg-surface-card text-ink hover:bg-surface-sunken border border-line',
};

// Per-session ACTIVE styles. The mapping is NOT mechanical: for break/call the saturated color
// is `accent` (active = accent fill + shell-tint ring); for quick-work the loud red lives in
// `shell`, so active = shell fill + soft-tint ring (+ the existing glow). Each string equals what
// its call site rendered before the M6 extraction.
const ACTIVE = {
    compact: {
        break: 'bg-session-break-accent text-white ring-2 ring-session-break-shell',
        call: 'bg-session-call-accent text-white ring-2 ring-session-call-shell',
        quickWork:
            'bg-session-quickWork-shell text-white ring-2 ring-session-quickWork-soft shadow-lg shadow-session-quickWork-shell/20',
    },
    labeled: {
        break: 'bg-session-break-surface text-session-break-accent hover:bg-session-break-shell border border-session-break-soft',
        call: 'bg-session-call-surface text-session-call-accent hover:bg-session-call-shell border border-session-call-soft',
        quickWork:
            'bg-session-quickWork-surface text-session-quickWork-accent hover:bg-session-quickWork-shell border border-session-quickWork-soft',
    },
};

/**
 * Resolve the toggle's className: base + the one applicable state block (disabled > active >
 * rest), plus any caller override. Unknown `variant` falls back to compact; an unknown `session`
 * while active falls back to the neutral rest block (never throws).
 */
export function sessionToggleClasses({ session, variant = 'compact', active = false, disabled = false, className } = {}) {
    const v = BASE[variant] ? variant : 'compact';
    const state = disabled
        ? DISABLED[v]
        : active
            ? (ACTIVE[v][session] || REST[v])
            : REST[v];
    return cn(BASE[v], state, className);
}
