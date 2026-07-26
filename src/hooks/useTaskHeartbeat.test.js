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

// Ownership supersedes the boot-time proxy. The proxy answered "did this run start after I booted",
// which any second context of the same worker that was already open also satisfies — so a laptop tab
// left open beside the phone kept stamping proof-of-life onto a run it merely observed, and (the beat
// being one flat last-write-wins field) OVERWROTE the dying phone's true final beat. Recovery then
// credited the whole dead stretch as worked. Ownership makes the beat mean what its consumers assume.
describe('isBeatableRun — ownership, not timing, decides who may beat', () => {
    const BOOT = new Date('2026-07-01T08:00:00Z').getTime();
    const iso = (ms) => new Date(ms).toISOString();
    const MINE = 'inst_mine';
    const THEIRS = 'inst_other_tab';
    const run = (over = {}) => ({
        id: 't1', timerStatus: 'running', timerStartedAt: iso(BOOT + 60000),
        assignedUserId: 'u1', ...over,
    });

    it('beats a run THIS instance anchored', () => {
        expect(isBeatableRun(run({ timerOwnerInstance: MINE }), 'u1', BOOT, MINE)).toBe(true);
    });

    it('does NOT beat a run another instance anchored, even though it started after this boot', () => {
        // The bystander case: this tab booted first, the phone then started the run. The old proxy
        // said "started after my boot → mine to beat"; ownership correctly says observer.
        expect(isBeatableRun(run({ timerOwnerInstance: THEIRS }), 'u1', BOOT, MINE)).toBe(false);
    });

    it('falls back to the boot-time proxy only for runs anchored before ownership existed', () => {
        expect(isBeatableRun(run(), 'u1', BOOT, MINE)).toBe(true);
        expect(isBeatableRun(run({ timerStartedAt: iso(BOOT - 60000) }), 'u1', BOOT, MINE)).toBe(false);
    });

    it('still refuses a foreign owner on someone else\'s task', () => {
        expect(isBeatableRun(
            run({ timerOwnerInstance: THEIRS, assignedUserId: 'someone-else' }), 'u1', BOOT, MINE,
        )).toBe(false);
    });
});
