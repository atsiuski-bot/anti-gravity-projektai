import { describe, it, expect, vi } from 'vitest';

// The hook's interval wiring is not rendered (no React test harness in the project); what is unique
// and load-bearing here is isBeatableSession — the rule deciding WHETHER this device may stamp
// proof-of-life onto a break / call / quick-work session. The firebase- and context-touching imports
// are mocked so the module loads in node.
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), updateDoc: vi.fn() }));
vi.mock('../utils/errorLog', () => ({ logError: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ userData: null }) }));

import { isBeatableSession } from './useSessionHeartbeat';

// The invariant this locks: activeSessionLastHeartbeat is the ONLY evidence the abandonment recovery
// has for where a secondary session really ended. Until now this hook had no ownership test at all —
// every open context of the worker beat the session — so a break whose phone died stayed "alive" for
// as long as any other tab was open, and recovery credited it up to the reopen instant instead of the
// true last proof of life. That is credited minutes the worker did not work.
describe('isBeatableSession — who may stamp proof-of-life on a secondary session', () => {
    const BOOT = new Date('2026-07-01T08:00:00Z').getTime();
    const iso = (ms) => new Date(ms).toISOString();
    const MINE = 'inst_mine';
    const THEIRS = 'inst_other_tab';
    const session = (over = {}) => ({ type: 'break', startTime: iso(BOOT + 60000), ...over });

    it('beats a session THIS instance started', () => {
        expect(isBeatableSession(session({ ownerInstance: MINE }), BOOT, MINE)).toBe(true);
    });

    it('does NOT beat a session another instance started, even though it began after this boot', () => {
        expect(isBeatableSession(session({ ownerInstance: THEIRS }), BOOT, MINE)).toBe(false);
    });

    it('falls back to the boot-time proxy for sessions started before ownership existed', () => {
        // Post-boot legacy session: this context is the only plausible owner, so beat it.
        expect(isBeatableSession(session(), BOOT, MINE)).toBe(true);
        // Pre-boot legacy session: an observed orphan, left for the recovery hook to judge.
        expect(isBeatableSession(session({ startTime: iso(BOOT - 60000) }), BOOT, MINE)).toBe(false);
    });

    it('ignores absent / unanchored / unparseable sessions', () => {
        expect(isBeatableSession(null, BOOT, MINE)).toBe(false);
        expect(isBeatableSession({ type: 'break' }, BOOT, MINE)).toBe(false);
        expect(isBeatableSession(session({ startTime: 'not-a-date' }), BOOT, MINE)).toBe(false);
    });
});
