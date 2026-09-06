import { describe, it, expect, vi } from 'vitest';

// The revisioned engine runs for EVERY worker now, so its crash-recovery gate is on the hot path for
// all of them — and it had no test of its own. What it decides is not "how much time to credit"
// (that is planTaskRecover, covered in timerTransitionPlan.test.js) but the far more dangerous
// question of WHICH runs this boot may touch at all. Both incidents this gate exists to prevent are
// silent and expensive: crediting a stretch the server already closed (a second ledger row for the
// same minutes, under an id that can never dedupe), and stopping a timer the worker is running right
// now on another device (the reported "when I sign in on the PC, my phone timer stops").
//
// Firestore and the plan/command machinery are mocked away: these two predicates are pure, and the
// point is to exercise them directly rather than through an effect. `appInstance` is NOT mocked —
// the real `{device}::{boot}` composition is exactly what the device clause parses, so a stand-in
// would test the stand-in.
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), getDocFromServer: vi.fn() }));
vi.mock('./useRevisionedTimerSession', () => ({ useRevisionedTimerSession: vi.fn() }));
vi.mock('../utils/timerTransitionPlan', () => ({ canonicalSessionState: vi.fn(), planTaskRecover: vi.fn() }));
vi.mock('../utils/timerCommandEngine', () => ({ issueTimerCommand: vi.fn() }));
vi.mock('../utils/serverClock', () => ({ awaitServerClock: vi.fn(), serverNowISO: vi.fn() }));
vi.mock('../utils/recoveryNotice', () => ({ addRecoveryNotice: vi.fn() }));
vi.mock('../utils/gapClaim', () => ({ raiseRefusedGapClaim: vi.fn() }));
vi.mock('../utils/errorLog', () => ({ logError: vi.fn() }));
vi.mock('./useOrphanedTaskRecovery', () => ({ appLoadTimeServer: vi.fn() }));

import { taskRunAwaitingRecovery, canRecoverConfirmedRun } from './useRevisionedTaskRecovery';
import { APP_INSTANCE_ID, DEVICE_ID } from '../utils/appInstance';

const BOOT = new Date('2026-07-01T11:00:00.000Z').getTime();
const iso = (ms) => new Date(ms).toISOString();

// A run anchored by THIS device (the only kind recovery may act on) and one anchored elsewhere.
const OURS = APP_INSTANCE_ID;
const SAME_DEVICE_EARLIER_BOOT = `${DEVICE_ID}::inst_a_previous_boot`;
const OTHER_DEVICE = 'dev_the_workers_phone::inst_whatever';

const activeTaskRun = (over = {}) => ({
    status: 'active',
    run: { type: 'task', runId: 'run-1', taskId: 'task-1', startedAt: iso(BOOT - 60_000), ...over },
});

const freshTask = (over = {}) => ({
    id: 'task-1',
    timerStatus: 'running',
    timerStartedAt: iso(BOOT - 60_000),
    timerRunId: 'run-1',
    timerOwnerInstance: OURS,
    ...over,
});

describe('taskRunAwaitingRecovery — which runs this boot may even consider', () => {
    it('returns the run when an active task run started before this boot', () => {
        const base = activeTaskRun();
        expect(taskRunAwaitingRecovery(base, BOOT)).toBe(base.run);
    });

    it('ignores a run that started AT or AFTER this boot — that is the live timer, not an orphan', () => {
        expect(taskRunAwaitingRecovery(activeTaskRun({ startedAt: iso(BOOT) }), BOOT)).toBeNull();
        expect(taskRunAwaitingRecovery(activeTaskRun({ startedAt: iso(BOOT + 1000) }), BOOT)).toBeNull();
    });

    it('ignores an idle record and a record with no run', () => {
        expect(taskRunAwaitingRecovery({ status: 'idle', run: null }, BOOT)).toBeNull();
        expect(taskRunAwaitingRecovery({ status: 'active', run: null }, BOOT)).toBeNull();
    });

    it('ignores a secondary run — break, call and quick work have their own recovery path', () => {
        for (const type of ['break', 'call', 'quickWork']) {
            expect(taskRunAwaitingRecovery(activeTaskRun({ type }), BOOT), type).toBeNull();
        }
    });

    it('ignores an unparseable or missing start instant instead of treating it as epoch zero', () => {
        expect(taskRunAwaitingRecovery(activeTaskRun({ startedAt: 'not-a-date' }), BOOT)).toBeNull();
        expect(taskRunAwaitingRecovery(activeTaskRun({ startedAt: undefined }), BOOT)).toBeNull();
    });

    it('tolerates a missing record without throwing at boot', () => {
        expect(taskRunAwaitingRecovery(null, BOOT)).toBeNull();
        expect(taskRunAwaitingRecovery(undefined, BOOT)).toBeNull();
    });
});

describe('canRecoverConfirmedRun — what the SERVER must still say', () => {
    it('admits a run the server still shows running, same id, anchored by this device', () => {
        expect(canRecoverConfirmedRun(freshTask(), 'run-1')).toBe(true);
    });

    it('refuses when the server already stopped the timer — the forgotten-timer net got there first', () => {
        // Recovering here is the double-credit incident: the server has already written
        // work_sessions for these minutes under a different id.
        expect(canRecoverConfirmedRun(freshTask({ timerStatus: 'paused' }), 'run-1')).toBe(false);
        expect(canRecoverConfirmedRun(freshTask({ timerStatus: undefined }), 'run-1')).toBe(false);
    });

    it('refuses when the running flag survives but the start instant is gone', () => {
        expect(canRecoverConfirmedRun(freshTask({ timerStartedAt: null }), 'run-1')).toBe(false);
    });

    it('refuses a DIFFERENT run — the worker has started a new one since', () => {
        expect(canRecoverConfirmedRun(freshTask({ timerRunId: 'run-2' }), 'run-1')).toBe(false);
    });

    it('still admits a legacy row that carries no run id at all', () => {
        // Rows written before the revisioned engine have no timerRunId; refusing them would strand
        // exactly the runs most likely to need recovering.
        expect(canRecoverConfirmedRun(freshTask({ timerRunId: undefined }), 'run-1')).toBe(true);
        expect(canRecoverConfirmedRun(freshTask({ timerRunId: '' }), 'run-1')).toBe(true);
    });

    it('refuses a run anchored by ANOTHER DEVICE — this is the timer-stopping incident', () => {
        expect(canRecoverConfirmedRun(freshTask({ timerOwnerInstance: OTHER_DEVICE }), 'run-1')).toBe(false);
    });

    it('admits a run this DEVICE anchored in an EARLIER boot — that is precisely an orphan', () => {
        // Ownership for the heartbeat matches the whole {device}::{boot} string; recovery matches
        // only the device segment, or a reload could never recover its own abandoned run.
        expect(canRecoverConfirmedRun(freshTask({ timerOwnerInstance: SAME_DEVICE_EARLIER_BOOT }), 'run-1')).toBe(true);
    });

    it('refuses an unstamped run — fail closed rather than guess it is ours', () => {
        expect(canRecoverConfirmedRun(freshTask({ timerOwnerInstance: undefined }), 'run-1')).toBe(false);
        expect(canRecoverConfirmedRun(freshTask({ timerOwnerInstance: '' }), 'run-1')).toBe(false);
    });

    it('refuses a document that could not be read — a missing doc proves nothing', () => {
        expect(canRecoverConfirmedRun(null, 'run-1')).toBe(false);
        expect(canRecoverConfirmedRun(undefined, 'run-1')).toBe(false);
    });
});
