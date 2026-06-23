import { describe, it, expect } from 'vitest';
import { scopeActiveTasks, compareTaskTag } from './useTaskFiltering';

// The hook's React wiring (useState/useMemo/debounce) is not rendered — the project has no
// React test harness. What is unique and purely testable is the two new desktop data-grid
// behaviours added for the team list: the BŪSENA column FILTER (scopeActiveTasks' status pass)
// and the ŽYMOS column SORT (compareTaskTag's primary ordering). Both are pure functions.
//
// All fixtures use ACTIVE (not done / not deleted) statuses, so they always clear the
// "today's work day" date gate regardless of when the suite runs — keeping these tests about
// the filter/sort axis, not the calendar.

const task = (over = {}) => ({ id: 'x', status: 'pending', ...over });

describe('scopeActiveTasks — BŪSENA column filter', () => {
    const tasks = [
        task({ id: 'p', status: 'pending' }),
        task({ id: 'i', status: 'in-progress' }),
        task({ id: 'u', status: 'unapproved' }),
        task({ id: 'a', status: 'approved' }),
    ];

    it('returns every active task when no status filter is set', () => {
        const out = scopeActiveTasks(tasks, { filterStatus: '' });
        expect(out.map(t => t.id).sort()).toEqual(['a', 'i', 'p', 'u']);
    });

    it('keeps only rows whose STORED status matches the chosen filter', () => {
        expect(scopeActiveTasks(tasks, { filterStatus: 'unapproved' }).map(t => t.id)).toEqual(['u']);
        expect(scopeActiveTasks(tasks, { filterStatus: 'in-progress' }).map(t => t.id)).toEqual(['i']);
    });

    it('treats a missing status as "pending" (the lifecycle default)', () => {
        const out = scopeActiveTasks([task({ id: 'nostatus', status: undefined })], { filterStatus: 'pending' });
        expect(out.map(t => t.id)).toEqual(['nostatus']);
    });

    it('composes with the other structural filters (status ∧ user)', () => {
        const mixed = [
            task({ id: 'm1', status: 'unapproved', assignedUserId: 'u1' }),
            task({ id: 'm2', status: 'unapproved', assignedUserId: 'u2' }),
            task({ id: 'm3', status: 'pending', assignedUserId: 'u1' }),
        ];
        const out = scopeActiveTasks(mixed, { filterStatus: 'unapproved', filterUser: 'u1' });
        expect(out.map(t => t.id)).toEqual(['m1']);
    });
});

describe('compareTaskTag — ŽYMOS column sort (primary ordering)', () => {
    it('orders tags alphabetically', () => {
        expect(compareTaskTag(task({ tag: 'Auto' }), task({ tag: 'Piro' }))).toBeLessThan(0);
        expect(compareTaskTag(task({ tag: 'Piro' }), task({ tag: 'Auto' }))).toBeGreaterThan(0);
    });

    it('treats equal tags as a tie (0 → caller applies the priority/user tie-break)', () => {
        expect(compareTaskTag(task({ tag: 'Renginiams' }), task({ tag: 'Renginiams' }))).toBe(0);
    });

    it('pushes untagged rows to the end', () => {
        expect(compareTaskTag(task({ tag: 'Auto' }), task({ tag: undefined }))).toBeLessThan(0);
        expect(compareTaskTag(task({ tag: undefined }), task({ tag: 'Auto' }))).toBeGreaterThan(0);
        expect(compareTaskTag(task({ tag: undefined }), task({ tag: undefined }))).toBe(0);
    });

    it('sorts a mixed list with untagged last via Array.sort', () => {
        const list = [
            task({ id: 'no', tag: undefined }),
            task({ id: 'piro', tag: 'Piro' }),
            task({ id: 'auto', tag: 'Auto' }),
        ];
        const sorted = [...list].sort(compareTaskTag).map(t => t.id);
        expect(sorted).toEqual(['auto', 'piro', 'no']);
    });
});
