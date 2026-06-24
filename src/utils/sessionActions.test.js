import { describe, it, expect, vi, beforeEach } from 'vitest';

// sessionActions owns the secondary-session (break / call / quick-work) lifecycle and the
// single-level pause/restore nesting. endSession turns a wall-clock delta into credited time
// AND folds it into breakState.dailyAccumulatedMinutes, so the clamp here protects both the
// permanent log and the running break total (full-sweep finding #8 + the orphan-session
// recovery path). pauseTask/resumeTask are mocked — this file owns the session math, not the
// task math (covered in taskActions.test.js). timeUtils stays REAL except getLithuanianNow.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
    collection: vi.fn((_db, name) => ({ _col: name })),
    updateDoc: vi.fn(() => Promise.resolve()),
    addDoc: vi.fn(() => Promise.resolve({ id: 'generated-id' })),
    setDoc: vi.fn(() => Promise.resolve()),
    getDoc: vi.fn(() => Promise.resolve({ exists: () => false, data: () => ({}) })),
    getDocs: vi.fn(() => Promise.resolve({ docs: [] })),
    query: vi.fn((...args) => args),
    where: vi.fn(() => 'where-clause'),
}));

vi.mock('./errorLog', () => ({ logError: vi.fn() }));

vi.mock('./taskActions', () => ({
    pauseTask: vi.fn(() => Promise.resolve()),
    resumeTask: vi.fn(() => Promise.resolve()),
}));

vi.mock('./timeUtils', async (importActual) => ({
    ...(await importActual()),
    getLithuanianNow: vi.fn(),
}));

import { updateDoc, addDoc, getDoc } from 'firebase/firestore';
import { logError } from './errorLog';
import { pauseTask, resumeTask } from './taskActions';
import { getLithuanianNow, MAX_SESSION_MINUTES } from './timeUtils';
import { startSession, endSession } from './sessionActions';

const NOW = new Date('2026-06-23T12:00:00.000Z');

// Fire-and-forget logging (doLogging / doResume) runs after the awaited critical path; yield a
// macrotask so those settle before asserting on the log writes.
const flush = () => new Promise((r) => setTimeout(r, 0));

const userUpdate = (id) => updateDoc.mock.calls.find(([ref]) => ref?._path === `users/${id}`)?.[1];
const addsTo = (col) => addDoc.mock.calls.filter(([c]) => c?._col === col).map((x) => x[1]);

beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes call history but NOT implementations, so re-arm the resolving
    // defaults — otherwise a mockRejectedValue from a failure test leaks into the next one.
    updateDoc.mockResolvedValue(undefined);
    addDoc.mockResolvedValue({ id: 'generated-id' });
    getLithuanianNow.mockReturnValue(NOW);
});

describe('startSession — opening a secondary session', () => {
    it('opens a break from idle with no nested session', async () => {
        getDoc.mockResolvedValue({ exists: () => true, data: () => ({ displayName: 'Worker' }) });

        await startSession('u1', 'break');

        const u = userUpdate('u1');
        expect(u.activeSession.type).toBe('break');
        expect(u.activeSession.pausedSession).toBeNull();
        expect(u.breakState.isTakingBreak).toBe(true);
        // Legacy active flags are cleared so timers rely on activeSession.
        expect(u['callState.isCalling']).toBe(false);
        expect(u['quickWorkState.isQuickWorking']).toBe(false);
    });

    it('nests the in-progress quick-work as pausedSession AND logs its pre-interruption segment', async () => {
        // First session = quick-work started 30 min ago; the break is the SECOND interruption.
        // The quick-work must nest (single level) and its 30 elapsed minutes must be banked now
        // as a partial work_session so they are not lost when it later resumes from "now".
        getDoc.mockResolvedValue({
            exists: () => true,
            data: () => ({
                displayName: 'Worker',
                activeSession: { type: 'quickWork', startTime: '2026-06-23T11:30:00.000Z', customTitle: 'Sorting' },
            }),
        });

        await startSession('u1', 'break');

        const u = userUpdate('u1');
        expect(u.activeSession.type).toBe('break');
        expect(u.activeSession.pausedSession.type).toBe('quickWork'); // single-level nesting
        expect(u.activeSession.pausedSession.partialDocId).toBe('generated-id');

        const partials = addsTo('work_sessions');
        expect(partials).toHaveLength(1);
        expect(partials[0].isPartial).toBe(true);
        expect(partials[0].isQuickWork).toBe(true);
        expect(partials[0].durationMinutes).toBe(30); // 11:30 -> 12:00
        expect(partials[0].taskTitle).toBe('Sorting');
    });

    it('preserves the prior nested session on a SECOND interruption (call during a break that paused a task)', async () => {
        // First interruption already happened: a break paused a task. Now a SECOND interruption
        // (a call) arrives. The break must nest under the call AND keep carrying the task it had
        // paused — the interruption stack is preserved one level at a time, not flattened.
        getDoc.mockResolvedValue({
            exists: () => true,
            data: () => ({
                activeSession: {
                    type: 'break',
                    startTime: '2026-06-23T11:00:00.000Z',
                    pausedSession: { type: 'task', taskId: 'tk1', taskTitle: 'Dig' },
                },
            }),
        });

        await startSession('u1', 'call');

        const u = userUpdate('u1');
        expect(u.activeSession.type).toBe('call');
        expect(u.activeSession.pausedSession.type).toBe('break'); // break nests under the call
        expect(u.activeSession.pausedSession.pausedSession.type).toBe('task'); // task still under the break
        expect(u.activeSession.pausedSession.pausedSession.taskId).toBe('tk1');
    });

    it('pauses an active TASK session and nests it (delegates to pauseTask, skipping the user-status write)', async () => {
        getDoc.mockImplementation((ref) => {
            if (ref?._path?.startsWith('users/')) {
                return Promise.resolve({
                    exists: () => true,
                    data: () => ({ activeSession: { type: 'task', taskId: 'tk1', taskTitle: 'Dig' } }),
                });
            }
            return Promise.resolve({ exists: () => true, id: ref._id, data: () => ({ timerStatus: 'running' }) });
        });

        await startSession('u1', 'call');
        await flush();

        expect(pauseTask).toHaveBeenCalledTimes(1);
        expect(pauseTask.mock.calls[0][1]).toEqual({ skipUserStatusUpdate: true });

        const u = userUpdate('u1');
        expect(u.activeSession.type).toBe('call');
        expect(u.activeSession.pausedSession.type).toBe('task'); // the task session is nested
    });

    it('logs durably and rethrows when the critical user write fails', async () => {
        getDoc.mockResolvedValue({ exists: () => true, data: () => ({}) });
        updateDoc.mockRejectedValue(new Error('permission-denied'));

        await expect(startSession('u1', 'break')).rejects.toThrow('permission-denied');
        expect(logError).toHaveBeenCalledWith(
            expect.any(Error),
            { source: 'startSession', userId: 'u1', sessionType: 'break' }
        );
    });
});

