import { describe, it, expect, vi } from 'vitest';

// useTaskTimeMonitor pulls in Firebase-touching modules (taskActions → firebase, AuthContext →
// firebase auth) purely as import side effects. Mocked away so only the pure decision function
// under test — isPreBootOrphanTask — is exercised, mirroring useOrphanedTaskRecovery.test.js.
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

import { isPreBootOrphanTask, latestTaskForLimitAction } from './useTaskTimeMonitor';

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
