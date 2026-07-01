import { describe, it, expect } from 'vitest';
import { decideOrphanTaskRecovery } from './useOrphanedTaskRecovery';
import { TIMER_HEARTBEAT_CONTINUE_MS } from '../utils/timeUtils';

// The credit-instant POLICY for a pre-boot running task, isolated from React so the arithmetic
// that decides how much worked time survives a crash/reload is provable directly. The bug this
// guards: a running task timer that leaked worked time on every reload because the brief-reload
// path credited only up to the last heartbeat, not the reload instant.

// Fixed reference instant so start/beat offsets are exact.
const LOAD = new Date('2026-07-01T11:00:00.000Z').getTime();
const iso = (ms) => new Date(ms).toISOString();

describe('decideOrphanTaskRecovery — which timers are orphans', () => {
    it('skips a timer with an unparseable start', () => {
        expect(decideOrphanTaskRecovery({ timerStartedAt: 'not-a-date' }, LOAD).mode).toBe('skip');
    });

    it('skips a timer started during THIS app session (start >= load)', () => {
        expect(decideOrphanTaskRecovery({ timerStartedAt: iso(LOAD + 1000) }, LOAD).mode).toBe('skip');
    });
});

describe('decideOrphanTaskRecovery — credit-instant policy', () => {
    it('no heartbeat → pause-now (credit up to now, downstream-clamped)', () => {
        const d = decideOrphanTaskRecovery({ timerStartedAt: iso(LOAD - 60 * 60 * 1000) }, LOAD);
        expect(d.mode).toBe('pause-now');
    });

    it('brief reload (tail within window) → resume, crediting up to the RELOAD INSTANT not the beat', () => {
        // Started 30m ago, last beat 2 min before load (tail = 2min < 3min window).
        const task = {
            timerStartedAt: iso(LOAD - 30 * 60 * 1000),
            timerLastHeartbeat: iso(LOAD - 2 * 60 * 1000),
        };
        const d = decideOrphanTaskRecovery(task, LOAD);
        expect(d.mode).toBe('resume');
        // The fix: creditTo is the load instant, so the ~2min tail of real work is NOT dropped.
        expect(d.creditTo).toBe(LOAD);
    });

    it('resume credit reaches exactly to load even when the beat is a full window old', () => {
        const task = {
            timerStartedAt: iso(LOAD - 30 * 60 * 1000),
            timerLastHeartbeat: iso(LOAD - TIMER_HEARTBEAT_CONTINUE_MS), // tail == window (boundary)
        };
        const d = decideOrphanTaskRecovery(task, LOAD);
        expect(d.mode).toBe('resume');
        expect(d.creditTo).toBe(LOAD);
    });

    it('large tail → pause at the last beat and expose the untracked gap [beat → load]', () => {
        const beat = LOAD - 20 * 60 * 1000; // 20 min tail, well past the 3-min window
        const task = {
            timerStartedAt: iso(LOAD - 60 * 60 * 1000),
            timerLastHeartbeat: iso(beat),
        };
        const d = decideOrphanTaskRecovery(task, LOAD);
        expect(d.mode).toBe('pause-at-beat');
        expect(d.creditTo).toBe(beat); // credit stops at the last proof of life, never the dead gap
        expect(d.gapFrom).toBe(beat);
        expect(d.gapTo).toBe(LOAD);
    });

    it('a stale beat BEFORE the start is clamped up to the start (never credits negative)', () => {
        const start = LOAD - 10 * 60 * 1000;
        const task = {
            timerStartedAt: iso(start),
            timerLastHeartbeat: iso(start - 5 * 60 * 1000), // beat predates start
        };
        const d = decideOrphanTaskRecovery(task, LOAD);
        // lastBeat := max(beat, start) = start → tail = 10min > window → pause at start.
        expect(d.mode).toBe('pause-at-beat');
        expect(d.creditTo).toBe(start);
    });
});
