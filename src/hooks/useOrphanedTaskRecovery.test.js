import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolveUntrackedGap's collaborators are mocked so the AUTO-CREDIT vs. FALL-BACK orchestration is
// exercised in isolation — no real Firestore write, no localStorage/DOM. Paths are relative to this
// file (same as the hook's own imports), which is what vi.mock resolves against.
vi.mock('../utils/sessionEditActions', () => ({ claimRecoveredGap: vi.fn() }));
vi.mock('../utils/recoveryNotice', () => ({ addRecoveryNotice: vi.fn() }));
// pauseTask is mocked so the pause→gap orchestration can be driven with a controlled result — the
// whole point is to prove the gap is credited only when OUR pause ran (non-null) and skipped when it
// was pre-empted/deduped (null). creditAndResumeTask is stubbed only because the hook imports it.
vi.mock('../utils/taskActions', () => ({ pauseTask: vi.fn(), creditAndResumeTask: vi.fn() }));

import { decideOrphanTaskRecovery, resolveUntrackedGap, pauseAtBeatAndResolveGap } from './useOrphanedTaskRecovery';
import { TIMER_HEARTBEAT_CONTINUE_MS, MAX_SESSION_MINUTES } from '../utils/timeUtils';
import { claimRecoveredGap } from '../utils/sessionEditActions';
import { addRecoveryNotice } from '../utils/recoveryNotice';
import { pauseTask } from '../utils/taskActions';

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

describe('resolveUntrackedGap — what happens to the untracked gap after a pause-at-beat recovery', () => {
    const task = { id: 't1', title: 'Garso komplektu patikrinimas', assignedUserId: 'worker-1' };
    const worker = { uid: 'worker-1', displayName: 'Giedrius' };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('AUTO-credits a plausible gap on the worker\'s own task and stamps a "credited" notice', async () => {
        claimRecoveredGap.mockResolvedValue({ ok: true, id: 'sess-1' });
        const decision = { gapFrom: 1000, gapTo: 1000 + 125 * 60000 }; // 125 min

        await resolveUntrackedGap(task, worker, decision);

        expect(claimRecoveredGap).toHaveBeenCalledTimes(1);
        expect(claimRecoveredGap).toHaveBeenCalledWith({
            task: { id: 't1', title: 'Garso komplektu patikrinimas' },
            worker,
            startTime: new Date(1000).toISOString(),
            endTime: new Date(1000 + 125 * 60000).toISOString(),
        });
        expect(addRecoveryNotice).toHaveBeenCalledTimes(1);
        expect(addRecoveryNotice).toHaveBeenCalledWith('worker-1', {
            kind: 'task-gap-credited', taskId: 't1', taskTitle: 'Garso komplektu patikrinimas',
            gapMinutes: 125, sessionId: 'sess-1',
        });
    });

    it('falls back to the opt-in claim offer when the auto-credit write fails', async () => {
        claimRecoveredGap.mockResolvedValue({ ok: false, error: 'write' });
        const decision = { gapFrom: 0, gapTo: 20 * 60000 };

        await resolveUntrackedGap(task, worker, decision);

        expect(claimRecoveredGap).toHaveBeenCalledTimes(1);
        expect(addRecoveryNotice).toHaveBeenCalledTimes(1);
        const notice = addRecoveryNotice.mock.calls[0][1];
        expect(notice.kind).toBe('task-gap');
        expect(notice.gapMinutes).toBe(20);
        expect(notice).not.toHaveProperty('sessionId');
    });

    it('falls back to the claim offer WITHOUT ever calling claimRecoveredGap when the task is not the current user\'s own', async () => {
        const otherWorker = { uid: 'someone-else' };
        const decision = { gapFrom: 0, gapTo: 20 * 60000 };

        await resolveUntrackedGap(task, otherWorker, decision);

        expect(claimRecoveredGap).not.toHaveBeenCalled();
        expect(addRecoveryNotice).toHaveBeenCalledTimes(1);
        expect(addRecoveryNotice.mock.calls[0][1].kind).toBe('task-gap');
    });

    it('falls back to the claim offer without calling claimRecoveredGap when there is no signed-in identity', async () => {
        const decision = { gapFrom: 0, gapTo: 20 * 60000 };

        await resolveUntrackedGap(task, null, decision);

        expect(claimRecoveredGap).not.toHaveBeenCalled();
        expect(addRecoveryNotice).toHaveBeenCalledTimes(1);
        expect(addRecoveryNotice.mock.calls[0][1].kind).toBe('task-gap');
    });

    it('does nothing for a sub-minute gap (rounds to 0) — no notice, no write', async () => {
        const decision = { gapFrom: 0, gapTo: 20000 }; // 20s
        await resolveUntrackedGap(task, worker, decision);
        expect(claimRecoveredGap).not.toHaveBeenCalled();
        expect(addRecoveryNotice).not.toHaveBeenCalled();
    });

    it('does nothing for an implausible (>16h) gap — a multi-day forgotten timer, not one shift', async () => {
        const decision = { gapFrom: 0, gapTo: (MAX_SESSION_MINUTES + 1) * 60000 };
        await resolveUntrackedGap(task, worker, decision);
        expect(claimRecoveredGap).not.toHaveBeenCalled();
        expect(addRecoveryNotice).not.toHaveBeenCalled();
    });

    it('does nothing when the task has no assignedUserId — nowhere to attribute or notify', async () => {
        const unassigned = { id: 't2', title: 'x', assignedUserId: '' };
        const decision = { gapFrom: 0, gapTo: 20 * 60000 };
        await resolveUntrackedGap(unassigned, worker, decision);
        expect(claimRecoveredGap).not.toHaveBeenCalled();
        expect(addRecoveryNotice).not.toHaveBeenCalled();
    });
});

