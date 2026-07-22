import { describe, it, expect, vi, beforeEach } from 'vitest';

// endSessionForUser is the manager-side "settle a stuck worker" teardown the live-oversight
// panel (ActiveWorkSessions) calls. It has three branches worth pinning:
//   1. no user.id            -> pure no-op (guards against a half-loaded roster row)
//   2. id but no running task -> clears the live-session ghost flags, never calls pauseTask
//   3. id + a RUNNING task    -> settles the task via pauseTask, THEN clears the ghost flags
//
// Mocking mirrors the established util-test convention (taskActions / sessionEditActions):
// neutralise the firebase module graph, run Firestore writes against in-memory fakes so we can
// inspect the exact payloads, mock errorLog to assert nothing leaks, and — crucially — mock
// pauseTask itself. We are testing endSessionForUser's ORCHESTRATION (does it settle a task and
// issue the clear?), not re-testing pauseTask's credit math, which taskActions.test.js owns.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
    updateDoc: vi.fn(() => Promise.resolve()),
    getDoc: vi.fn(() => Promise.resolve({ exists: () => false, data: () => ({}) })),
    // The target user is re-read SERVER-FIRST before anything is settled (the confirm dialog can
    // sit open for minutes while the worker's real session moves on).
    getDocFromServer: vi.fn(() => Promise.resolve({ exists: () => false, data: () => ({}) })),
}));

vi.mock('./taskActions', () => ({ pauseTask: vi.fn(() => Promise.resolve()) }));
vi.mock('./errorLog', () => ({ logError: vi.fn() }));
vi.mock('./timerTransitionExecutor', () => ({
    applyTimerTransitionPlan: vi.fn(() => Promise.resolve()),
}));

import { doc, updateDoc, getDoc, getDocFromServer } from 'firebase/firestore';
import { pauseTask } from './taskActions';
import { logError } from './errorLog';
import { applyTimerTransitionPlan } from './timerTransitionExecutor';
import { endSessionForUser } from './sessionAdmin';

// The clear-write payload aimed at a specific user doc, across all mock calls.
const userClearFor = (id) =>
    updateDoc.mock.calls.find(([ref]) => ref?._path === `users/${id}`)?.[1];

// Make getDoc resolve to a specific task body (the running-task branch reads tasks/<id>).
const taskSnap = (data) => ({ exists: () => true, id: data.id, data: () => data });
const missingSnap = () => ({ exists: () => false, data: () => ({}) });

beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes call history but not implementations; re-arm the resolving defaults.
    updateDoc.mockResolvedValue(undefined);
    pauseTask.mockResolvedValue(undefined);
    applyTimerTransitionPlan.mockResolvedValue(undefined);
    getDoc.mockResolvedValue(missingSnap());
    // Default: the server has nothing newer than the caller's snapshot, so every pre-existing
    // expectation below keeps describing the same behaviour.
    getDocFromServer.mockResolvedValue(missingSnap());
});

