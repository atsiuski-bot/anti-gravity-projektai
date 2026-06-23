import { describe, it, expect, vi, beforeEach } from 'vitest';

// These guard the STATEFUL time-credit paths the pure-utils suite never touched: the
// pause credit-math (now - timerStartedAt), its clamping, and the invariant that a paused
// task clears timerStartedAt so the NEXT pause cannot re-credit the same interval. A
// silent regression here is a "ghost time" payroll corruption (full-sweep finding #8).
//
// Mocking mirrors the established convention (sessionEditActions / automationUtils tests):
// neutralise the firebase module graph, run the WRITES against in-memory Firestore fakes so
// we can inspect the exact payloads, mock errorLog to assert the durable-log calls, and keep
// timeUtils REAL except getLithuanianNow — so the genuine clampSessionMinutes /
// MIN_LOGGED_SESSION_MINUTES / getLithuanianDateString run while "now" stays injectable.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
    collection: vi.fn((_db, name) => ({ _col: name })),
    updateDoc: vi.fn(() => Promise.resolve()),
    addDoc: vi.fn(() => Promise.resolve({ id: 'generated-id' })),
    setDoc: vi.fn(() => Promise.resolve()),
    deleteDoc: vi.fn(() => Promise.resolve()),
    getDoc: vi.fn(() => Promise.resolve({ exists: () => false, data: () => ({}) })),
    getDocs: vi.fn(() => Promise.resolve({ docs: [] })),
    query: vi.fn((...args) => args),
    where: vi.fn(() => 'where-clause'),
    orderBy: vi.fn(() => 'order-clause'),
}));

vi.mock('./errorLog', () => ({ logError: vi.fn() }));

vi.mock('./timeUtils', async (importActual) => ({
    ...(await importActual()),
    getLithuanianNow: vi.fn(),
}));

import { updateDoc, addDoc, getDocs } from 'firebase/firestore';
import { logError } from './errorLog';
import { getLithuanianNow } from './timeUtils';
import { MAX_SESSION_MINUTES } from './timeUtils';
import { startTask, pauseTask, resumeTask } from './taskActions';

// Fixed "now" so the credit math (now - timerStartedAt) is exact. June -> Vilnius is a
// stable UTC+3, so the session date buckets to 2026-06-23 with no DST ambiguity.
const NOW = new Date('2026-06-23T12:00:00.000Z');

// Find the write payload for a specific Firestore doc / collection across all mock calls.
const taskUpdateFor = (id) => updateDoc.mock.calls.find(([ref]) => ref?._path === `tasks/${id}`)?.[1];
const userUpdatesFor = (id) => updateDoc.mock.calls.filter(([ref]) => ref?._path === `users/${id}`).map((c) => c[1]);
const workSessionWrites = () => addDoc.mock.calls.filter(([col]) => col?._col === 'work_sessions').map((c) => c[1]);

beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes call history but NOT implementations, so re-arm the resolving
    // defaults — otherwise a mockRejectedValue from a failure test leaks into the next one.
    updateDoc.mockResolvedValue(undefined);
    addDoc.mockResolvedValue({ id: 'generated-id' });
    getLithuanianNow.mockReturnValue(NOW);
    getDocs.mockResolvedValue({ docs: [] }); // pauseOtherTasks finds nothing to pause
});

