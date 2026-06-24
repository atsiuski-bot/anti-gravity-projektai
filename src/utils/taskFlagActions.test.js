import { describe, it, expect, vi, beforeEach } from 'vitest';

// Neutralise the firebase module graph and run the write against an in-memory updateDoc fake so we
// can inspect the exact payload; spy on notify() to assert the manager-ping routing (mirrors the
// taskActions / sessionEditActions test convention).
vi.mock('../firebase', () => ({ db: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
    updateDoc: vi.fn(() => Promise.resolve()),
}));

vi.mock('./notify', () => ({ notify: vi.fn(() => Promise.resolve()) }));

import { updateDoc } from 'firebase/firestore';
import { notify } from './notify';
import { setTaskFlag } from './taskFlagActions';

const worker = { uid: 'w1', displayName: 'Darius' };

beforeEach(() => {
    vi.clearAllMocks();
    updateDoc.mockResolvedValue(undefined);
    notify.mockResolvedValue(undefined);
});

describe('setTaskFlag — raising a flag', () => {
    it('writes the flag with a who/when stamp and bumps updatedAt', async () => {
        const task = { id: 't1', title: 'Stogo remontas', managerId: 'm1' };
        await setTaskFlag(task, 'needsManager', true, worker, { defaultManagerId: 'def' });

        const [ref, payload] = updateDoc.mock.calls[0];
        expect(ref._path).toBe('tasks/t1');
        expect(payload.needsManager).toBe(true);
        expect(payload.needsManagerSetBy).toBe('w1');
        expect(payload.needsManagerSetByName).toBe('Darius');
        expect(typeof payload.needsManagerSetAt).toBe('string');
        expect(typeof payload.updatedAt).toBe('string');
    });

    it('pings the task manager, with the actor recorded as author', async () => {
        const task = { id: 't1', title: 'Stogo remontas', managerId: 'm1' };
        await setTaskFlag(task, 'needsManager', true, worker, { defaultManagerId: 'def' });

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({
            recipientId: 'm1',
            type: 'task_needs_manager',
            taskId: 't1',
            taskTitle: 'Stogo remontas',
            actorUid: 'w1',
            actorName: 'Darius',
        }));
    });

    it('falls back to the worker defaultManager when the task names no manager', async () => {
        const task = { id: 't2', title: 'X' };
        await setTaskFlag(task, 'waiting', true, worker, { defaultManagerId: 'def' });

        expect(notify).toHaveBeenCalledWith(expect.objectContaining({
            recipientId: 'def',
            type: 'task_waiting',
        }));
    });

    it('does not ping when the only resolvable recipient is the worker themselves', async () => {
        const task = { id: 't3', title: 'X', managerId: 'w1' };
        await setTaskFlag(task, 'needsManager', true, worker, { defaultManagerId: 'w1' });

        expect(updateDoc).toHaveBeenCalledTimes(1); // the flag still gets written
        expect(notify).not.toHaveBeenCalled();
    });
});

describe('setTaskFlag — clearing a flag', () => {
    it('clears the stamp and notifies no one', async () => {
        const task = { id: 't1', title: 'X', managerId: 'm1' };
        await setTaskFlag(task, 'needsManager', false, worker, { defaultManagerId: 'def' });

        const [, payload] = updateDoc.mock.calls[0];
        expect(payload.needsManager).toBe(false);
        expect(payload.needsManagerSetBy).toBeNull();
        expect(payload.needsManagerSetByName).toBeNull();
        expect(payload.needsManagerSetAt).toBeNull();
        expect(notify).not.toHaveBeenCalled();
    });
});

describe('setTaskFlag — guards', () => {
    it('no-ops on an unknown flag key', async () => {
        await setTaskFlag({ id: 't1', managerId: 'm1' }, 'bogus', true, worker, { defaultManagerId: 'def' });
        expect(updateDoc).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('no-ops without a signed-in actor', async () => {
        await setTaskFlag({ id: 't1', managerId: 'm1' }, 'waiting', true, null, { defaultManagerId: 'def' });
        expect(updateDoc).not.toHaveBeenCalled();
    });
});
