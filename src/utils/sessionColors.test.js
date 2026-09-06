import { describe, it, expect } from 'vitest';
import { SESSION_COLORS, SESSION_TYPES, IDLE_SHELL, getSessionColors } from './sessionColors';

// SESSION_COLORS is the app's signature invariant: the whole-screen background announces which
// session is running, and DESIGN_SYSTEM §4 makes three promises about it — one source of truth
// (§4-B), colour is never the sole signal (§4-A), and saturated red belongs to quick-work alone
// (§4-C). Those promises are enforced by convention today, which is how the break totals in
// DailyStatistics drifted onto a `feedback.warning` amber for months without anything failing.
// This suite makes the shape of the map itself a test, so a state added or a field dropped breaks
// the build instead of silently rendering a colour with no label behind it.
//
// It deliberately asserts CLASS STRINGS, not colour values: the classes are the contract with
// Tailwind's JIT, which only keeps class names it can see written out literally. A "clever"
// refactor to `bg-session-${type}-shell` would purge every one of them and make the shell
// disappear at runtime while every colour value stayed correct.

const REQUIRED_FIELDS = [
    'type', 'label', 'Icon',
    'shell', 'surface', 'accent', 'accentBg', 'accentBorder', 'accentRing', 'softBorder', 'onShell',
];

describe('SESSION_COLORS — map shape', () => {
    it('covers exactly the four session types, with no extras and none missing', () => {
        expect(SESSION_TYPES).toEqual(['quickWork', 'call', 'break', 'task']);
        expect(Object.keys(SESSION_COLORS).sort()).toEqual([...SESSION_TYPES].sort());
    });

    it.each(SESSION_TYPES)('%s carries every presentation field a consumer may read', (type) => {
        const entry = SESSION_COLORS[type];
        for (const field of REQUIRED_FIELDS) {
            expect(entry[field], `${type}.${field}`).toBeTruthy();
        }
        expect(entry.type).toBe(type);
    });

    it.each(SESSION_TYPES)('%s pairs its colour with a Lithuanian label and an icon (§4-A)', (type) => {
        const entry = SESSION_COLORS[type];
        // Colour is never the sole signal: a shell without a readable label + glyph is the
        // accessibility failure the rule exists to prevent (WCAG 1.4.1).
        expect(typeof entry.label).toBe('string');
        expect(entry.label.trim().length).toBeGreaterThan(0);
        // A lucide glyph is a forwardRef component: `object` at runtime, not `function`.
        expect(['function', 'object']).toContain(typeof entry.Icon);
        expect(entry.Icon).not.toBeNull();
    });
});

describe('SESSION_COLORS — one source of truth (§4-B)', () => {
    it.each(SESSION_TYPES)('%s derives every class from its OWN token namespace', (type) => {
        const entry = SESSION_COLORS[type];
        expect(entry.shell).toBe(`bg-session-${type}-shell`);
        expect(entry.surface).toBe(`bg-session-${type}-surface`);
        expect(entry.accent).toBe(`text-session-${type}-accent`);
        expect(entry.accentBg).toBe(`bg-session-${type}-accent`);
        expect(entry.accentBorder).toBe(`border-session-${type}-accent`);
        expect(entry.accentRing).toBe(`ring-session-${type}-accent`);
        expect(entry.softBorder).toBe(`border-session-${type}-soft`);
    });

    it('never reaches for a raw palette or an arbitrary value', () => {
        // `bg-sky-500`, `text-amber-700`, `bg-[#B45309]` — the drift shapes. Every class must name
        // a session token, so a state can only be re-coloured by editing the token, in one place.
        const classFields = REQUIRED_FIELDS.filter((f) => !['type', 'label', 'Icon', 'onShell'].includes(f));
        for (const type of SESSION_TYPES) {
            for (const field of classFields) {
                expect(SESSION_COLORS[type][field], `${type}.${field}`).toMatch(/^[a-z-]+-session-[A-Za-z]+-[a-z]+$/);
            }
        }
    });

    it('gives each state its own distinct shell — two states must never look alike', () => {
        const shells = SESSION_TYPES.map((t) => SESSION_COLORS[t].shell);
        expect(new Set(shells).size).toBe(SESSION_TYPES.length);
    });
});

describe('SESSION_COLORS — on-shell legibility (§4-D)', () => {
    it('quick-work is the ONLY state whose shell is saturated enough to need white text (§4-C)', () => {
        // The saturated red shell is reserved for quick-work; the other three are pale tints that
        // must keep dark on-shell text. A state that starts demanding white text has changed its
        // shell into a loud one, which is the rule this pins.
        expect(SESSION_COLORS.quickWork.onShell).toBe('text-white');
        for (const type of ['call', 'break', 'task']) {
            expect(SESSION_COLORS[type].onShell, type).toBe('text-gray-900');
        }
    });

    it('on-shell text never uses the themeable ink token, which would invert and vanish', () => {
        for (const type of SESSION_TYPES) {
            expect(SESSION_COLORS[type].onShell).not.toContain('text-ink');
        }
    });
});

describe('getSessionColors', () => {
    it.each(SESSION_TYPES)('resolves %s to its entry', (type) => {
        expect(getSessionColors(type)).toBe(SESSION_COLORS[type]);
    });

    it('returns null for idle and for an unknown state, never a partial object', () => {
        expect(getSessionColors(null)).toBeNull();
        expect(getSessionColors(undefined)).toBeNull();
        expect(getSessionColors('')).toBeNull();
        expect(getSessionColors('nonsense')).toBeNull();
    });

    it('the idle shell is token-backed, so it follows the theme instead of staying white', () => {
        expect(IDLE_SHELL).toBe('bg-surface-base');
    });
});