// The double-credit guard: the pause-at-beat orchestration must credit the untracked gap ONLY when
// its own recovery pause actually ran. When the time-limit monitor auto-paused the same over-limit
// orphan one tick earlier, pauseTask's in-flight dedupe returns null and that one monitor session
// already covers the whole [beat → now] gap — so crediting the gap again here would write a second
// work_sessions row for the same interval and diverge the summed sessions from task.timerMinutes.
describe('pauseAtBeatAndResolveGap — the untracked gap is credited only when OUR pause ran', () => {
    const task = { id: 't1', title: 'Garso komplektu patikrinimas', assignedUserId: 'worker-1' };
    const worker = { uid: 'worker-1', displayName: 'Giedrius' };
    // A realistic pause-at-beat decision: credit up to the last beat, gap [beat → load] = 120 min —
    // comfortably inside [1 min, MAX_SESSION_MINUTES], the worker's OWN task, so resolveUntrackedGap
    // WOULD auto-credit if it were reached. That is what makes the null-result skip meaningful.
    const decision = {
        mode: 'pause-at-beat',
        creditTo: LOAD - 120 * 60000,
        gapFrom: LOAD - 120 * 60000,
        gapTo: LOAD,
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('credits the gap when our recovery pause actually ran (non-null result)', async () => {
        pauseTask.mockResolvedValue({ creditedMinutes: 30, rawMinutes: 30, wasCapped: false });
        claimRecoveredGap.mockResolvedValue({ ok: true, id: 'sess-gap' });

        await pauseAtBeatAndResolveGap(task, worker, decision);

        // Our pause credited up to the last beat, so the [beat → load] gap is auto-credited as its
        // own recovered-gap session.
        expect(pauseTask).toHaveBeenCalledTimes(1);
        expect(pauseTask).toHaveBeenCalledWith(task, { endTime: decision.creditTo });
        expect(claimRecoveredGap).toHaveBeenCalledTimes(1);
    });

    it('does NOT credit the gap when our pause was pre-empted (deduped null result)', async () => {
        // The time-limit monitor already paused this over-limit orphan up to NOW one tick earlier, so
        // pauseInFlight makes our recovery pause a no-op returning null. Its single session already
        // covers the whole [beat → now] gap; the gap resolution must be skipped to avoid a double credit.
        pauseTask.mockResolvedValue(null);

        await pauseAtBeatAndResolveGap(task, worker, decision);

        expect(pauseTask).toHaveBeenCalledTimes(1);
        // No SECOND work_sessions row, and no "recovered"/"gap" notice — the gap is left entirely to
        // the monitor's already-committed session.
        expect(claimRecoveredGap).not.toHaveBeenCalled();
        expect(addRecoveryNotice).not.toHaveBeenCalled();
    });
});