describe('pauseTask — credit math (now - timerStartedAt)', () => {
    it('credits the elapsed interval onto timerMinutes and logs a matching work_session', async () => {
        const task = {
            id: 't1',
            title: 'Roof repair',
            timerStatus: 'running',
            timerStartedAt: '2026-06-23T11:00:00.000Z', // 60 min before NOW
            timerMinutes: 10,
            manualMinutes: 5,
            assignedUserId: 'u1',
            assignedUserName: 'Worker',
        };

        await pauseTask(task);

        const upd = taskUpdateFor('t1');
        expect(upd.timerStatus).toBe('paused');
        expect(upd.timerStartedAt).toBeNull(); // the double-credit guard
        expect(upd.timerMinutes).toBe(70); // 10 prior + 60 elapsed
        expect(upd.manualMinutes).toBe(5); // preserved, not recomputed

        const sessions = workSessionWrites();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].durationMinutes).toBe(60);
        expect(sessions[0].taskId).toBe('t1');
        expect(sessions[0].userId).toBe('u1');
        expect(sessions[0].startTime).toBe('2026-06-23T11:00:00.000Z');
        expect(sessions[0].endTime).toBe(NOW.toISOString());
        // Session is attributed to the Vilnius day it ENDED.
        expect(sessions[0].date).toBe('2026-06-23');
    });

    it('derives manualMinutes from actualTime when the field is absent (backwards compat)', async () => {
        // actualTime "1h 30m" = 90 total; timerMinutes 20 -> manual backfilled to 70.
        const task = {
            id: 't2',
            timerStatus: 'running',
            timerStartedAt: '2026-06-23T11:30:00.000Z', // 30 min
            timerMinutes: 20,
            actualTime: '1h 30m',
            assignedUserId: 'u1',
        };
        await pauseTask(task);
        const upd = taskUpdateFor('t2');
        expect(upd.manualMinutes).toBe(70); // max(0, 90 - 20)
        expect(upd.timerMinutes).toBe(50); // 20 + 30 elapsed
    });

    it('does NOT credit or log a sub-minute tap (below MIN_LOGGED_SESSION_MINUTES)', async () => {
        const task = {
            id: 't3',
            timerStatus: 'running',
            timerStartedAt: '2026-06-23T11:59:30.000Z', // 30 seconds -> 0.5 min
            timerMinutes: 12,
            assignedUserId: 'u1',
        };
        await pauseTask(task);
        const upd = taskUpdateFor('t3');
        expect(upd.timerMinutes).toBe(12); // unchanged — accidental tap discarded
        expect(upd.timerStartedAt).toBeNull();
        expect(workSessionWrites()).toHaveLength(0); // nothing persisted
    });

    it('clears the user activeSession on a normal (non-skip) pause', async () => {
        const task = {
            id: 't4', timerStatus: 'running', timerStartedAt: '2026-06-23T11:00:00.000Z',
            timerMinutes: 0, assignedUserId: 'u1',
        };
        await pauseTask(task);
        // One of the user writes nulls the activeSession so the UI stops showing "busy".
        expect(userUpdatesFor('u1').some((u) => u.activeSession === null)).toBe(true);
    });

    it('skips the user-status writes when skipUserStatusUpdate is set (pauseOtherTasks path)', async () => {
        const task = {
            id: 't5', timerStatus: 'running', timerStartedAt: '2026-06-23T11:00:00.000Z',
            timerMinutes: 0, assignedUserId: 'u1',
        };
        await pauseTask(task, { skipUserStatusUpdate: true });
        // Only the task doc is written; the user doc is left for startTask/resumeTask to set.
        expect(taskUpdateFor('t5')).toBeDefined();
        expect(userUpdatesFor('u1')).toHaveLength(0);
    });
});

describe('pauseTask — ghost-time guards (the payroll-corruption failure mode)', () => {
    it('is a no-op on an already-paused task (no timerStartedAt) — cannot double-credit', async () => {
        // This is the exact state pauseTask itself leaves behind. Feeding it back in must
        // not write anything: the interval was already credited and the clock was cleared.
        const paused = { id: 't1', timerStatus: 'paused', timerStartedAt: null, timerMinutes: 70 };
        await pauseTask(paused);
        expect(updateDoc).not.toHaveBeenCalled();
        expect(addDoc).not.toHaveBeenCalled();
    });

    it('is a no-op when timerStatus is not running even if timerStartedAt lingers', async () => {
        const stale = { id: 't1', timerStatus: 'paused', timerStartedAt: '2026-06-23T11:00:00.000Z' };
        await pauseTask(stale);
        expect(updateDoc).not.toHaveBeenCalled();
        expect(addDoc).not.toHaveBeenCalled();
    });

    it('caps an orphaned timer at the 16h ceiling instead of crediting the whole offline gap', async () => {
        // Crash/reload scenario (useOrphanedTaskRecovery): a task left running for 3 DAYS.
        // The clamp is what stops 4320 min of ghost time from reaching work_sessions.
        const orphan = {
            id: 'orphan1',
            timerStatus: 'running',
            timerStartedAt: '2026-06-20T12:00:00.000Z', // 72h before NOW
            timerMinutes: 0,
            assignedUserId: 'u1',
        };
        await pauseTask(orphan);

        const upd = taskUpdateFor('orphan1');
        expect(upd.timerMinutes).toBe(MAX_SESSION_MINUTES); // 960, not 4320
        const sessions = workSessionWrites();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].durationMinutes).toBe(MAX_SESSION_MINUTES);
    });

    it('credits nothing for a future timerStartedAt (device clock skew -> negative elapsed)', async () => {
        const skewed = {
            id: 'skew1',
            timerStatus: 'running',
            timerStartedAt: '2026-06-23T13:00:00.000Z', // 1h AFTER NOW
            timerMinutes: 25,
            assignedUserId: 'u1',
        };
        await pauseTask(skewed);
        const upd = taskUpdateFor('skew1');
        expect(upd.timerMinutes).toBe(25); // negative elapsed clamped to 0 -> unchanged
        expect(workSessionWrites()).toHaveLength(0);
    });
});

