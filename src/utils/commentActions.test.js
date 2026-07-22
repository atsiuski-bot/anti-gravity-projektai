import { describe, it, expect, vi, beforeEach } from 'vitest';

// addComment is the manager↔worker thread on a task. Every call site hands it a `comments`
// array frozen when its view rendered (a modal opened minutes ago, a table row, a report row),
// so the ONE thing this file has to guarantee is that posting never rewrites that snapshot back
// over the server copy — a comment the other party posted meanwhile would vanish silently, after
// its recipient had already been notified about it.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
    updateDoc: vi.fn(() => Promise.resolve()),
    getDoc: vi.fn(() => Promise.resolve({ exists: () => false, data: () => ({}) })),
    // Sentinel stand-in for the real field transform, so the test can assert the write is an
    // APPEND rather than a whole-array assignment.
    arrayUnion: vi.fn((...items) => ({ __arrayUnion: items })),
}));

vi.mock('./notify', () => ({ notifyMany: vi.fn(() => Promise.resolve()) }));

import { updateDoc, getDoc } from 'firebase/firestore';
import { notifyMany } from './notify';
import { addComment } from './commentActions';

const comment = (id, text) => ({ id, text, user: 'X', userId: 'x', createdAt: `2026-06-23T10:0${id}:00.000Z` });

beforeEach(() => {
    vi.clearAllMocks();
    updateDoc.mockResolvedValue(undefined);
    notifyMany.mockResolvedValue(undefined);
});

describe('addComment', () => {
    it('appends with arrayUnion instead of writing the caller’s stale snapshot back', async () => {
        // The manager's modal froze the thread at two comments; the worker posted a third since.
        const c1 = comment('1', 'pirmas');
        const c2 = comment('2', 'antras');
        const c3 = comment('3', 'darbininko naujas');
        getDoc.mockResolvedValue({
            exists: () => true,
            data: () => ({ title: 'Stogas', managerId: 'm1', assignedUserId: 'w1', comments: [c1, c2, c3] }),
        });

        await addComment('t1', 'vadovo atsakymas', { uid: 'm1', displayName: 'Vadovas' }, [c1, c2]);

        const payload = updateDoc.mock.calls[0][1];
        // Never a whole-array rewrite — that is what deleted the worker's comment.
        expect(Array.isArray(payload.comments)).toBe(false);
        expect(payload.comments.__arrayUnion).toHaveLength(1);
        expect(payload.comments.__arrayUnion[0].text).toBe('vadovo atsakymas');
        expect(payload.comments.__arrayUnion[0].userId).toBe('m1');
        expect(payload.comments.__arrayUnion[0].id).toBeTruthy(); // stable identity for edit/delete
    });

    it('still notifies both parties off the freshly-read task', async () => {
        getDoc.mockResolvedValue({
            exists: () => true,
            data: () => ({ title: 'Stogas', managerId: 'm1', assignedUserId: 'w1', comments: [] }),
        });

        await addComment('t1', 'labas', { uid: 'w1', displayName: 'Meistras' }, []);

        expect(notifyMany).toHaveBeenCalledWith(
            ['m1', 'w1'],
            expect.objectContaining({ type: 'new_comment', taskId: 't1', actorUid: 'w1' })
        );
    });

    it('still writes when the task read comes back missing (the write never depended on it)', async () => {
        getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) });

        await addComment('t1', 'labas', { uid: 'w1', displayName: 'Meistras' }, null);

        expect(updateDoc.mock.calls[0][1].comments.__arrayUnion[0].text).toBe('labas');
        expect(notifyMany).not.toHaveBeenCalled(); // no task data -> nobody to address
    });
});
