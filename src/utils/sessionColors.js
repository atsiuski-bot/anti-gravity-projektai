import { Zap, Phone, Coffee, Briefcase } from 'lucide-react';

/**
 * SESSION_COLORS — the single source of truth for session-state presentation
 * (DESIGN_SYSTEM §4-B). The full-screen shell, the running-task card surface, the timer
 * accent, the text label and the icon all derive from this one map, so they can never drift
 * (today the "call" state is `blue` in some places and `sky` in others — that is the bug
 * this map removes).
 *
 * Class names reference the design tokens in tailwind.config.js
 * (`session.<type>.{shell,surface,accent,soft}`), which are CSS-variable-backed (ADR 0016): the
 * light palette is byte-identical to the original hardcoded values, while the dark theme swaps the
 * pale light tints for deep same-hue tones so the loud shell harmonizes with the dark canvas.
 *
 *  - `shell`   full-screen background while the session is active
 *  - `surface` the running card layered above the shell (content rides on this, §4-D)
 *  - `accent`  timer / icon / accent text color
 *  - `accentBorder` the accent as a BORDER class — for a pill/chip outlined in the session
 *              accent (e.g. the floating ActiveSessionReadout), so it reads the one map too
 *  - `onShell` text color that is legible *directly* on the shell. The shells are theme-REACTIVE
 *              (a light tint in light mode, a deep tone in dark), so on-shell text is pinned via
 *              the `.wz-on-shell` CSS rule keyed off `data-session-shell` + `data-theme` — never
 *              the themeable `ink` token, which would invert and vanish on a still-light shell.
 *  - `label`   the required persistent Lithuanian label (§4-A, color is never the sole signal)
 *  - `Icon`    the lucide glyph for the state
 */
export const SESSION_TYPES = ['quickWork', 'call', 'break', 'task'];

export const SESSION_COLORS = {
    quickWork: {
        type: 'quickWork',
        label: 'Greita veikla',
        Icon: Zap,
        shell: 'bg-session-quickWork-shell',
        surface: 'bg-session-quickWork-surface',
        accent: 'text-session-quickWork-accent',
        accentBg: 'bg-session-quickWork-accent',
        accentBorder: 'border-session-quickWork-accent',
        onShell: 'text-white', // saturated-red shell → white label for contrast
    },
    call: {
        type: 'call',
        label: 'Skambutis',
        Icon: Phone,
        shell: 'bg-session-call-shell',
        surface: 'bg-session-call-surface',
        accent: 'text-session-call-accent',
        accentBg: 'bg-session-call-accent',
        accentBorder: 'border-session-call-accent',
        onShell: 'text-gray-900', // light shell (theme-invariant) → fixed dark label, never inverting ink
    },
    break: {
        type: 'break',
        label: 'Pertrauka',
        Icon: Coffee,
        shell: 'bg-session-break-shell',
        surface: 'bg-session-break-surface',
        accent: 'text-session-break-accent',
        accentBg: 'bg-session-break-accent',
        accentBorder: 'border-session-break-accent',
        onShell: 'text-gray-900',
    },
    task: {
        type: 'task',
        label: 'Vyksta veikla',
        Icon: Briefcase,
        shell: 'bg-session-task-shell',
        surface: 'bg-session-task-surface',
        accent: 'text-session-task-accent',
        accentBg: 'bg-session-task-accent',
        accentBorder: 'border-session-task-accent',
        onShell: 'text-gray-900',
    },
};

/** Full-screen background when no session is active (idle). Token-backed so it follows the
 *  theme (light gray canvas / dark canvas) — a literal white would stay white in dark mode. */
export const IDLE_SHELL = 'bg-surface-base';

/** Presentation tokens for a session type, or `null` when idle / unknown. */
export function getSessionColors(type) {
    return SESSION_COLORS[type] || null;
}
