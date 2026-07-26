import { describe, it, expect, vi, beforeEach } from 'vitest';

// useTaskTimeMonitor pulls in Firebase-touching modules (taskActions → firebase, AuthContext →
// firebase auth) purely as import side effects. Mocked away so only the exported decision helpers
// are exercised, mirroring useOrphanedTaskRecovery.test.js. The suite has no DOM renderer, so the
// hook body itself is out of reach — which is why the effects that matter (the limit-popup
// retraction) are lifted OUT of the hook into a function that takes its collaborators as arguments.
vi.mock('../utils/taskActions', () => ({
    pauseTask: vi.fn(),
    requestTimeExtension: vi.fn(),
    completeTaskAtLimit: vi.fn(),
}));
vi.mock('../utils/soundUtils', () => ({
    SoundManager: {
        playTimeWarning70Sound: vi.fn(),
        startTimeLimitRepeat: vi.fn(),
        stopTimeLimitRepeat: vi.fn(),
    },
}));
vi.mock('../context/AuthContext', () => ({ useAuth: vi.fn(() => ({})) }));
vi.mock('./useRevisionedTimerSession', () => ({ useRevisionedTimerSession: vi.fn(() => ({ loaded: false })) }));
vi.mock('../utils/timerCommandEngine', () => ({ issueTimerCommand: vi.fn() }));
vi.mock('../utils/timerTransitionPlan', () => ({
    canonicalSessionState: vi.fn(),
    planTaskEnd: vi.fn(),
    planTaskPause: vi.fn(),
}));
vi.mock('../utils/errorLog', () => ({ logError: vi.fn() }));
vi.mock('../utils/notify', () => ({ notify: vi.fn() }));
// Fixed at 0 so the "uses the module default" case below is unambiguous against any positive ms.
vi.mock('./useOrphanedTaskRecovery', () => ({ APP_LOAD_TIME: 0 }));

import { SoundManager } from '../utils/soundUtils';
import {
    isPreBootOrphanTask,
    latestTaskForLimitAction,
    retractLimitPauseAnnouncement,
} from './useTaskTimeMonitor';

// Fixed reference instant so start offsets are exact.
const LOAD = new Date('2026-07-01T11:00:00.000Z').getTime();
const iso = (ms) => new Date(ms).toISOString();

// The bug this guards: useTaskTimeMonitor's immediate checkTime() runs before
// useOrphanedTaskRecovery's effect on the same mount (hook order in WorkerView.jsx). Without this
// guard, an orphaned running task that is ALSO over its estimate gets auto-paused by the monitor
// with NO endTime — crediting the entire dead offline gap up to MAX_SESSION_MINUTES as one
// ordinary session, with no "Nedirbau" opt-out, before recovery ever gets to make its
// heartbeat-aware decision. isPreBootOrphanTask is the exact same "started before this app load"
// test decideOrphanTaskRecovery uses, so the monitor can yield the whole task to recovery.
describe('isPreBootOrphanTask — which running tasks the time-limit monitor must yield to recovery', () => {
    it('is NOT a pre-boot orphan when the timer started during this app session', () => {
        expect(isPreBootOrphanTask({ timerStartedAt: iso(LOAD + 1000) }, LOAD)).toBe(false);
    });

    it('is NOT a pre-boot orphan at the exact boot instant (start === load)', () => {
        expect(isPreBootOrphanTask({ timerStartedAt: iso(LOAD) }, LOAD)).toBe(false);
    });

    it('IS a pre-boot orphan when the timer started before this app session', () => {
        expect(isPreBootOrphanTask({ timerStartedAt: iso(LOAD - 60 * 60 * 1000) }, LOAD)).toBe(true);
    });

    it('IS a pre-boot orphan for a multi-day-old dead timer — the over-limit case the fix targets', () => {
        expect(isPreBootOrphanTask({ timerStartedAt: iso(LOAD - 3 * 24 * 60 * 60 * 1000) }, LOAD)).toBe(true);
    });

    it('is NOT a pre-boot orphan when timerStartedAt is unparseable — falls through to normal handling', () => {
        expect(isPreBootOrphanTask({ timerStartedAt: 'not-a-date' }, LOAD)).toBe(false);
    });

    it('is NOT a pre-boot orphan when timerStartedAt is missing', () => {
        expect(isPreBootOrphanTask({}, LOAD)).toBe(false);
    });

    it('defaults appLoadTime to the shared APP_LOAD_TIME constant when omitted', () => {
        expect(isPreBootOrphanTask({ timerStartedAt: iso(1000) })).toBe(false);
    });
});