describe('endSession — credit math, clamping & the daily-break total', () => {
    it('credits a normal break and folds it into dailyAccumulatedMinutes', async () => {
        const userData = {
            displayName: 'Worker',
            activeSession: { type: 'break', startTime: '2026-06-23T11:00:00.000Z' }, // 60 min
            breakState: { dailyAccumulatedMinutes: 15 },
        };

        await endSession('u1', userData);
        await flush();

        const u = userUpdate('u1');
        expect(u.activeSession).toBeNull();
        expect(u['breakState.isTakingBreak']).toBe(false);
        expect(u['breakState.dailyAccumulatedMinutes']).toBe(75); // 15 + 60

        const breaks = addsTo('break_sessions');
        expect(breaks).toHaveLength(1);
        expect(breaks[0].durationMinutes).toBe(60);
        expect(breaks[0].date).toBe('2026-06-23');
    });

    it('caps an orphaned multi-day break at the 16h ceiling (the "190-day break" failure mode)', async () => {
        const userData = {
            activeSession: { type: 'break', startTime: '2026-06-20T12:00:00.000Z' }, // 72h
            breakState: { dailyAccumulatedMinutes: 0 },
        };

        await endSession('u1', userData);
        await flush();

        expect(userUpdate('u1')['breakState.dailyAccumulatedMinutes']).toBe(MAX_SESSION_MINUTES); // 960, not 4320
        expect(addsTo('break_sessions')[0].durationMinutes).toBe(MAX_SESSION_MINUTES);
    });

    it('credits nothing for a backward device clock (negative elapsed -> 0, no log)', async () => {
        const userData = {
            activeSession: { type: 'break', startTime: '2026-06-23T13:00:00.000Z' }, // 1h in the FUTURE
            breakState: { dailyAccumulatedMinutes: 40 },
        };

        await endSession('u1', userData);
        await flush();

        expect(userUpdate('u1')['breakState.dailyAccumulatedMinutes']).toBe(40); // + 0
        expect(addsTo('break_sessions')).toHaveLength(0); // sub-minute -> nothing persisted
    });

    it('swallows a failed critical write but records it durably (no rethrow)', async () => {
        updateDoc.mockRejectedValue(new Error('offline'));
        const userData = { activeSession: { type: 'break', startTime: '2026-06-23T11:00:00.000Z' }, breakState: {} };

        await expect(endSession('u1', userData)).resolves.toBeUndefined(); // does not throw
        expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'endSession', userId: 'u1' });
    });
});

describe('endSession — single-level nesting restore', () => {
    it('restores the nested quick-work (start reset to now) and does NOT resume a task', async () => {
        const userData = {
            activeSession: {
                type: 'break',
                startTime: '2026-06-23T11:00:00.000Z',
                pausedSession: { type: 'quickWork', startTime: '2026-06-23T10:00:00.000Z' },
            },
            breakState: { dailyAccumulatedMinutes: 0 },
            quickWorkState: { resumableTaskIds: ['tk1'] },
        };

        await endSession('u1', userData);
        await flush();

        const u = userUpdate('u1');
        expect(u.activeSession.type).toBe('quickWork'); // restored from pausedSession
        // The pre-interruption portion was already banked as a partial, so the restored session
        // starts fresh at "now" — never re-credited.
        expect(u.activeSession.startTime).toBe(NOW.toISOString());
        expect(u['quickWorkState.isQuickWorking']).toBe(true);
        // Restoring a SECONDARY session must not also resume the queued task.
        expect(resumeTask).not.toHaveBeenCalled();
    });
});

