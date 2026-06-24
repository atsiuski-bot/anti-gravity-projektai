import { describe, it, expect } from 'vitest';
import { scopeActiveTasks, compareTaskTag } from './useTaskFiltering';

// The hook's React wiring (useState/useMemo/debounce) is not rendered — the project has no
// React test harness. What is unique and purely testable is the two new desktop data-grid
// behaviours added for the team list: the BŪSENA column FILTER (scopeActiveTasks' status pass)
// and the ŽYMOS column SORT (compareTaskTag's primary ordering). Both are pure functions.
//
// The active fixtures (pending / in-progress / approved) always clear the "today's work day"
// date gate regardless of when the suite runs. The two manager gates (hide 'unapproved' and
// hide finished by default) are status-driven, not calendar-driven, so they are testable here;
// the date window for finished rows is only asserted in the explicit-filter path with a
// recent finishedAt.

const task = (over = {}) => ({ id: 'x', status: 'pending', ...over });

describe('scopeActiveTasks — shared team list default gates', () => {
    const tasks = [
        task({ id: 'p', status: 'pending' }),
        task({ id: 'i', status: 'in-progress' }),
        task({ id: 'u', status: 'unapproved' }),
        task({ id: 'a', status: 'approved' }),
        task({ id: 'c', status: 'completed', completedAt: new Date().toISOString() }),
        task({ id: 'cf', status: 'confirmed', confirmedAt: new Date().toISOString() }),
    ];

    it('hides unapproved AND finished rows by default, keeping only active ones', () => {
        // Creation gate (unapproved) → "Laukia patvirtinimo" tab; completion gate (completed/
        // confirmed) → leaves the shared list at once. Only pending/in-progress/approved remain.
        const out = scopeActiveTasks(tasks, { filterStatus: '' });
        expect(out.map(t => t.id).sort()).toEqual(['a', 'i', 'p']);
    });
});

describe('scopeActiveTasks — BŪSENA column filter (explicit override)', () => {
    const tasks = [
        task({ id: 'p', status: 'pending' }),
        task({ id: 'i', status: 'in-progress' }),
        task({ id: 'u', status: 'unapproved' }),
        task({ id: 'a', status: 'approved' }),
    ];

    it('reveals unapproved rows when the manager explicitly filters for them', () => {
        expect(scopeActiveTasks(tasks, { filterStatus: 'unapproved' }).map(t => t.id)).toEqual(['u']);
        expect(scopeActiveTasks(tasks, { filterStatus: 'in-progress' }).map(t => t.id)).toEqual(['i']);
    });

    it('reveals a finished row finished within the work day when filtered for it', () => {
        const recent = [task({ id: 'c', status: 'completed', completedAt: new Date().toISOString() })];
        expect(scopeActiveTasks(recent, { filterStatus: 'completed' }).map(t => t.id)).toEqual(['c']);
    });

    it('still bounds a finished filter to the work day (an old finished row stays hidden)', () => {
        const old = [task({ id: 'c', status: 'completed', completedAt: '2000-01-01T00:00:00.000Z' })];
        expect(scopeActiveTasks(old, { filterStatus: 'completed' })).toEqual([]);
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
