import { describe, it, expect, vi, beforeEach } from 'vitest';

// The review shelf ("Peržiūrai") is a pointer list on the manager's own users doc, and
// "Grąžinti papildyti" is a three-write sequence whose ORDER is the contract: reopen first (the
// only write the rest depends on), then the note as a comment WITHOUT its own ping, then ONE
// task_reverted notice carrying the note.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}` })),
    updateDoc: vi.fn(() => Promise.resolve()),
    setDoc: vi.fn(() => Promise.resolve()),
    deleteDoc: vi.fn(() => Promise.resolve()),
    arrayUnion: vi.fn((...items) => ({ __arrayUnion: items })),
    arrayRemove: vi.fn((...items) => ({ __arrayRemove: items })),
}));

const calls = [];
vi.mock('./taskActions', () => ({ revertTask: vi.fn(async () => { calls.push('revert'); }) }));
vi.mock('./commentActions', () => ({ addComment: vi.fn(async () => { calls.push('comment'); }) }));
vi.mock('./notify', () => ({ notify: vi.fn(async () => { calls.push('notify'); }) }));
vi.mock('../components/TaskHistory', () => ({
    buildRestoredTaskPayload: vi.fn((task) => ({ ...task, status: 'in-progress', archivedAt: null })),
}));

import { updateDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { revertTask } from './taskActions';
import { addComment } from './commentActions';
import { notify } from './notify';
import { getShelfIds, setOnReviewShelf, returnTaskForAddition } from './reviewShelf';

const manager = { uid: 'zivile', displayName: 'Živilė' };
const liveTask = { id: 't1', title: 'Sąmata', status: 'completed', assignedUserId: 'vika' };

beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
});

describe('getShelfIds', () => {
    it('returns only non-empty string ids, and [] for a doc without a shelf', () => {
        expect(getShelfIds({ reviewShelf: ['a', '', null, 'b', 3] })).toEqual(['a', 'b']);
        expect(getShelfIds({})).toEqual([]);
        expect(getShelfIds(null)).toEqual([]);
    });
});

describe('setOnReviewShelf', () => {
    it('adds with arrayUnion and removes with arrayRemove on the caller’s own doc — never a whole-array write', async () => {
        await setOnReviewShelf('zivile', 't1', true);
        await setOnReviewShelf('zivile', 't1', false);
        expect(updateDoc.mock.calls[0][0]._path).toBe('users/zivile');
        expect(updateDoc.mock.calls[0][1].reviewShelf).toEqual({ __arrayUnion: ['t1'] });
        expect(updateDoc.mock.calls[1][1].reviewShelf).toEqual({ __arrayRemove: ['t1'] });
    });

    it('refuses a missing uid or task id', async () => {
        await expect(setOnReviewShelf('', 't1', true)).rejects.toThrow();
        await expect(setOnReviewShelf('zivile', '', true)).rejects.toThrow();
        expect(updateDoc).not.toHaveBeenCalled();
    });
});

describe('returnTaskForAddition', () => {
    it('reopens, then comments without its own ping, then sends ONE task_reverted carrying the note', async () => {
        const res = await returnTaskForAddition({ task: liveTask, text: '  Trūksta nuorodos  ', user: manager });

        expect(res).toEqual({ ok: true, partial: false });
        expect(calls).toEqual(['revert', 'comment', 'notify']);
        expect(revertTask).toHaveBeenCalledWith(liveTask, manager);
        expect(addComment).toHaveBeenCalledWith('t1', 'Trūksta nuorodos', manager, null, 'tasks', { notify: false });
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({
            recipientId: 'vika', type: 'task_reverted', taskId: 't1', commentText: 'Trūksta nuorodos', actorUid: 'zivile',
        }));
        expect(notify.mock.calls[0][0].edited).toBeUndefined();
    });

    it('restores an ARCHIVED task onto the active board instead of reopening in place', async () => {
        const archived = { ...liveTask, status: 'confirmed', archivedAt: '2026-09-28T02:30:00Z', isArchived: true };
        await returnTaskForAddition({ task: archived, text: 'Papildykite', user: manager });

        expect(revertTask).not.toHaveBeenCalled();
        expect(setDoc.mock.calls[0][0]._path).toBe('tasks/t1');
        const written = setDoc.mock.calls[0][1];
        expect(written).not.toHaveProperty('id');
        expect(written).not.toHaveProperty('isArchived');
        expect(written.status).toBe('in-progress');
        expect(deleteDoc.mock.calls[0][0]._path).toBe('archived_tasks/t1');
        // The comment lands on the RESTORED task, in /tasks.
        expect(addComment.mock.calls[0][4]).toBe('tasks');
    });

    it('attempts nothing else when the reopen fails', async () => {
        revertTask.mockRejectedValueOnce(new Error('permission-denied'));
        await expect(returnTaskForAddition({ task: liveTask, text: 'x', user: manager })).rejects.toThrow();
        expect(addComment).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('reports partial when only the note failed, and still notifies', async () => {
        addComment.mockRejectedValueOnce(new Error('offline'));
        const res = await returnTaskForAddition({ task: liveTask, text: 'x', user: manager });
        expect(res).toEqual({ ok: true, partial: true });
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('requires a note', async () => {
        await expect(returnTaskForAddition({ task: liveTask, text: '   ', user: manager })).rejects.toThrow();
        expect(revertTask).not.toHaveBeenCalled();
    });
});
