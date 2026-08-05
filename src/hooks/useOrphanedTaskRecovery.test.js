import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolveUntrackedGap's collaborators are mocked so the AUTO-CREDIT vs. FALL-BACK orchestration is
// exercised in isolation — no real Firestore write, no localStorage/DOM. Paths are relative to this
// file (same as the hook's own imports), which is what vi.mock resolves against.
vi.mock('../utils/sessionEditActions', () => ({ claimRecoveredGap: vi.fn() }));
vi.mock('../utils/recoveryNotice', () => ({ addRecoveryNotice: vi.fn() }));
// The ADR-0024 escalation has its own suite (utils/gapClaim.test.js). Here it is mocked so this file
// stays about the auto-credit-vs-fall-back orchestration — and so its own "reached nobody" trace
// cannot be mistaken for one of the traces these tests assert on.
vi.mock('../utils/gapClaim', () => ({ raiseRefusedGapClaim: vi.fn(() => Promise.resolve({ ok: true })) }));
// pauseTask is mocked so the pause→gap orchestration can be driven with a controlled result — the
// whole point is to prove the gap is credited only when OUR pause ran (non-null) and skipped when it
// was pre-empted/deduped (null). creditAndResumeTask is stubbed only because the hook imports it.
vi.mock('../utils/taskActions', () => ({
    pauseTask: vi.fn(), creditAndResumeTask: vi.fn(),
    startTask: vi.fn(), clearLiveSessionAfterFailedResume: vi.fn(),
}));
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
import { pauseTask, creditAndResumeTask, startTask, clearLiveSessionAfterFailedResume } from '../utils/taskActions';
import { logError } from '../utils/errorLog';
import { raiseRefusedGapClaim } from '../utils/gapClaim';
import { getDocFromServer } from 'firebase/firestore';
// NOT mocked: the real composed owner is what the device gate parses, so these cases exercise the
// actual `{device}::{boot}` split rather than a stand-in for it.
import { APP_INSTANCE_ID } from '../utils/appInstance';