describe('endSession — orphan recovery path (useOrphanedSessionRecovery)', () => {
    it('ends an orphaned break with clamped credit and skips resume entirely (skipResume=true)', async () => {
        // This is the exact call the recovery hook makes on boot: endSession(uid, userData, {}, true).
        // A break left running across a crash must be closed with bounded credit and the worker
        // left idle — never resurrecting a queued task on launch.
        const userData = {
            activeSession: { type: 'break', startTime: '2026-06-20T12:00:00.000Z' }, // 72h orphan
            breakState: { dailyAccumulatedMinutes: 0, resumableTaskIds: ['tk1'] },
        };

        await endSession('u1', userData, {}, true);
        await flush();

        const u = userUpdate('u1');
        expect(u.activeSession).toBeNull(); // left idle
        expect(u['breakState.dailyAccumulatedMinutes']).toBe(MAX_SESSION_MINUTES); // clamped, not the offline gap
        expect(resumeTask).not.toHaveBeenCalled();
        expect(pauseTask).not.toHaveBeenCalled();
    });
});

describe('endSession — recovery return contract (drives the RecoveryNotice banner)', () => {
    // useOrphanedSessionRecovery reads {creditedMinutes, wasCapped} off the resolved value to
    // stamp (or suppress) the one-time "timer recovered" banner. These lock that shape so a
    // future refactor cannot silently make recovery go dark again.

    it('returns {wasCapped:false} with the exact credit for a clean, in-bounds session', async () => {
        const userData = {
            activeSession: { type: 'break', startTime: '2026-06-23T11:00:00.000Z' }, // 60 min, in-bounds
            breakState: { dailyAccumulatedMinutes: 0 },
        };

        const result = await endSession('u1', userData, {}, true);

        expect(result).toMatchObject({ type: 'break', wasCapped: false });
        expect(result.creditedMinutes).toBe(60);
        expect(result.rawMinutes).toBeCloseTo(60, 5); // unclamped == clamped for an in-bounds run
    });

    it('returns {wasCapped:true, creditedMinutes:~960} for a >16h orphan (the 16h ceiling fired)', async () => {
        const userData = {
            activeSession: { type: 'quickWork', startTime: '2026-06-20T12:00:00.000Z' }, // 72h orphan
            quickWorkState: {},
        };

        const result = await endSession('u1', userData, {}, true);

        expect(result.wasCapped).toBe(true);
        expect(result.creditedMinutes).toBe(MAX_SESSION_MINUTES); // 960, the clamped credit
        expect(result.rawMinutes).toBeGreaterThan(MAX_SESSION_MINUTES); // raw 72h dwarfs the cap
        expect(result.type).toBe('quickWork');
    });

    it('returns the SAME shape for a legacy-flag-only orphan (no activeSession) — the fixed gap', async () => {
        // The exact orphan the gap missed: held ONLY in breakState.isTakingBreak with NO
        // activeSession. endSession must route through endLegacySession AND propagate its
        // {creditedMinutes, rawMinutes, wasCapped} so the banner can show for these too —
        // previously this path returned undefined and recovery was silent.
        const userData = {
            breakState: { isTakingBreak: true, lastStartedAt: '2026-06-20T12:00:00.000Z', dailyAccumulatedMinutes: 0 }, // 72h
        };

        const result = await endSession('u1', userData, {}, true);
        await flush();

        // Shape is present and reports the clamp firing.
        expect(result).toMatchObject({ type: 'break', wasCapped: true });
        expect(result.creditedMinutes).toBe(MAX_SESSION_MINUTES); // 960, not the multi-day gap
        expect(result.rawMinutes).toBeGreaterThan(MAX_SESSION_MINUTES);
        // And the legacy flag was actually cleared + the clamped credit folded into the daily total.
        const u = userUpdate('u1');
        expect(u['breakState.isTakingBreak']).toBe(false);
        expect(u['breakState.dailyAccumulatedMinutes']).toBe(MAX_SESSION_MINUTES);
    });

    it('returns {wasCapped:false} with the exact credit for a clean legacy-flag-only call', async () => {
        const userData = {
            callState: { isCalling: true, lastStartedAt: '2026-06-23T11:30:00.000Z' }, // 30 min, in-bounds
        };

        const result = await endSession('u1', userData, {}, true);
        await flush();

        expect(result).toMatchObject({ type: 'call', wasCapped: false });
        expect(result.creditedMinutes).toBe(30);
        expect(result.rawMinutes).toBeCloseTo(30, 5);
    });
});
