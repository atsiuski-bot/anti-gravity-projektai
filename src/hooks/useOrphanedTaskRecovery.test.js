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
vi.mock('../utils/errorLog', () => ({ logError: vi.fn() }));
// The confirm step reads the task doc straight from the SERVER; mocked so the confirm→decide→
// dispatch orchestration is drivable with a controlled fresh doc and a controlled failure.
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
    getDocFromServer: vi.fn(),
}));

import {
    decideOrphanTaskRecovery, resolveUntrackedGap, pauseAtBeatAndResolveGap,
    confirmTaskOrphanOnServer, recoverConfirmedOrphan,
} from './useOrphanedTaskRecovery';
import { TIMER_HEARTBEAT_CONTINUE_MS, MAX_SESSION_MINUTES } from '../utils/timeUtils';
import { claimRecoveredGap } from '../utils/sessionEditActions';
import { addRecoveryNotice } from '../utils/recoveryNotice';
import { pauseTask, creditAndResumeTask } from '../utils/taskActions';
import { logError } from '../utils/errorLog';
import { getDocFromServer } from 'firebase/firestore';

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

    // The trace closes the "silent traceless loss" hole: the opt-in claim offer lives only in
    // per-device localStorage, so a fallback the worker never taps left NO server record — exactly why
    // Simona's lost 42 min could not be traced (no error_logs, just a cold "Neaktyvus" band). Every
    // fallback now logs the un-credited gap so the next triage can find and restore it.
    it('leaves a server trace (logError) naming the gap when the auto-credit write fails', async () => {
        claimRecoveredGap.mockResolvedValue({ ok: false, error: 'write' });
        const decision = { gapFrom: 1000, gapTo: 1000 + 20 * 60000 };

        await resolveUntrackedGap(task, worker, decision);

        expect(logError).toHaveBeenCalledTimes(1);
        expect(logError.mock.calls[0][1]).toMatchObject({
            source: 'orphanRecovery:gapNotAutoCredited',
            taskId: 't1', gapMinutes: 20, cause: 'auto-credit-write-failed',
            fromIso: new Date(1000).toISOString(), toIso: new Date(1000 + 20 * 60000).toISOString(),
        });
    });

    it('leaves a server trace (logError) when the gap is not the signed-in worker\'s own task', async () => {
        const decision = { gapFrom: 0, gapTo: 20 * 60000 };

        await resolveUntrackedGap(task, null, decision);

        expect(claimRecoveredGap).not.toHaveBeenCalled();
        expect(logError).toHaveBeenCalledTimes(1);
        expect(logError.mock.calls[0][1]).toMatchObject({
            source: 'orphanRecovery:gapNotAutoCredited', taskId: 't1', cause: 'not-own-task',
        });
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

// The server-confirmation gate: a suspected orphan comes off a possibly-stale cached snapshot, and
// every cross-writer double-credit in this class (server auto-stop × client recovery, two devices)
// started with a recovery that ACTED on that stale copy. These lock the rule: no recovery write
// without a server read proving the same run is still live.
describe('confirmTaskOrphanOnServer — no recovery without server proof', () => {
    const START = iso(LOAD - 60 * 60 * 1000);
    const suspect = { id: 't1', timerStatus: 'running', timerStartedAt: START };
    const serverDoc = (data) => ({ exists: () => true, id: 't1', data: () => data });

    beforeEach(() => vi.clearAllMocks());

    it('returns the FRESH doc when the same run is still running on the server', async () => {
        getDocFromServer.mockResolvedValue(serverDoc({
            timerStatus: 'running', timerStartedAt: START, timerMinutes: 42,
        }));
        const fresh = await confirmTaskOrphanOnServer(suspect);
        // The fresh copy (true timerMinutes base, true beat) is what recovery must act on.
        expect(fresh).toMatchObject({ id: 't1', timerMinutes: 42 });
    });

    it('returns null when the server says the run was already finalized (auto-stop / other device)', async () => {
        getDocFromServer.mockResolvedValue(serverDoc({ timerStatus: 'paused', timerStartedAt: null }));
        expect(await confirmTaskOrphanOnServer(suspect)).toBeNull();
    });

    it('returns null when a NEW run replaced the suspected one (different timerStartedAt)', async () => {
        getDocFromServer.mockResolvedValue(serverDoc({
            timerStatus: 'running', timerStartedAt: iso(LOAD + 5000),
        }));
        expect(await confirmTaskOrphanOnServer(suspect)).toBeNull();
    });

    it('returns null when the task no longer exists', async () => {
        getDocFromServer.mockResolvedValue({ exists: () => false });
        expect(await confirmTaskOrphanOnServer(suspect)).toBeNull();
    });

    it('PROPAGATES a failed server read (offline) — the caller must retry, never fall back to cache', async () => {
        getDocFromServer.mockRejectedValue(new Error('unavailable'));
        await expect(confirmTaskOrphanOnServer(suspect)).rejects.toThrow('unavailable');
    });
});

describe('recoverConfirmedOrphan — confirm → re-decide on the fresh doc → dispatch', () => {
    const START = iso(LOAD - 8 * 60 * 60 * 1000); // pre-boot, 8h before LOAD
    const worker = { uid: 'worker-1', displayName: 'Giedrius' };
    const serverDoc = (data) => ({ exists: () => true, id: 't1', data: () => data });

    beforeEach(() => vi.clearAllMocks());

    it('writes NOTHING when the server refutes the orphan (the stale-cache double-credit path)', async () => {
        // The cached snapshot still says "running", but the server auto-stop already paused it and
        // credited [start → beat]. Acting anyway used to log the SAME interval a second time.
        getDocFromServer.mockResolvedValue(serverDoc({ timerStatus: 'paused', timerStartedAt: null }));
        const stale = { id: 't1', timerStatus: 'running', timerStartedAt: START, assignedUserId: 'worker-1' };

        await recoverConfirmedOrphan(stale, worker, LOAD);

        expect(pauseTask).not.toHaveBeenCalled();
        expect(creditAndResumeTask).not.toHaveBeenCalled();
        expect(claimRecoveredGap).not.toHaveBeenCalled();
        expect(addRecoveryNotice).not.toHaveBeenCalled();
    });

    it('dispatches pause-at-beat on the FRESH doc (fresh minutes base, fresh beat), not the stale copy', async () => {
        const beat = LOAD - 30 * 60 * 1000; // 30-min tail → pause-at-beat
        const fresh = {
            timerStatus: 'running', timerStartedAt: START, timerLastHeartbeat: iso(beat),
            timerMinutes: 55, assignedUserId: 'worker-1', title: 'X',
        };
        getDocFromServer.mockResolvedValue(serverDoc(fresh));
        pauseTask.mockResolvedValue({ creditedMinutes: 30, rawMinutes: 30, wasCapped: false });
        claimRecoveredGap.mockResolvedValue({ ok: true, id: 'sess-gap' });
        // The stale trigger copy carries an OLD minutes base — it must not reach pauseTask.
        const stale = { id: 't1', timerStatus: 'running', timerStartedAt: START, timerMinutes: 10, assignedUserId: 'worker-1' };

        await recoverConfirmedOrphan(stale, worker, LOAD);

        expect(pauseTask).toHaveBeenCalledTimes(1);
        const [pausedTask, opts] = pauseTask.mock.calls[0];
        expect(pausedTask.timerMinutes).toBe(55); // the SERVER doc, not the stale snapshot copy
        expect(opts).toEqual({ endTime: beat });
        expect(claimRecoveredGap).toHaveBeenCalledTimes(1); // the [beat → LOAD] gap auto-credit
    });

    it('dispatches resume (credit + re-anchor) for a brief-reload orphan', async () => {
        const fresh = {
            timerStatus: 'running', timerStartedAt: START,
            timerLastHeartbeat: iso(LOAD - 60 * 1000), // 1-min tail → resume
            assignedUserId: 'worker-1',
        };
        getDocFromServer.mockResolvedValue(serverDoc(fresh));
        const stale = { id: 't1', timerStatus: 'running', timerStartedAt: START, assignedUserId: 'worker-1' };

        await recoverConfirmedOrphan(stale, worker, LOAD);

        expect(creditAndResumeTask).toHaveBeenCalledTimes(1);
        expect(creditAndResumeTask.mock.calls[0][1]).toBe(LOAD); // credit up to the (injected) confirm instant
        expect(pauseTask).not.toHaveBeenCalled();
    });

    it('rethrows a confirm failure so the hook unlatches and a later snapshot retries', async () => {
        getDocFromServer.mockRejectedValue(new Error('unavailable'));
        const stale = { id: 't1', timerStatus: 'running', timerStartedAt: START, assignedUserId: 'worker-1' };

        await expect(recoverConfirmedOrphan(stale, worker, LOAD)).rejects.toThrow('unavailable');
        expect(pauseTask).not.toHaveBeenCalled();
        expect(creditAndResumeTask).not.toHaveBeenCalled();
    });
});