describe('endSessionForUser', () => {
    it('is a pure no-op when the user has no id (nothing read, nothing written)', async () => {
        await endSessionForUser({ activeSession: { taskId: 't1' } });
        expect(getDoc).not.toHaveBeenCalled();
        expect(pauseTask).not.toHaveBeenCalled();
        expect(updateDoc).not.toHaveBeenCalled();
        expect(logError).not.toHaveBeenCalled();
    });

    it('clears the ghost flags but never settles a task when nothing is running', async () => {
        // No activeSession.taskId and no workStatus.activeTaskId -> the task branch is skipped
        // entirely, so getDoc/pauseTask are never reached, but the clear still fires.
        await endSessionForUser({ id: 'u1' });

        expect(getDoc).toHaveBeenCalledTimes(1);
        expect(getDoc.mock.calls[0][0]?._path).toBe('active_sessions/u1');
        expect(pauseTask).not.toHaveBeenCalled();

        const clear = userClearFor('u1');
        expect(clear).toBeDefined();
        expect(clear.activeSession).toBeNull();
        expect(clear['workStatus.isWorking']).toBe(false);
        expect(clear['workStatus.status']).toBe('idle');
        expect(clear['workStatus.activeTaskId']).toBeNull();
        expect(doc).toHaveBeenCalledWith(expect.anything(), 'users', 'u1');
        expect(logError).not.toHaveBeenCalled();
    });

    it('settles the running task via pauseTask AND issues the activeSession:null + workStatus clear', async () => {
        const task = { id: 't1', title: 'Roof repair', timerStatus: 'running' };
        getDoc.mockImplementation((ref) => {
            if (ref?._path === 'active_sessions/u1') return Promise.resolve(missingSnap());
            if (ref?._path === 'tasks/t1') return Promise.resolve(taskSnap(task));
            return Promise.resolve(missingSnap());
        });

        await endSessionForUser({ id: 'u1', activeSession: { taskId: 't1' } });

        // The task was read and settled (pauseTask logs the open segment + clears the owner).
        expect(getDoc).toHaveBeenCalledTimes(2);
        expect(pauseTask).toHaveBeenCalledTimes(1);
        expect(pauseTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', timerStatus: 'running' }));

        // ...and the idempotent ghost-flag clear is still issued on the user doc.
        const clear = userClearFor('u1');
        expect(clear).toBeDefined();
        expect(clear.activeSession).toBeNull();
        expect(clear['workStatus.status']).toBe('idle');
        expect(clear['workStatus.activeTaskId']).toBeNull();
        expect(clear['breakState.isTakingBreak']).toBe(false);
        expect(clear['callState.isCalling']).toBe(false);
        expect(clear['quickWorkState.isQuickWorking']).toBe(false);
        expect(logError).not.toHaveBeenCalled();
    });

    it('does NOT settle a task that is no longer running, but still clears the ghost flags', async () => {
        // A lingering activeTaskId whose task already paused: read it, see it is not running,
        // skip pauseTask, and fall through to the clear (the orphan-flag recovery case).
        getDoc.mockImplementation((ref) => {
            if (ref?._path === 'active_sessions/u1') return Promise.resolve(missingSnap());
            if (ref?._path === 'tasks/t1') return Promise.resolve(taskSnap({ id: 't1', timerStatus: 'paused' }));
            return Promise.resolve(missingSnap());
        });

        await endSessionForUser({ id: 'u1', workStatus: { activeTaskId: 't1' } });

        expect(getDoc).toHaveBeenCalledTimes(2);
        expect(pauseTask).not.toHaveBeenCalled();
        expect(userClearFor('u1')).toBeDefined();
    });

    it('settles the LIVE task, not the one frozen in the manager’s dialog snapshot', async () => {
        // The oversight panel captures the user doc when the manager taps the icon; the confirm
        // dialog can sit open for minutes. Here the worker reopens the app meanwhile, ends the
        // stuck break (whose paused task t1 is already 'paused') and starts task t2. Acting on the
        // stale snapshot resolved t1, skipped pauseTask, and then blind-cleared the user doc —
        // leaving t2 running with nothing pointing at it, so its next pause credited the whole
        // stretch. The server re-read must make this settle t2 instead.
        getDocFromServer.mockResolvedValue({
            exists: () => true,
            data: () => ({ activeSession: { type: 'task', taskId: 't2' }, workStatus: { activeTaskId: 't2' } }),
        });
        getDoc.mockImplementation((ref) => {
            if (ref?._path === 'active_sessions/u1') return Promise.resolve(missingSnap());
            if (ref?._path === 'tasks/t1') return Promise.resolve(taskSnap({ id: 't1', timerStatus: 'paused' }));
            if (ref?._path === 'tasks/t2') return Promise.resolve(taskSnap({ id: 't2', timerStatus: 'running' }));
            return Promise.resolve(missingSnap());
        });

        await endSessionForUser({ id: 'u1', activeSession: { type: 'break', taskId: 't1' } });

        expect(getDocFromServer).toHaveBeenCalledWith(expect.objectContaining({ _path: 'users/u1' }));
        expect(pauseTask).toHaveBeenCalledTimes(1);
        expect(pauseTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't2', timerStatus: 'running' }));
        expect(userClearFor('u1')).toBeDefined();
    });

    it('falls back to the caller’s copy when the server re-read fails', async () => {
        // A manager on a flaky connection must still be able to settle a genuinely stuck worker.
        getDocFromServer.mockRejectedValue(new Error('unavailable'));
        getDoc.mockImplementation((ref) => {
            if (ref?._path === 'active_sessions/u1') return Promise.resolve(missingSnap());
            if (ref?._path === 'tasks/t1') return Promise.resolve(taskSnap({ id: 't1', timerStatus: 'running' }));
            return Promise.resolve(missingSnap());
        });

        await endSessionForUser({ id: 'u1', activeSession: { type: 'task', taskId: 't1' } });

        expect(pauseTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
        expect(userClearFor('u1')).toBeDefined();
    });

    it('settles a canonical running task through one revisioned manager batch', async () => {
        const task = {
            id: 't1',
            title: 'Roof repair',
            timerStatus: 'running',
            timerStartedAt: '2026-07-09T08:00:00.000Z',
            timerMinutes: 2,
        };
        getDoc.mockImplementation((ref) => {
            if (ref?._path === 'active_sessions/u1') {
                return Promise.resolve({
                    exists: () => true,
                    data: () => ({
                        userId: 'u1',
                        revision: 4,
                        status: 'active',
                        run: {
                            runId: 'run-force',
                            type: 'task',
                            taskId: 't1',
                            taskTitle: 'Roof repair',
                            startedAt: '2026-07-09T08:00:00.000Z',
                            revision: 4,
                        },
                    }),
                });
            }
            if (ref?._path === 'tasks/t1') return Promise.resolve(taskSnap(task));
            return Promise.resolve(missingSnap());
        });

        const result = await endSessionForUser({
            id: 'u1',
            displayName: 'Worker A',
            activeSession: { type: 'task', taskId: 't1' },
        }, { actorId: 'manager-a' });

        expect(result.status).toBe('canonical-ended');
        expect(pauseTask).not.toHaveBeenCalled();
        expect(updateDoc).not.toHaveBeenCalled();
        expect(applyTimerTransitionPlan).toHaveBeenCalledTimes(1);
        const plan = applyTimerTransitionPlan.mock.calls[0][1];
        expect(plan.command).toMatchObject({
            kind: 'force-end-session',
            userId: 'u1',
            actorId: 'manager-a',
            expectedRevision: 4,
            expectedRunId: 'run-force',
        });
        expect(plan.writes.find((write) => write.path === 'work_sessions/sess_run_run-force').data)
            .toMatchObject({ runId: 'run-force' });
        expect(plan.writes.find((write) => write.path === 'active_sessions/u1').data)
            .toMatchObject({ status: 'idle', revision: 5 });
    });
});