describe('latestTaskForLimitAction', () => {
    it('uses the fresh task snapshot when the limit popup holds an older running copy', () => {
        const popupTask = { id: 'task-a', timerStatus: 'running', timerMinutes: 10 };
        const freshTask = { id: 'task-a', timerStatus: 'paused', timerMinutes: 15 };

        expect(latestTaskForLimitAction([freshTask], popupTask)).toBe(freshTask);
    });

    it('falls back to the popup copy when the task list no longer contains the task', () => {
        const popupTask = { id: 'task-a', timerStatus: 'paused', timerMinutes: 15 };

        expect(latestTaskForLimitAction([], popupTask)).toBe(popupTask);
    });
});

// The 100% limit block issues a pause COMMAND and then immediately latches the run, opens the forced
// popup and starts the alarm — telling the worker the clock stopped. Under the revisioned engine
// that command can still settle as rejected or lose a multi-device race, in which case the timer is
// STILL RUNNING. The latch is keyed by an unchanged timerStartedAt, so it would match on every later
// tick and the 100% block would never fire again: the whole overrun then accrues silently behind a
// popup claiming it had stopped. Retracting is what lets the next 10 s tick retry the stop.
describe('retractLimitPauseAnnouncement — undoing a stop that never happened', () => {
    const TASK_ID = 'task-a';

    const announcement = (popupTaskId = TASK_ID) => {
        const limitReached = new Map([[TASK_ID, '2026-07-01T09:00:00.000Z']]);
        let popup = popupTaskId ? { task: { id: popupTaskId } } : null;
        return {
            ctx: {
                taskId: TASK_ID,
                limitReached,
                setLimitPopup: (updater) => { popup = updater(popup); },
            },
            limitReached,
            popup: () => popup,
        };
    };

    beforeEach(() => {
        SoundManager.stopTimeLimitRepeat.mockClear();
    });

    it('leaves everything alone when the stop was confirmed', () => {
        const a = announcement();
        expect(retractLimitPauseAnnouncement({ status: 'confirmed' }, a.ctx)).toBe(false);
        expect(a.limitReached.has(TASK_ID)).toBe(true);
        expect(a.popup()).not.toBeNull();
        expect(SoundManager.stopTimeLimitRepeat).not.toHaveBeenCalled();
    });

    it('leaves everything alone when the stop is QUEUED — offline is saved, not failed', () => {
        const a = announcement();
        expect(retractLimitPauseAnnouncement({ status: 'queued' }, a.ctx)).toBe(false);
        expect(a.limitReached.has(TASK_ID)).toBe(true);
        expect(a.popup()).not.toBeNull();
    });

    it('releases the latch, silences the alarm and closes the popup on a REJECTED stop', () => {
        const a = announcement();
        expect(retractLimitPauseAnnouncement({ status: 'rejected' }, a.ctx)).toBe(true);
        // The latch MUST be released, or the 100% block never re-fires for this running stretch.
        expect(a.limitReached.has(TASK_ID)).toBe(false);
        expect(a.popup()).toBeNull();
        expect(SoundManager.stopTimeLimitRepeat).toHaveBeenCalledTimes(1);
    });

    it('retracts on a CONFLICTED stop too — another device owns the state, ours did not apply', () => {
        const a = announcement();
        expect(retractLimitPauseAnnouncement({ status: 'conflicted' }, a.ctx)).toBe(true);
        expect(a.limitReached.has(TASK_ID)).toBe(false);
        expect(a.popup()).toBeNull();
    });

    it('retracts when the settlement itself threw and there is no outcome to read', () => {
        const a = announcement();
        expect(retractLimitPauseAnnouncement(null, a.ctx)).toBe(true);
        expect(a.limitReached.has(TASK_ID)).toBe(false);
        expect(a.popup()).toBeNull();
    });

    it('does not close a popup that belongs to a DIFFERENT task', () => {
        const a = announcement('task-b');
        expect(retractLimitPauseAnnouncement({ status: 'rejected' }, a.ctx)).toBe(true);
        expect(a.limitReached.has(TASK_ID)).toBe(false);
        expect(a.popup()).toEqual({ task: { id: 'task-b' } });
    });
});
