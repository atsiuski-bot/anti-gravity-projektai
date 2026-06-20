import { Zap, Phone, Coffee, Briefcase } from 'lucide-react';

/**
 * SESSION_COLORS — the single source of truth for session-state presentation
 * (DESIGN_SYSTEM §4-B). The full-screen shell, the running-task card surface, the timer
 * accent, the text label and the icon all derive from this one map, so they can never drift
 * (today the "call" state is `blue` in some places and `sky` in others — that is the bug
 * this map removes).
 *
 * Class names reference the design tokens in tailwind.config.js
 * (`session.<type>.{shell,surface,accent}`). The resolved colors are intentionally identical
 * to the previous hardcoded values, so adopting this map is behavior-neutral for the shell.
 *
 *  - `shell`   full-screen background while the session is active
 *  - `surface` the running card layered above the shell (content rides on this, §4-D)
 *  - `accent`  timer / icon / accent text color
 *  - `onShell` text color that is legible *directly* on the shell
 *  - `label`   the required persistent Lithuanian label (§4-A, color is never the sole signal)
 *  - `Icon`    the lucide glyph for the state
 */
export const SESSION_TYPES = ['quickWork', 'call', 'break', 'task'];

export const SESSION_COLORS = {
    quickWork: {
        type: 'quickWork',
        label: 'Greitas darbas',
        Icon: Zap,
        shell: 'bg-session-quickWork-shell',
        surface: 'bg-session-quickWork-surface',
        accent: 'text-session-quickWork-accent',
        accentBg: 'bg-session-quickWork-accent',
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
        onShell: 'text-ink-strong', // light shell → dark label
    },
    break: {
        type: 'break',
        label: 'Pertrauka',
        Icon: Coffee,
        shell: 'bg-session-break-shell',
        surface: 'bg-session-break-surface',
        accent: 'text-session-break-accent',
        accentBg: 'bg-session-break-accent',
        onShell: 'text-ink-strong',
    },
    task: {
        type: 'task',
        label: 'Vyksta darbas',
        Icon: Briefcase,
        shell: 'bg-session-task-shell',
        surface: 'bg-session-task-surface',
        accent: 'text-session-task-accent',
        accentBg: 'bg-session-task-accent',
        onShell: 'text-ink-strong',
    },
};

/** Full-screen background when no session is active (idle). */
export const IDLE_SHELL = 'bg-white';

/** Presentation tokens for a session type, or `null` when idle / unknown. */
export function getSessionColors(type) {
    return SESSION_COLORS[type] || null;
}
