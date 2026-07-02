import { describe, it, expect, vi } from 'vitest';

// The hook's interval wiring is not rendered (no React test harness in the project); what is unique
// and load-bearing here is isBeatableRun — the rule deciding WHICH running task this device may
// stamp proof-of-life onto. The firebase-touching imports are mocked so the module loads in node.
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), updateDoc: vi.fn() }));
vi.mock('../utils/errorLog', () => ({ logError: vi.fn() }));

import { isBeatableRun } from './useTaskHeartbeat';

// The invariant this locks: a heartbeat is the "proof of life" orphan recovery uses to tell a live
// timer from an abandoned one — and recovery now SERVER-CONFIRMS that proof before acting. A device
// that merely OBSERVES a pre-boot running task must therefore never beat it: the old unconditional
// immediate beat blessed every orphan as alive at boot, poisoning the confirmation. Every legitimate
// continuation re-anchors timerStartedAt (creditAndResumeTask / resumeTask / startTask), so a truly
// live run always becomes beatable the moment recovery lets it continue.
describe('isBeatableRun — which running task this device may stamp proof-of-life onto', () => {
    const BOOT = new Date('2026-07-01T08:00:00Z').getTime();
    const iso = (ms) => new Date(ms).toISOString();
    const run = (over = {}) => ({
        id: 't1', timerStatus: 'running', timerStartedAt: iso(BOOT + 60000),
        assignedUserId: 'u1', ...over,
    });

    it('beats a run started (or re-anchored) during THIS app session', () => {
        expect(isBeatableRun(run(), 'u1', BOOT)).toBe(true);
        // Boundary: a re-anchor at exactly the boot instant is this-session work.
        expect(isBeatableRun(run({ timerStartedAt: iso(BOOT) }), 'u1', BOOT)).toBe(true);
    });

    it('NEVER beats a pre-boot run — an observed orphan must stay unblessed for recovery to judge', () => {
        expect(isBeatableRun(run({ timerStartedAt: iso(BOOT - 60000) }), 'u1', BOOT)).toBe(false);
    });

    it('only beats the current user\'s own running task', () => {
        expect(isBeatableRun(run({ assignedUserId: 'someone-else' }), 'u1', BOOT)).toBe(false);
        expect(isBeatableRun(run(), null, BOOT)).toBe(false);
    });

    it('ignores non-running / unanchored / unparseable states', () => {
        expect(isBeatableRun(run({ timerStatus: 'paused' }), 'u1', BOOT)).toBe(false);
        expect(isBeatableRun(run({ timerStartedAt: null }), 'u1', BOOT)).toBe(false);
        expect(isBeatableRun(run({ timerStartedAt: 'not-a-date' }), 'u1', BOOT)).toBe(false);
        expect(isBeatableRun(null, 'u1', BOOT)).toBe(false);
    });
});
