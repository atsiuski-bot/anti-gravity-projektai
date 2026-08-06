import { describe, it, expect } from 'vitest';
import { summarizePlannedHours, sumRemainingPriorityWork, assessCapacity } from './workloadCapacity';

const WEEK_END = new Date('2026-08-09T20:59:59.999Z'); // Sunday night
const NOW = new Date('2026-08-06T09:00:00.000Z');      // Thursday morning

const shift = (props) => ({ userId: 'u1', start: '2026-08-06T06:00:00.000Z', end: '2026-08-06T14:00:00.000Z', ...props });

describe('summarizePlannedHours', () => {
    it('counts a whole future shift as both planned and remaining', () => {
        const rows = [shift({ start: '2026-08-07T06:00:00.000Z', end: '2026-08-07T14:00:00.000Z' })];
        expect(summarizePlannedHours(rows, { userId: 'u1', now: NOW, weekEnd: WEEK_END }))
            .toEqual({ plannedHours: 8, plannedRemainingHours: 8 });
    });

    it('counts a fully elapsed shift as planned but NOT remaining — a missed shift is not spare capacity', () => {
        const rows = [shift({ start: '2026-08-04T06:00:00.000Z', end: '2026-08-04T14:00:00.000Z' })];
        expect(summarizePlannedHours(rows, { userId: 'u1', now: NOW, weekEnd: WEEK_END }))
            .toEqual({ plannedHours: 8, plannedRemainingHours: 0 });
    });

    it('clips a shift in progress to the part not yet elapsed', () => {
        // 06:00–14:00, now is 09:00 → 8h planned, 5h still ahead.
        const { plannedHours, plannedRemainingHours } = summarizePlannedHours([shift()], { userId: 'u1', now: NOW, weekEnd: WEEK_END });
        expect(plannedHours).toBe(8);
        expect(plannedRemainingHours).toBe(5);
    });

    it('clips a shift that runs past the end of the week', () => {
        const rows = [shift({ start: '2026-08-09T18:00:00.000Z', end: '2026-08-10T02:00:00.000Z' })];
        const { plannedHours, plannedRemainingHours } = summarizePlannedHours(rows, { userId: 'u1', now: NOW, weekEnd: WEEK_END });
        expect(plannedHours).toBe(8);
        expect(plannedRemainingHours).toBeCloseTo(3, 3); // 18:00 → 21:00 week end
    });

    it('excludes approved leave and other users', () => {
        const rows = [
            shift({ isVacation: true }),
            shift({ userId: 'u2' })
        ];
        expect(summarizePlannedHours(rows, { userId: 'u1', now: NOW, weekEnd: WEEK_END }))
            .toEqual({ plannedHours: 0, plannedRemainingHours: 0 });
    });

    it('ignores malformed rows instead of producing NaN', () => {
        const rows = [shift({ start: 'not-a-date' }), shift({ end: '2026-08-06T06:00:00.000Z' }), null];
        const result = summarizePlannedHours(rows, { userId: 'u1', now: NOW, weekEnd: WEEK_END });
        expect(result).toEqual({ plannedHours: 0, plannedRemainingHours: 0 });
    });
});

const task = (props) => ({ assignedUserId: 'u1', priority: 'URGENT', status: 'pending', estimatedTimeMinutes: 120, ...props });

