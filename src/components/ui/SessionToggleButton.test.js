import { describe, it, expect } from 'vitest';
import { sessionToggleClasses } from './sessionToggleClasses';

/**
 * Locks BYTE-LEVEL class equivalence between SessionToggleButton and the three hand-rolled
 * timer buttons it replaced (BreakTimer / CallTimer / QuickWorkTimer, pre full-sweep M6). The
 * literal strings below are exactly what those buttons rendered. Comparing as a sorted SET (not
 * a raw string) means class ORDER is irrelevant — only the applied utility set matters for CSS,
 * and that set must be identical, proving the extraction is a no-visual-change refactor. Runs in
 * the node env (no DOM) by testing the pure resolver, not a render.
 */

// Shared base scaffolds (per variant) the old buttons inlined.
const COMPACT_BASE =
    'inline-flex items-center justify-center min-h-touch min-w-touch rounded-control transition-all active:scale-95 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2';
const LABELED_BASE =
    'inline-flex items-center justify-center gap-2 min-h-touch px-4 py-2.5 rounded-control text-body font-medium transition-colors shadow-sm ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2';

const toSet = (s) => new Set(s.trim().split(/\s+/).filter(Boolean));
const expectSameClasses = (actual, expected) =>
    expect([...toSet(actual)].sort()).toEqual([...toSet(expected)].sort());

describe('sessionToggleClasses — byte-equivalence with the pre-refactor timer buttons', () => {
    // --- compact (icon-only square): the mobile work-controls pill / side rail ---
    it('compact rest', () => {
        expectSameClasses(
            sessionToggleClasses({ session: 'break', variant: 'compact', active: false, disabled: false }),
            `${COMPACT_BASE} bg-surface-sunken text-ink hover:bg-line`
        );
    });

    it('compact disabled', () => {
        expectSameClasses(
            sessionToggleClasses({ session: 'break', variant: 'compact', active: false, disabled: true }),
            `${COMPACT_BASE} opacity-50 cursor-not-allowed bg-surface-sunken text-ink-muted`
        );
    });

    it('compact active — break (accent fill + shell ring)', () => {
        expectSameClasses(
            sessionToggleClasses({ session: 'break', variant: 'compact', active: true }),
            `${COMPACT_BASE} bg-session-break-accent text-white ring-2 ring-session-break-shell`
        );
    });

    it('compact active — call (accent fill + shell ring)', () => {
        expectSameClasses(
            sessionToggleClasses({ session: 'call', variant: 'compact', active: true }),
            `${COMPACT_BASE} bg-session-call-accent text-white ring-2 ring-session-call-shell`
        );
    });

    it('compact active — quickWork (shell fill + soft ring + glow)', () => {
        expectSameClasses(
            sessionToggleClasses({ session: 'quickWork', variant: 'compact', active: true }),
            `${COMPACT_BASE} bg-session-quickWork-shell text-white ring-2 ring-session-quickWork-soft shadow-lg shadow-session-quickWork-shell/20`
        );
    });

    // --- labeled (icon + text): BreakTimer's wide variant ---
    it('labeled rest', () => {
        expectSameClasses(
            sessionToggleClasses({ session: 'break', variant: 'labeled', active: false }),
            `${LABELED_BASE} bg-surface-card text-ink hover:bg-surface-sunken border border-line`
        );
    });

    it('labeled disabled', () => {
        expectSameClasses(
            sessionToggleClasses({ session: 'break', variant: 'labeled', disabled: true }),
            `${LABELED_BASE} bg-surface-sunken text-ink-muted cursor-not-allowed border border-line`
        );
    });

    it('labeled active — break', () => {
        expectSameClasses(
            sessionToggleClasses({ session: 'break', variant: 'labeled', active: true }),
            `${LABELED_BASE} bg-session-break-surface text-session-break-accent hover:bg-session-break-shell border border-session-break-soft`
        );
    });

    // --- robustness: never throw on bad input; default sensibly ---
    it('unknown variant falls back to compact', () => {
        expectSameClasses(
            sessionToggleClasses({ session: 'break', variant: 'bogus', active: false }),
            `${COMPACT_BASE} bg-surface-sunken text-ink hover:bg-line`
        );
    });

    it('active with unknown session falls back to the neutral rest block (no throw)', () => {
        expectSameClasses(
            sessionToggleClasses({ session: 'bogus', variant: 'compact', active: true }),
            `${COMPACT_BASE} bg-surface-sunken text-ink hover:bg-line`
        );
    });

    it('forwards a caller className', () => {
        expect(toSet(sessionToggleClasses({ session: 'break', variant: 'compact', className: 'mt-2' })).has('mt-2')).toBe(true);
    });
});