describe('pauseTask — recovery return contract (drives the RecoveryNotice banner)', () => {
    // useOrphanedTaskRecovery reads {creditedMinutes, wasCapped} off the resolved value to stamp
    // (or suppress) the one-time "timer recovered" banner. These lock that shape so a refactor
    // cannot silently make task recovery go dark.

    it('returns {wasCapped:false} with the exact credit for a clean, in-bounds pause', async () => {
        const task = {
            id: 'r1', timerStatus: 'running', timerStartedAt: '2026-06-23T11:00:00.000Z', // 60 min
            timerMinutes: 0, assignedUserId: 'u1',
        };

        const result = await pauseTask(task);

        expect(result).toMatchObject({ wasCapped: false });
        expect(result.creditedMinutes).toBe(60);
        expect(result.rawMinutes).toBeCloseTo(60, 5); // unclamped == clamped for an in-bounds run
    });

    it('returns {wasCapped:true, creditedMinutes:~960} for a >16h orphan (the 16h ceiling fired)', async () => {
        const orphan = {
            id: 'r2', timerStatus: 'running', timerStartedAt: '2026-06-20T12:00:00.000Z', // 72h
            timerMinutes: 0, assignedUserId: 'u1',
        };

        const result = await pauseTask(orphan);

        expect(result.wasCapped).toBe(true);
        expect(result.creditedMinutes).toBe(MAX_SESSION_MINUTES); // 960, the clamped credit
        expect(result.rawMinutes).toBeGreaterThan(MAX_SESSION_MINUTES); // raw 72h dwarfs the cap
    });

    it('returns null for a no-op pause (already paused) so the hook stamps nothing', async () => {
        const result = await pauseTask({ id: 'r3', timerStatus: 'paused', timerStartedAt: null });
        expect(result).toBeNull();
    });
});

describe('startTask / resumeTask — running-state writes', () => {
    it('startTask marks the task running with a fresh timerStartedAt and sets the user activeSession', async () => {
        await startTask({ id: 't1', title: 'Dig' }, 'u1');
        const upd = taskUpdateFor('t1');
        expect(upd.timerStatus).toBe('running');
        expect(upd.status).toBe('in-progress');
        expect(typeof upd.timerStartedAt).toBe('string');

        const userWrite = userUpdatesFor('u1')[0];
        expect(userWrite.workStatus.status).toBe('running');
        expect(userWrite.activeSession.type).toBe('task');
        expect(userWrite.activeSession.taskId).toBe('t1');
    });

    it('resumeTask re-arms the timer (running + new timerStartedAt)', async () => {
        await resumeTask({ id: 't9', title: 'Resume me' }, 'u1');
        const upd = taskUpdateFor('t9');
        expect(upd.timerStatus).toBe('running');
        expect(typeof upd.timerStartedAt).toBe('string');
    });
});

describe('crash-log coverage — failures reach the durable ring buffer (findings #4/#5)', () => {
    it('startTask logs to errorLog and rethrows when the write fails', async () => {
        updateDoc.mockRejectedValue(new Error('permission-denied'));
        await expect(startTask({ id: 't1' }, 'u1')).rejects.toThrow('permission-denied');
        expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'taskActions.startTask' });
    });

    it('resumeTask logs to errorLog and rethrows when the write fails', async () => {
        updateDoc.mockRejectedValue(new Error('network-error'));
        await expect(resumeTask({ id: 't1' }, 'u1')).rejects.toThrow('network-error');
        expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'taskActions.resumeTask' });
    });

    it('pauseTask logs the failure that CAUSES ghost time and rethrows', async () => {
        // A failed pause leaves the timer running with a stale start -> the next pause credits
        // the whole gap. Finding #5: that failure must be visible in the durable log, not only
        // the console. The work_sessions sub-write has its own catch; this asserts the critical
        // task-doc failure is logged.
        updateDoc.mockRejectedValue(new Error('offline'));
        const task = {
            id: 't1', timerStatus: 'running', timerStartedAt: '2026-06-23T11:00:00.000Z',
            timerMinutes: 0, assignedUserId: 'u1',
        };
        await expect(pauseTask(task)).rejects.toThrow('offline');
        expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'taskActions.pauseTask' });
    });
});
