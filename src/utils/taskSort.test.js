import { describe, it, expect } from 'vitest';
import { compareTasksCanonical, sortTasksCanonical, taskCompletionFraction } from './taskUtils';

// The ONE app-wide order (founder spec 2026-06-26). Keys, each only breaking the previous tie:
//   0. finished last · 1. priority desc · 2. manual boardRank (within priority) ·
//   3. deadline asc · 4. completion desc · 5. createdAt asc.
// Completion is TIME progress (spent / estimated), so a task with no estimate or no spent time
// reads as 0 — which keeps the deadline/createdAt fixtures below clean.

const task = (over = {}) => ({ id: 'x', priority: 'MEDIUM', ...over });

describe('taskCompletionFraction (time progress)', () => {
    it('is 0 with no estimate, regardless of spent time', () => {
        expect(taskCompletionFraction(task({ manualMinutes: 90 }))).toBe(0);
    });
    it('is spent / estimated, capped at 1', () => {
        expect(taskCompletionFraction(task({ estimatedTime: '2h', manualMinutes: 60 }))).toBeCloseTo(0.5);
        expect(taskCompletionFraction(task({ estimatedTime: '2h', manualMinutes: 30 }))).toBeCloseTo(0.25);
        expect(taskCompletionFraction(task({ estimatedTime: '1h', manualMinutes: 180 }))).toBe(1);
    });
    it('is 0 when nothing has been spent yet', () => {
        expect(taskCompletionFraction(task({ estimatedTime: '2h' }))).toBe(0);
    });
});

describe('compareTasksCanonical — key precedence', () => {
    it('0. finished tasks sink below active ones (even at higher priority)', () => {
        const done = task({ id: 'done', priority: 'URGENT', completed: true });
        const active = task({ id: 'active', priority: 'LOW' });
        expect(compareTasksCanonical(done, active)).toBeGreaterThan(0);
        expect(compareTasksCanonical(active, done)).toBeLessThan(0);
    });

    it('1. higher priority first (Skubus > Žemas)', () => {
        expect(compareTasksCanonical(task({ priority: 'URGENT' }), task({ priority: 'LOW' }))).toBeLessThan(0);
        expect(compareTasksCanonical(task({ priority: 'LOW' }), task({ priority: 'HIGH' }))).toBeGreaterThan(0);
    });

    it('2. within a priority, a manual boardRank wins over deadline/completion/createdAt', () => {
        // b would win on deadline (sooner) + completion, but a carries a manual rank and b does not.
        const a = task({ id: 'a', boardRank: 0, deadline: '2030-01-01' });
        const b = task({ id: 'b', deadline: '2020-01-01', estimatedTime: '2h', manualMinutes: 119 });
        expect(compareTasksCanonical(a, b)).toBeLessThan(0);
        // two ranked cards sort by rank ascending
        expect(compareTasksCanonical(task({ boardRank: 1 }), task({ boardRank: 4 }))).toBeLessThan(0);
    });

    it('2. boardRank only compares WITHIN a priority — priority still dominates', () => {
        const urgentLateRank = task({ priority: 'URGENT', boardRank: 9 });
        const highEarlyRank = task({ priority: 'HIGH', boardRank: 0 });
        expect(compareTasksCanonical(urgentLateRank, highEarlyRank)).toBeLessThan(0);
    });

    it('3. with no manual order, the sooner deadline ranks higher; missing deadline last', () => {
        expect(compareTasksCanonical(task({ deadline: '2026-01-01' }), task({ deadline: '2026-12-31' }))).toBeLessThan(0);
        expect(compareTasksCanonical(task({ deadline: '2026-01-01' }), task({}))).toBeLessThan(0);
    });

    it('4. equal deadline → the more-complete (more time spent vs estimate) ranks higher', () => {
        const more = task({ id: 'more', estimatedTime: '2h', manualMinutes: 90 }); // 0.75
        const less = task({ id: 'less', estimatedTime: '2h', manualMinutes: 30 }); // 0.25
        expect(compareTasksCanonical(more, less)).toBeLessThan(0);
    });

    it('5. all else equal → the earlier-created task ranks higher', () => {
        const older = task({ id: 'old', createdAt: '2026-06-01T10:00:00.000Z' });
        const newer = task({ id: 'new', createdAt: '2026-06-20T10:00:00.000Z' });
        expect(compareTasksCanonical(older, newer)).toBeLessThan(0);
    });
});

describe('sortTasksCanonical — integrated order', () => {
    it('orders a mixed list by the full key chain', () => {
        const list = [
            task({ id: 'low', priority: 'LOW' }),
            task({ id: 'urgent-late', priority: 'URGENT', createdAt: '2026-06-20T00:00:00.000Z' }),
            task({ id: 'urgent-early', priority: 'URGENT', createdAt: '2026-06-01T00:00:00.000Z' }),
            task({ id: 'urgent-pinned', priority: 'URGENT', boardRank: 0 }),
            task({ id: 'high-due', priority: 'HIGH', deadline: '2026-07-01' }),
            task({ id: 'done', priority: 'URGENT', completed: true }),
        ];
        const ids = sortTasksCanonical(list).map((t) => t.id);
        expect(ids).toEqual([
            'urgent-pinned',  // URGENT + manual rank beats every other URGENT
            'urgent-early',   // URGENT, no rank/deadline, equal completion → older first
            'urgent-late',
            'high-due',       // HIGH below all URGENT
            'low',            // LOW below HIGH
            'done',           // finished sinks last regardless of its URGENT priority
        ]);
    });

    it('does not mutate the input array', () => {
        const list = [task({ id: 'a', priority: 'LOW' }), task({ id: 'b', priority: 'URGENT' })];
        const snapshot = list.map((t) => t.id);
        sortTasksCanonical(list);
        expect(list.map((t) => t.id)).toEqual(snapshot);
    });
});
