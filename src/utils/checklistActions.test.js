import { describe, it, expect, vi, beforeEach } from 'vitest';

// A task's checklist is ONE array on the task document, and every per-item mutation rewrites the
// whole array. Worker (task card / detail sheet) and manager (TaskDetailModal) both tick items on
// the same task from their own snapshots, so the mutation has to be computed from the LIVE array,
// not the caller's — otherwise one side's tick (and its doneBy/doneAt attribution) is erased with
// no error on either device. These tests pin that, plus the offline fallback: a transaction needs
// a server round-trip and field workers tick items with no signal.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
    updateDoc: vi.fn(() => Promise.resolve()),
    runTransaction: vi.fn(),
}));

import { updateDoc, runTransaction } from 'firebase/firestore';
import { toggleChecklistItem, deleteChecklistItem, applyChecklistToggle } from './checklistActions';

const item = (id, done = false, doneBy = null) => ({
    id, text: `item ${id}`, done, doneBy, doneByName: doneBy, doneAt: done ? '2026-06-23T10:00:00.000Z' : null,
    createdAt: '2026-06-23T09:00:00.000Z',
});

// Run the transaction callback against a fixed "live" document and capture what it would write.
const withLiveDoc = (liveChecklist) => {
    const captured = {};
    runTransaction.mockImplementation(async (_db, fn) => fn({
        get: async () => ({ exists: () => true, data: () => ({ checklist: liveChecklist }) }),
        update: (_ref, data) => { captured.data = data; },
    }));
    return captured;
};

beforeEach(() => {
    vi.clearAllMocks();
    updateDoc.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('toggleChecklistItem', () => {
    it('flips only the tapped item against the LIVE array, preserving a concurrent tick', async () => {
        // The manager ticked C a second ago; the worker's phone still shows C unticked.
        const live = [item('a', true, 'w1'), item('b'), item('c', true, 'mgr')];
        const staleOnTheWorkersPhone = [item('a', true, 'w1'), item('b'), item('c')];
        const captured = withLiveDoc(live);

        await toggleChecklistItem('t1', 'b', { uid: 'w1', displayName: 'Meistras' }, staleOnTheWorkersPhone);

        const written = captured.data.checklist;
        expect(written.find((i) => i.id === 'b').done).toBe(true);      // the tap landed
        expect(written.find((i) => i.id === 'b').doneBy).toBe('w1');
        expect(written.find((i) => i.id === 'c').done).toBe(true);      // the manager's tick survived
        expect(written.find((i) => i.id === 'c').doneBy).toBe('mgr');
        expect(updateDoc).not.toHaveBeenCalled();                       // no snapshot rewrite
    });

    it('un-ticking clears the attribution', async () => {
        const captured = withLiveDoc([item('a', true, 'w1')]);

        await toggleChecklistItem('t1', 'a', { uid: 'w1', displayName: 'Meistras' }, [item('a', true, 'w1')]);

        expect(captured.data.checklist[0]).toMatchObject({ done: false, doneBy: null, doneByName: null, doneAt: null });
    });

    it('falls back to a queued single-doc write when the transaction cannot run (offline)', async () => {
        runTransaction.mockRejectedValue(new Error('unavailable'));

        await toggleChecklistItem('t1', 'a', { uid: 'w1', displayName: 'Meistras' }, [item('a')]);

        expect(updateDoc).toHaveBeenCalledTimes(1);
        expect(updateDoc.mock.calls[0][1].checklist[0].done).toBe(true);
    });
});

describe('deleteChecklistItem', () => {
    it('drops the item from the LIVE array, keeping an item added concurrently', async () => {
        const captured = withLiveDoc([item('a'), item('b'), item('c', true, 'mgr')]);

        await deleteChecklistItem('t1', 'a', [item('a'), item('b')]); // caller never saw C

        expect(captured.data.checklist.map((i) => i.id)).toEqual(['b', 'c']);
        expect(updateDoc).not.toHaveBeenCalled();
    });
});

describe('applyChecklistToggle (pure)', () => {
    it('leaves every other item byte-identical', () => {
        const list = [item('a', true, 'mgr'), item('b')];
        const next = applyChecklistToggle(list, 'b', { uid: 'w1', displayName: 'M' }, '2026-06-23T12:00:00.000Z');
        expect(next[0]).toBe(list[0]); // untouched reference
        expect(next[1]).toMatchObject({ done: true, doneBy: 'w1', doneAt: '2026-06-23T12:00:00.000Z' });
    });

    it('tolerates a missing/!array checklist', () => {
        expect(applyChecklistToggle(undefined, 'a', {})).toEqual([]);
    });
});