describe('sumRemainingPriorityWork', () => {
    it('counts estimate minus work already done — a task carried over from last week counts only for its remainder', () => {
        // 8h estimate, 6h already logged in earlier weeks → 2h left.
        const tasks = [task({ estimatedTimeMinutes: 480, timerMinutes: 300, manualMinutes: 60 })];
        const { urgentMinutes } = sumRemainingPriorityWork(tasks, { userId: 'u1' });
        expect(urgentMinutes).toBe(120);
    });

    it('never goes negative when a task has overrun its estimate', () => {
        const tasks = [task({ estimatedTimeMinutes: 60, timerMinutes: 300 })];
        expect(sumRemainingPriorityWork(tasks, { userId: 'u1' }).urgentMinutes).toBe(0);
    });

    it('splits urgent and high, and ignores medium/low', () => {
        const tasks = [
            task({ priority: 'URGENT', estimatedTimeMinutes: 60 }),
            task({ priority: 'HIGH', estimatedTimeMinutes: 90 }),
            task({ priority: 'MEDIUM', estimatedTimeMinutes: 600 }),
            task({ priority: 'LOW', estimatedTimeMinutes: 600 })
        ];
        const { urgentMinutes, highMinutes } = sumRemainingPriorityWork(tasks, { userId: 'u1' });
        expect(urgentMinutes).toBe(60);
        expect(highMinutes).toBe(90);
    });

    it('falls back to the free-text estimate when the numeric mirror is missing', () => {
        const tasks = [task({ estimatedTimeMinutes: undefined, estimatedTime: '1,5h' })];
        expect(sumRemainingPriorityWork(tasks, { userId: 'u1' }).urgentMinutes).toBe(90);
    });

    it('counts unestimated tasks separately instead of dropping them', () => {
        const tasks = [task({ estimatedTimeMinutes: undefined, estimatedTime: '' })];
        const { urgentMinutes, noEstimateCount } = sumRemainingPriorityWork(tasks, { userId: 'u1' });
        expect(urgentMinutes).toBe(0);
        expect(noEstimateCount).toBe(1);
    });

    it('excludes finished, archived, unapproved, deleted, quick-work and system tasks, and other users', () => {
        const tasks = [
            task({ completed: true }),
            task({ status: 'completed' }),
            task({ status: 'confirmed' }),
            task({ status: 'unapproved' }),
            task({ status: 'deleted' }),
            task({ archivedAt: '2026-08-05' }),
            task({ isDeleted: true }),
            task({ isQuickWork: true }),
            task({ isSystemTask: true }),
            task({ assignedUserId: 'u2' })
        ];
        expect(sumRemainingPriorityWork(tasks, { userId: 'u1' }))
            .toEqual({ urgentMinutes: 0, highMinutes: 0, noEstimateCount: 0 });
    });
});

describe('assessCapacity', () => {
    it('flags overload when work left exceeds the planned time left', () => {
        const result = assessCapacity({ priorityLeftHours: 12, plannedRemainingHours: 8, plannedHours: 40 });
        expect(result.isOverloaded).toBe(true);
        expect(result.capacityDeficitHours).toBe(4);
        expect(result.netRemainingHours).toBe(-4);
    });

    it('stays quiet when the remaining plan covers the remaining work', () => {
        const result = assessCapacity({ priorityLeftHours: 6, plannedRemainingHours: 8, plannedHours: 40 });
        expect(result.isOverloaded).toBe(false);
        expect(result.capacityDeficitHours).toBe(-2);
        expect(result.netRemainingHours).toBe(2);
    });

    it('keeps the displayed balance X - Y = Z and the badge in lockstep', () => {
        // The row prints "X - Y = Z" and the badge prints the deficit; both must come from the same
        // arithmetic, or a manager sees a positive balance next to a "will not make it" warning.
        for (const [X, Y] of [[8, 12], [8, 6], [0, 3], [10, 10]]) {
            const r = assessCapacity({ priorityLeftHours: Y, plannedRemainingHours: X, plannedHours: 40 });
            expect(r.netRemainingHours).toBe(X - Y);
            expect(r.capacityDeficitHours).toBe(-r.netRemainingHours);
            expect(r.isOverloaded).toBe(r.netRemainingHours < 0);
        }
    });

    it('flags a booked-out week: plan exists but none of it is left', () => {
        expect(assessCapacity({ priorityLeftHours: 3, plannedRemainingHours: 0, plannedHours: 40 }).isOverloaded).toBe(true);
    });

    it('stays quiet for an unplanned worker — no plan means capacity is unknown, not zero', () => {
        expect(assessCapacity({ priorityLeftHours: 20, plannedRemainingHours: 0, plannedHours: 0 }).isOverloaded).toBe(false);
    });

    it('does not fire on an exact tie', () => {
        expect(assessCapacity({ priorityLeftHours: 8, plannedRemainingHours: 8, plannedHours: 40 }).isOverloaded).toBe(false);
    });
});