// Every recoverable fixture must look like a run THIS DEVICE anchored — recovery now refuses any
// other, because a pre-boot run belonging to the worker's phone is their LIVE timer, not an orphan.
const OURS = APP_INSTANCE_ID;
// A run anchored by the same worker on a different device (their phone), still beating there.
const THEIRS = 'dev_other_device::inst_whatever';

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
    it('no heartbeat → resume, crediting the whole stretch up to now (downstream-clamped)', () => {
        // Nothing proven to split the run on, so there is no gap to reason about: the stretch is
        // credited whole and the run continues, exactly as a brief reload does. Same outcome, so the
        // same mode — a separate 'pause-now' mode would now be a name that no longer pauses.
        const d = decideOrphanTaskRecovery({ timerStartedAt: iso(LOAD - 60 * 60 * 1000) }, LOAD);
        expect(d).toEqual({ mode: 'resume', creditTo: LOAD });
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

    // A real mid-morning instant, NOT epoch 0. Admission now also asks whether the gap stays inside
    // one work day, and epoch 0 is 03:00 Vilnius — just under the 05:00 boundary — so any fixture
    // longer than two hours from there silently "crosses midnight" and gets refused for the wrong
    // reason. The short fixtures below stay on epoch 0 harmlessly; anything longer must use this.
    const MORNING = Date.parse('2026-07-27T09:00:00.000Z'); // 12:00 Vilnius

    it('AUTO-credits a plausible gap on the worker\'s own task and stamps a "credited" notice', async () => {
        claimRecoveredGap.mockResolvedValue({ ok: true, id: 'sess-1' });
        const decision = { gapFrom: MORNING, gapTo: MORNING + 125 * 60000 }; // 125 min

        await resolveUntrackedGap(task, worker, decision);

        expect(claimRecoveredGap).toHaveBeenCalledTimes(1);
        expect(claimRecoveredGap).toHaveBeenCalledWith({
            task: { id: 't1', title: 'Garso komplektu patikrinimas' },
            worker,
            startTime: new Date(MORNING).toISOString(),
            endTime: new Date(MORNING + 125 * 60000).toISOString(),
        });
        expect(addRecoveryNotice).toHaveBeenCalledTimes(1);
        expect(addRecoveryNotice).toHaveBeenCalledWith('worker-1', {
            kind: 'task-gap-credited', taskId: 't1', taskTitle: 'Garso komplektu patikrinimas',
            gapMinutes: 125, sessionId: 'sess-1',
        });
    });

    // The production case (2026-07-27): a timer left running overnight. Under the old bound the
    // 10.4-hour gap was UNDER the 16h session ceiling, so it auto-credited 623 minutes of sleep.
    // It must now fall through to the opt-IN claim instead — refused is not the same as discarded.
    it('REFUSES to auto-credit an overnight gap, and offers the opt-in claim instead', async () => {
        const decision = {
            gapFrom: Date.parse('2026-07-26T19:18:43.000Z'), // 22:18 Vilnius
            gapTo: Date.parse('2026-07-27T05:41:56.000Z'),   // 08:41 Vilnius, next morning
        };

        await resolveUntrackedGap(task, worker, decision);

        expect(claimRecoveredGap, 'the night must not be auto-credited').not.toHaveBeenCalled();
        const notice = addRecoveryNotice.mock.calls[0][1];
        expect(notice.kind).toBe('task-gap');       // opt-IN claim, not "credited"
        expect(notice.gapMinutes).toBe(623);
        expect(logError.mock.calls[0][1]).toMatchObject({
            source: 'orphanRecovery:gapNotAutoCredited',
            cause: 'gap-not-one-work-stretch',
        });
    });

    it('REFUSES a shorter gap that still spans two work days', async () => {
        const decision = {
            gapFrom: Date.parse('2026-07-27T00:00:00.000Z'), // 03:00 Vilnius
            gapTo: Date.parse('2026-07-27T04:00:00.000Z'),   // 07:00 Vilnius — past the 05:00 line
        };

        await resolveUntrackedGap(task, worker, decision);

        expect(claimRecoveredGap).not.toHaveBeenCalled();
        expect(addRecoveryNotice.mock.calls[0][1].kind).toBe('task-gap');
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

    // ADR 0025. The localStorage offer above is per-device, shown once, and only to the worker — so on
    // its own it lets real worked time be forfeited in silence (Povilas, 2026-07-29: 3h51m). Every
    // fallback must ALSO hand the interval to the people who can settle it.
    it('ESCALATES the refused interval to the overseers, carrying the exact gap', async () => {
        const decision = {
            gapFrom: Date.parse('2026-07-26T19:18:43.000Z'),
            gapTo: Date.parse('2026-07-27T05:41:56.000Z'),
        };

        await resolveUntrackedGap(task, worker, decision);

        expect(raiseRefusedGapClaim).toHaveBeenCalledTimes(1);
        expect(raiseRefusedGapClaim.mock.calls[0][0]).toMatchObject({
            worker,
            gapMinutes: 623,
            cause: 'gap-not-one-work-stretch',
            // The engine tag is what lets the two recovery paths be told apart in triage; legacy and
            // canonical must both raise, so neither may go unlabelled.
            engine: 'legacy',
            fromIso: '2026-07-26T19:18:43.000Z',
            toIso: '2026-07-27T05:41:56.000Z',
        });
    });

    it('escalates a FAILED auto-credit too — the time is un-credited either way', async () => {
        claimRecoveredGap.mockResolvedValue({ ok: false, error: 'write' });
        const decision = { gapFrom: 0, gapTo: 20 * 60000 };

        await resolveUntrackedGap(task, worker, decision);

        expect(raiseRefusedGapClaim).toHaveBeenCalledTimes(1);
        expect(raiseRefusedGapClaim.mock.calls[0][0].cause).toBe('auto-credit-write-failed');
    });

    it('does NOT escalate somebody else\'s task — a claim is authored as its subject', async () => {
        const decision = { gapFrom: 0, gapTo: 20 * 60000 };

        await resolveUntrackedGap(task, { uid: 'someone-else' }, decision);

        expect(raiseRefusedGapClaim).not.toHaveBeenCalled();
    });

    it('a successfully AUTO-credited gap raises nothing — there is no decision owed', async () => {
        claimRecoveredGap.mockResolvedValue({ ok: true, id: 'sess_gap_t1_0' });
        const decision = { gapFrom: 0, gapTo: 20 * 60000 };

        await resolveUntrackedGap(task, worker, decision);

        expect(raiseRefusedGapClaim).not.toHaveBeenCalled();
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
        // skipUserStatusUpdate:true — a re-anchor always follows now, so the live session must not
        // blink out between the close and the restart.
        expect(pauseTask).toHaveBeenCalledWith(task, { endTime: decision.creditTo, skipUserStatusUpdate: true });
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

// The offline-restart case. The app restarted with no signal, so it could neither server-confirm the
// orphan nor beat it (it does not own the run) — while the worker watched a running timer and kept
// working. Every recovery re-anchors now, so what is special here is the SILENCE: the worker was
// looking at a running timer the whole time, so even the credited-gap banner would be an
// interruption reporting something they never experienced.
describe('pauseAtBeatAndResolveGap — silent continuation after an offline restart', () => {
    const task = { id: 't1', title: 'Garso komplektu patikrinimas', assignedUserId: 'worker-1' };
    const worker = { uid: 'worker-1', displayName: 'Giedrius' };
    const decision = {
        mode: 'pause-at-beat',
        creditTo: LOAD - 120 * 60000,
        gapFrom: LOAD - 120 * 60000,
        gapTo: LOAD,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        pauseTask.mockResolvedValue({ creditedMinutes: 30, rawMinutes: 30, wasCapped: false });
        claimRecoveredGap.mockResolvedValue({ ok: true, id: 'sess-gap' });
        startTask.mockResolvedValue(true);
    });

    it('re-anchors the timer and shows NO "recovered and stopped" notice', async () => {
        await pauseAtBeatAndResolveGap(task, worker, decision, { silentGap: true });

        // The proven stretch and the gap are credited exactly as on the stopping path…
        expect(pauseTask).toHaveBeenCalledWith(task, { endTime: decision.creditTo, skipUserStatusUpdate: true });
        expect(claimRecoveredGap).toHaveBeenCalledTimes(1);
        // …but the timer continues, and the worker is not told about a stop that never happened.
        expect(startTask).toHaveBeenCalledWith(task, 'worker-1');
        const noticeKinds = addRecoveryNotice.mock.calls.map(([, n]) => n.kind);
        // kind 'task' is the "Laikmatis atkurtas … buvo automatiškai sustabdytas" banner — a lie
        // on this path, since the timer is still running.
        expect(noticeKinds).not.toContain('task');
        // Fully silent: not even the gap's success banner. The timer never stopped, so there is
        // nothing to report — any banner here would be the one interruption in a seamless recovery.
        expect(addRecoveryNotice).not.toHaveBeenCalled();
    });

    it('STILL offers the claim when the gap auto-credit fails — silence never costs real time', async () => {
        // Silence applies only to the success banner. A failed auto-credit means the time is
        // genuinely un-credited, so the worker must be offered the claim and a durable trace left.
        claimRecoveredGap.mockResolvedValue({ ok: false });

        await pauseAtBeatAndResolveGap(task, worker, decision, { silentGap: true });

        expect(addRecoveryNotice.mock.calls.map(([, n]) => n.kind)).toContain('task-gap');
        expect(logError).toHaveBeenCalled();
    });

    it('falls back to clearing the session and telling the worker when the re-anchor is refused', async () => {
        // startTask fails CLOSED (returns false, never throws) — e.g. a live break superseded the run.
        startTask.mockResolvedValue(false);

        await pauseAtBeatAndResolveGap(task, worker, decision, { silentGap: true });

        // The skipped clear must happen after all, or a stopped timer keeps a "still working" banner.
        expect(clearLiveSessionAfterFailedResume).toHaveBeenCalledWith(task);
        expect(addRecoveryNotice.mock.calls.map(([, n]) => n.kind)).toContain('task');
    });

    it('does not re-anchor when our pause was pre-empted (deduped null result)', async () => {
        pauseTask.mockResolvedValue(null);

        await pauseAtBeatAndResolveGap(task, worker, decision, { silentGap: true });

        // Another closer owns this stretch; restarting on top of it would re-anchor a run we did
        // not close and invent a second live timer.
        expect(claimRecoveredGap).not.toHaveBeenCalled();
        expect(startTask).not.toHaveBeenCalled();
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
            timerOwnerInstance: OURS,
        }));
        const fresh = await confirmTaskOrphanOnServer(suspect);
        // The fresh copy (true timerMinutes base, true beat) is what recovery must act on.
        expect(fresh).toMatchObject({ id: 't1', timerMinutes: 42 });
    });

    // The reported incident: a worker's phone runs a task; they sit down at a PC and sign in; the
    // PC stops the phone's timer, and it will not restart. The run is pre-boot from the PC's view
    // (it always is), and the phone's heartbeat is foreground-only so a pocketed phone always looks
    // dead — which left "started before I booted" indistinguishable from "abandoned". Ownership by
    // DEVICE is the distinction; without it these two cases are the same case.
    it('leaves a run anchored by the worker\'s OTHER device alone — it is live, not orphaned', async () => {
        getDocFromServer.mockResolvedValue(serverDoc({
            timerStatus: 'running', timerStartedAt: START, timerMinutes: 42,
            // Stale by this device's reckoning — the phone is in a pocket, screen off, still working.
            timerLastHeartbeat: iso(LOAD - 45 * 60 * 1000),
            timerOwnerInstance: THEIRS,
        }));
        expect(await confirmTaskOrphanOnServer(suspect)).toBeNull();
    });

    it('leaves an UNSTAMPED run alone — unprovable ownership must not cost someone a live timer', async () => {
        // Runs anchored before this scheme carry no owner. Guessing "probably mine" is the guess
        // that stops a working timer; the server's forgotten-timer net closes these instead.
        getDocFromServer.mockResolvedValue(serverDoc({
            timerStatus: 'running', timerStartedAt: START, timerMinutes: 42,
        }));
        expect(await confirmTaskOrphanOnServer(suspect)).toBeNull();
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
            timerOwnerInstance: OURS,
        };
        getDocFromServer.mockResolvedValue(serverDoc(fresh));
        pauseTask.mockResolvedValue({ creditedMinutes: 30, rawMinutes: 30, wasCapped: false });
        claimRecoveredGap.mockResolvedValue({ ok: true, id: 'sess-gap' });
        startTask.mockResolvedValue(true);
        // The stale trigger copy carries an OLD minutes base — it must not reach pauseTask.
        const stale = { id: 't1', timerStatus: 'running', timerStartedAt: START, timerMinutes: 10, assignedUserId: 'worker-1' };

        await recoverConfirmedOrphan(stale, worker, LOAD);

        expect(pauseTask).toHaveBeenCalledTimes(1);
        const [pausedTask, opts] = pauseTask.mock.calls[0];
        expect(pausedTask.timerMinutes).toBe(55); // the SERVER doc, not the stale snapshot copy
        // skipUserStatusUpdate:true — this 30-minute absence is auto-credited as work, so the run
        // is re-anchored right after and the live session must not blink out in between.
        expect(opts).toEqual({ endTime: beat, skipUserStatusUpdate: true });
        expect(claimRecoveredGap).toHaveBeenCalledTimes(1); // the [beat → LOAD] gap auto-credit
    });

    // The iPhone report (2026-08-05), on the legacy engine: a backgrounded PWA is discarded by iOS,
    // so returning to the app is a cold boot whose foreground-only heartbeat is always stale. The
    // absence is auto-credited as work — and the timer must not be stopped over the same minutes we
    // just paid for, or the worker has to press start again on every single re-open.
    it('re-anchors the timer when the absence is auto-credited as work', async () => {
        const beat = LOAD - 30 * 60 * 1000;
        getDocFromServer.mockResolvedValue(serverDoc({
            timerStatus: 'running', timerStartedAt: START, timerLastHeartbeat: iso(beat),
            assignedUserId: 'worker-1', title: 'X', timerOwnerInstance: OURS,
        }));
        pauseTask.mockResolvedValue({ creditedMinutes: 30, rawMinutes: 30, wasCapped: false });
        claimRecoveredGap.mockResolvedValue({ ok: true, id: 'sess-gap' });
        startTask.mockResolvedValue(true);
        const stale = { id: 't1', timerStatus: 'running', timerStartedAt: START, assignedUserId: 'worker-1' };

        await recoverConfirmedOrphan(stale, worker, LOAD);

        expect(startTask).toHaveBeenCalledTimes(1);
        // No "recovered and stopped" banner — it was not stopped…
        expect(addRecoveryNotice.mock.calls.map(([, n]) => n.kind)).not.toContain('task');
        // …but the credited minutes DO get their opt-out banner. Silence is for the offline restart
        // alone, where the worker watched the timer the whole time; here they were away, and this
        // banner is their only way to refuse pay for an absence they did not work.
        expect(addRecoveryNotice.mock.calls.map(([, n]) => n.kind)).toContain('task-gap-credited');
    });

    // The separation the whole policy rests on: CONTINUING is not PAYING. A refused absence still
    // re-anchors the timer — the worker is the only one who stops it — but not one of its minutes is
    // credited without a decision.
    it('re-anchors the timer but pays nothing when the absence is too long to be credited', async () => {
        // 6h away — past MAX_UNTRACKED_GAP_MINUTES, so the gap falls back to the opt-IN claim.
        const beat = LOAD - 6 * 60 * 60 * 1000;
        getDocFromServer.mockResolvedValue(serverDoc({
            timerStatus: 'running', timerStartedAt: START, timerLastHeartbeat: iso(beat),
            assignedUserId: 'worker-1', title: 'X', timerOwnerInstance: OURS,
        }));
        pauseTask.mockResolvedValue({ creditedMinutes: 120, rawMinutes: 120, wasCapped: false });
        startTask.mockResolvedValue(true);
        const stale = { id: 't1', timerStatus: 'running', timerStartedAt: START, assignedUserId: 'worker-1' };

        await recoverConfirmedOrphan(stale, worker, LOAD);

        // Closed at the last proof of life, re-anchored from there — the session never blinks out.
        expect(pauseTask.mock.calls[0][1]).toEqual({ endTime: beat, skipUserStatusUpdate: true });
        expect(startTask).toHaveBeenCalledTimes(1);
        // …and the six unproven hours are NOT auto-credited: they go to the opt-IN claim instead.
        expect(claimRecoveredGap).not.toHaveBeenCalled();
        expect(addRecoveryNotice.mock.calls.map(([, n]) => n.kind)).toContain('task-gap');
    });

    it('dispatches resume (credit + re-anchor) for a brief-reload orphan', async () => {
        const fresh = {
            timerStatus: 'running', timerStartedAt: START,
            timerLastHeartbeat: iso(LOAD - 60 * 1000), // 1-min tail → resume
            assignedUserId: 'worker-1', timerOwnerInstance: OURS,
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
