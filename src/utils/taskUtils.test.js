import { describe, it, expect } from 'vitest';
import { scopePersonalDayWindow, scopeCompletedToday } from './taskUtils';

// scopePersonalDayWindow is the PERSONAL-list day window shared by the worker's "Mano užduotys"
// and the manager's "Mano darbai": every still-active task stays, but a finished
// (completed/confirmed) task drops once it rolls past the current work day's 03:00 cutoff. The
// cutoff is injected so the assertions are independent of when the suite runs.

const task = (over = {}) => ({ id: 'x', status: 'pending', ...over });
const CUTOFF = new Date('2026-06-24T00:00:00.000Z');

describe('scopePersonalDayWindow', () => {
    it('keeps every still-active task, including the worker\'s own unapproved one', () => {
        const tasks = [
            task({ id: 'p', status: 'pending' }),
            task({ id: 'i', status: 'in-progress' }),
            task({ id: 'u', status: 'unapproved' }),
            task({ id: 'a', status: 'approved' }),
        ];
        expect(scopePersonalDayWindow(tasks, CUTOFF).map(t => t.id).sort()).toEqual(['a', 'i', 'p', 'u']);
    });

    it('keeps a finished task that completed AT or AFTER the cutoff (still today)', () => {
        const tasks = [task({ id: 'c', status: 'completed', completedAt: '2026-06-24T08:00:00.000Z' })];
        expect(scopePersonalDayWindow(tasks, CUTOFF).map(t => t.id)).toEqual(['c']);
    });

    it('drops a finished task that completed BEFORE the cutoff (rolled to history)', () => {
        const tasks = [task({ id: 'c', status: 'completed', completedAt: '2026-06-23T20:00:00.000Z' })];
        expect(scopePersonalDayWindow(tasks, CUTOFF)).toEqual([]);
    });

    it('honours confirmedAt / updatedAt fallbacks and drops a finished row with no timestamp', () => {
        const tasks = [
            task({ id: 'cf', status: 'confirmed', confirmedAt: '2026-06-24T10:00:00.000Z' }),
            task({ id: 'legacy', completed: true, updatedAt: '2026-06-24T09:00:00.000Z' }),
            task({ id: 'orphan', status: 'completed' }), // no finishedAt → hidden
        ];
        expect(scopePersonalDayWindow(tasks, CUTOFF).map(t => t.id).sort()).toEqual(['cf', 'legacy']);
    });

    it('returns [] for nullish input', () => {
        expect(scopePersonalDayWindow(null)).toEqual([]);
        expect(scopePersonalDayWindow(undefined)).toEqual([]);
    });
});

// scopeCompletedToday is the counterpart used by the "Padaryti darbai" section at the bottom of the
// Veiklos tab: everything FINISHED inside the current work day — regular tasks, quick work and
// calls alike — newest first, with soft-deleted rows excluded.
describe('scopeCompletedToday', () => {
    it('keeps quick work and calls, which the active list filters out', () => {
        const tasks = [
            task({ id: 'q', status: 'completed', completed: true, isQuickWork: true, completedAt: '2026-06-24T09:00:00.000Z' }),
            task({ id: 'c', status: 'completed', completed: true, isSystemTask: true, completedAt: '2026-06-24T10:00:00.000Z' }),
            task({ id: 't', status: 'confirmed', confirmedAt: '2026-06-24T11:00:00.000Z' }),
        ];
        expect(scopeCompletedToday(tasks, CUTOFF).map(t => t.id)).toEqual(['t', 'c', 'q']);
    });

    it('drops still-active work, work finished before the cutoff, and deleted rows', () => {
        const tasks = [
            task({ id: 'active', status: 'in-progress' }),
            task({ id: 'yesterday', status: 'completed', completed: true, completedAt: '2026-06-23T20:00:00.000Z' }),
            task({ id: 'deleted', status: 'completed', completed: true, isDeleted: true, completedAt: '2026-06-24T09:00:00.000Z' }),
            task({ id: 'nostamp', status: 'completed', completed: true }),
        ];
        expect(scopeCompletedToday(tasks, CUTOFF)).toEqual([]);
    });

    it('tolerates a missing list', () => {
        expect(scopeCompletedToday(null)).toEqual([]);
        expect(scopeCompletedToday(undefined)).toEqual([]);
    });
});
