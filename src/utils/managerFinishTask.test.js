import { describe, it, expect, vi, beforeEach } from 'vitest';

// finishTaskForAssignee is the koordinatorius's "close a Meistras's task for them" door. What is
// worth pinning here is its ORCHESTRATION, not the credit math or the status rule (taskActions /
// completeTask own those). Three things must hold, because each one silently loses real work when
// it does not:
//   1. a live run that points at THIS task is SETTLED before the completion write,
//   2. a live run pointing at something else is NEVER force-ended,
//   3. an orphaned running timer (task says running, no session) still gets its open stretch paused,
// plus: a failed settle must ABORT (never complete on top of uncredited time), and the auto-confirm
// denial must fall back to a plain 'completed' instead of leaving the task open.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
    getDoc: vi.fn(() => Promise.resolve({ exists: () => false, data: () => ({}) })),
    updateDoc: vi.fn(() => Promise.resolve()),
}));

vi.mock('./sessionAdmin', () => ({ endSessionForUser: vi.fn(() => Promise.resolve({ status: 'canonical-ended' })) }));
vi.mock('./taskActions', () => ({ pauseTask: vi.fn(() => Promise.resolve()) }));
vi.mock('./errorLog', () => ({ logError: vi.fn() }));
vi.mock('./notify', () => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock('../domain', () => ({
    completeTask: vi.fn(() => Promise.resolve({ effect: { after: { status: 'confirmed' } } })),
    humanActor: vi.fn((u) => ({ id: u.uid, role: u.role, kind: 'human' })),
    MODES: { COMMIT: 'commit' },
}));

import { getDoc, updateDoc } from 'firebase/firestore';
import { endSessionForUser } from './sessionAdmin';
import { pauseTask } from './taskActions';
import { notify } from './notify';
import { completeTask } from '../domain';
import { finishTaskForAssignee } from './managerFinishTask';

const KOORD = { uid: 'mgr', displayName: 'Koordinatorius', email: 'k@x.lt' };
const TASK = { id: 't1', title: 'Veikla', assignedUserId: 'w1', assignedUserName: 'Meistras', timerMinutes: 30 };

const missing = { exists: () => false, data: () => ({}) };
const snapOf = (path, data) => ({ exists: () => true, id: path, data: () => data });

// Route each collection read to its own fixture, so a test states only what it cares about.
const readsWith = ({ active = null, user = null, task = null } = {}) => {
    getDoc.mockImplementation((ref) => {
        if (ref._col === 'active_sessions') return Promise.resolve(active ? snapOf(ref._id, active) : missing);
        if (ref._col === 'users') return Promise.resolve(user ? snapOf(ref._id, user) : missing);
        if (ref._col === 'tasks') return Promise.resolve(task ? snapOf(ref._id, task) : missing);
        return Promise.resolve(missing);
    });
};

beforeEach(() => {
    vi.clearAllMocks();
    updateDoc.mockResolvedValue(undefined);
    endSessionForUser.mockResolvedValue({ status: 'canonical-ended' });
    pauseTask.mockResolvedValue(undefined);
    notify.mockResolvedValue(undefined);
    completeTask.mockResolvedValue({ effect: { after: { status: 'confirmed' } } });
    readsWith({});
});

describe('finishTaskForAssignee', () => {
    it('settles the canonical run pointing at THIS task before completing it', async () => {
        readsWith({ active: { status: 'active', run: { type: 'task', taskId: 't1' } } });
        const result = await finishTaskForAssignee(TASK, { currentUser: KOORD, userRole: 'manager' });

        expect(endSessionForUser).toHaveBeenCalledWith({ id: 'w1' }, { actorId: 'mgr' });
        expect(pauseTask).not.toHaveBeenCalled();
        expect(completeTask).toHaveBeenCalled();
        expect(result.status).toBe('confirmed');
    });

    it('never force-ends a run that belongs to a DIFFERENT task', async () => {
        readsWith({
            active: { status: 'active', run: { type: 'task', taskId: 'other' } },
            user: { activeSession: { taskId: 'other' } },
        });
        await finishTaskForAssignee(TASK, { currentUser: KOORD, userRole: 'manager' });

        expect(endSessionForUser).not.toHaveBeenCalled();
        // ...and with no live run on this task and no running timer, there is nothing to pause either.
        expect(pauseTask).not.toHaveBeenCalled();
        expect(completeTask).toHaveBeenCalled();
    });

    it('pauses an ORPHANED running timer so its open stretch is still credited', async () => {
        await finishTaskForAssignee({ ...TASK, timerStatus: 'running' }, { currentUser: KOORD, userRole: 'manager' });
        expect(endSessionForUser).not.toHaveBeenCalled();
        expect(pauseTask).toHaveBeenCalledTimes(1);
    });

    it('ABORTS on a failed settle rather than completing on top of uncredited time', async () => {
        readsWith({ active: { status: 'active', run: { type: 'task', taskId: 't1' } } });
        endSessionForUser.mockRejectedValue(new Error('offline'));

        await expect(finishTaskForAssignee(TASK, { currentUser: KOORD, userRole: 'manager' }))
            .rejects.toThrow('offline');
        expect(completeTask).not.toHaveBeenCalled();
    });

    it('derives actualTime from the RE-READ task, not the caller\'s stale snapshot', async () => {
        // The settle just credited 45 more minutes; the caller's copy still says 30.
        readsWith({ task: { id: 't1', timerMinutes: 75, manualMinutes: 15 } });
        await finishTaskForAssignee(TASK, { currentUser: KOORD, userRole: 'manager' });

        const written = updateDoc.mock.calls.find(([ref]) => ref._path === 'tasks/t1')?.[1];
        expect(written.actualTime).toBe('1h 30m');
        expect(written.timeLimitReached).toBe(false);
    });

    it('falls back to a plain completion when the rules deny the auto-confirm flip', async () => {
        completeTask
            .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'permission-denied' }))
            .mockResolvedValueOnce({ effect: { after: { status: 'completed' } } });

        const result = await finishTaskForAssignee({ ...TASK, managerId: 'other-mgr' }, { currentUser: KOORD, userRole: 'manager' });

        expect(result.status).toBe('completed');
        // The retry drops only the ROLE the status rule reads — the actor is still the real caller.
        expect(completeTask.mock.calls[1][1].actor).toMatchObject({ id: 'mgr', role: null });
        // ...and the task now awaits a real priėmimas, so its proper overseer is told.
        expect(notify.mock.calls.some(([n]) => n.recipientId === 'other-mgr' && n.type === 'task_completion')).toBe(true);
    });

    it('tells the Meistras their task was closed for them', async () => {
        await finishTaskForAssignee(TASK, { currentUser: KOORD, userRole: 'manager' });
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({
            recipientId: 'w1', type: 'task_confirmed', taskId: 't1', actorUid: 'mgr',
        }));
    });

    it('refuses a task with no assignee', async () => {
        await expect(finishTaskForAssignee({ id: 't1' }, { currentUser: KOORD, userRole: 'manager' }))
            .rejects.toThrow(/assigned task/);
    });
});
