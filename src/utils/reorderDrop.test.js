import { describe, it, expect } from 'vitest';
import { resolveReorderDrop } from './reorderDrop';

// Build a tasksById lookup from [id, priority] pairs (priority omitted → undefined task field).
const byId = (entries) => {
    const map = {};
    for (const [id, priority] of entries) map[id] = priority === undefined ? { id } : { id, priority };
    return map;
};
const ids = (r) => r.groupTasks.map((t) => t.id);

describe('resolveReorderDrop', () => {
    it('reorders within the same priority — no reprioritize, group keeps the new order', () => {
        const tasksById = byId([['a', 'URGENT'], ['b', 'URGENT'], ['c', 'URGENT']]);
        // c dragged to the front
        const r = resolveReorderDrop({ newOrder: ['c', 'a', 'b'], draggedId: 'c', tasksById });
        expect(r.sourcePriority).toBe('URGENT');
        expect(r.targetPriority).toBe('URGENT');
        expect(r.isReprioritize).toBe(false);
        expect(ids(r)).toEqual(['c', 'a', 'b']);
    });

    it('dragging to the very top above a higher priority reprioritizes UP (successor inference)', () => {
        const tasksById = byId([['u1', 'URGENT'], ['u2', 'URGENT'], ['m1', 'MEDIUM']]);
        // m1 dragged to the top: no predecessor, successor is URGENT
        const r = resolveReorderDrop({ newOrder: ['m1', 'u1', 'u2'], draggedId: 'm1', tasksById });
        expect(r.sourcePriority).toBe('MEDIUM');
        expect(r.targetPriority).toBe('URGENT');
        expect(r.isReprioritize).toBe(true);
        // the dragged card is counted under its NEW priority, at its dropped slot
        expect(ids(r)).toEqual(['m1', 'u1', 'u2']);
    });

    it('dragging into a lower-priority block reprioritizes DOWN (predecessor inference)', () => {
        const tasksById = byId([['m1', 'MEDIUM'], ['m2', 'MEDIUM'], ['u1', 'URGENT']]);
        // u1 dropped between m1 and m2
        const r = resolveReorderDrop({ newOrder: ['m1', 'u1', 'm2'], draggedId: 'u1', tasksById });
        expect(r.sourcePriority).toBe('URGENT');
        expect(r.targetPriority).toBe('MEDIUM');
        expect(r.isReprioritize).toBe(true);
        expect(ids(r)).toEqual(['m1', 'u1', 'm2']);
    });

    it('the PREDECESSOR wins over the successor when both differ', () => {
        const tasksById = byId([['h1', 'HIGH'], ['x', 'MEDIUM'], ['l1', 'LOW']]);
        // x dropped between a HIGH predecessor and a LOW successor → HIGH
        const r = resolveReorderDrop({ newOrder: ['h1', 'x', 'l1'], draggedId: 'x', tasksById });
        expect(r.targetPriority).toBe('HIGH');
        expect(r.isReprioritize).toBe(true);
    });

    it('extracts ONLY the target priority group, preserving its order', () => {
        const tasksById = byId([['u1', 'URGENT'], ['m1', 'MEDIUM'], ['u2', 'URGENT'], ['m2', 'MEDIUM']]);
        // u2 dropped right after u1 (predecessor URGENT) — group is the URGENT cards only
        const r = resolveReorderDrop({ newOrder: ['u1', 'u2', 'm1', 'm2'], draggedId: 'u2', tasksById });
        expect(r.targetPriority).toBe('URGENT');
        expect(r.isReprioritize).toBe(false);
        expect(ids(r)).toEqual(['u1', 'u2']);
    });

    it('a single-item list resolves to its own priority and a one-item group', () => {
        const tasksById = byId([['only', 'HIGH']]);
        const r = resolveReorderDrop({ newOrder: ['only'], draggedId: 'only', tasksById });
        expect(r.isReprioritize).toBe(false);
        expect(r.targetPriority).toBe('HIGH');
        expect(ids(r)).toEqual(['only']);
    });

    it('returns null when the dragged task is absent', () => {
        const tasksById = byId([['a', 'LOW']]);
        expect(resolveReorderDrop({ newOrder: ['a'], draggedId: 'ghost', tasksById })).toBeNull();
    });

    it('falls back to the successor when the predecessor id is not in the lookup', () => {
        const tasksById = byId([['x', 'MEDIUM'], ['s', 'URGENT']]);
        // a stray predecessor id with no task → skip it, infer from the successor
        const r = resolveReorderDrop({ newOrder: ['ghost', 'x', 's'], draggedId: 'x', tasksById });
        expect(r.targetPriority).toBe('URGENT');
        expect(r.isReprioritize).toBe(true);
        expect(ids(r)).toEqual(['x', 's']); // the ghost id is dropped from the group
    });

    it('normalizes priority casing so legacy values resolve consistently', () => {
        const tasksById = byId([['b', 'Urgent'], ['a', 'urgent']]);
        const r = resolveReorderDrop({ newOrder: ['b', 'a'], draggedId: 'b', tasksById });
        expect(r.sourcePriority).toBe('URGENT');
        expect(r.targetPriority).toBe('URGENT');
        expect(r.isReprioritize).toBe(false);
    });

    it('treats a missing/invalid priority as the default (MEDIUM)', () => {
        const tasksById = byId([['b', 'MEDIUM'], ['a', undefined]]);
        // a has no priority → DEFAULT_PRIORITY (MEDIUM); predecessor b is MEDIUM too
        const r = resolveReorderDrop({ newOrder: ['b', 'a'], draggedId: 'a', tasksById });
        expect(r.sourcePriority).toBe('MEDIUM');
        expect(r.targetPriority).toBe('MEDIUM');
        expect(r.isReprioritize).toBe(false);
    });
});
