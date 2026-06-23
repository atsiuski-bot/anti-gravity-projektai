import { describe, it, expect } from 'vitest';
import {
    absenceWindowEnd,
    taskDeadlineDay,
    isOpenTask,
    computeReassignEligibility,
    workerTasksQuerySpec,
} from './UserProfileModal';

// The eligibility core is pure and date-bucketed in Vilnius. These tests pin the founder constraint:
// a task is reassignable ONLY when it has a concrete deadline that lands while the worker is still
// away (deadline day <= last absence day). No deadline, no absence window, or a deadline once the
// worker is back => NOT eligible.
//
// Vilnius is UTC+3 in summer (the dates below are June). A deadline stamped at 22:00Z on the 24th
// buckets to the 25th in Vilnius — that boundary is exercised explicitly.

describe('absenceWindowEnd', () => {
    it('returns the latest absence day (Vilnius) across isVacation docs', () => {
        const docs = [
            { isVacation: true, start: '2026-06-22T06:00:00Z' },
            { isVacation: true, start: '2026-06-24T06:00:00Z' },
            { isVacation: true, start: '2026-06-23T06:00:00Z' },
        ];
        expect(absenceWindowEnd(docs)).toBe('2026-06-24');
    });

    it('ignores non-absence (worked) docs', () => {
        const docs = [
            { isVacation: false, start: '2026-06-30T06:00:00Z' },
            { isVacation: true, start: '2026-06-22T06:00:00Z' },
        ];
        expect(absenceWindowEnd(docs)).toBe('2026-06-22');
    });

    it('buckets to the Vilnius day, not UTC (22:00Z in June rolls to the next day)', () => {
        // 22:00Z on the 24th is 01:00 on the 25th in Vilnius (UTC+3).
        expect(absenceWindowEnd([{ isVacation: true, start: '2026-06-24T22:00:00Z' }])).toBe('2026-06-25');
    });

    it('returns null when there is no absence on record', () => {
        expect(absenceWindowEnd([])).toBeNull();
        expect(absenceWindowEnd([{ isVacation: false, start: '2026-06-22T06:00:00Z' }])).toBeNull();
        expect(absenceWindowEnd(undefined)).toBeNull();
    });
});

describe('taskDeadlineDay', () => {
    it('buckets an ISO deadline to its Vilnius day', () => {
        expect(taskDeadlineDay({ deadline: '2026-06-23T08:00:00Z' })).toBe('2026-06-23');
    });
    it('accepts a bare YYYY-MM-DD deadline', () => {
        expect(taskDeadlineDay({ deadline: '2026-06-23' })).toBe('2026-06-23');
    });
    it('returns null with no deadline', () => {
        expect(taskDeadlineDay({})).toBeNull();
        expect(taskDeadlineDay({ deadline: '' })).toBeNull();
    });
});

describe('isOpenTask', () => {
    it('treats pending and in-progress as open', () => {
        expect(isOpenTask({ status: 'pending' })).toBe(true);
        expect(isOpenTask({ status: 'in-progress' })).toBe(true);
    });
    it('treats finished / archived statuses as not open', () => {
        expect(isOpenTask({ status: 'completed' })).toBe(false);
        expect(isOpenTask({ status: 'confirmed' })).toBe(false);
        expect(isOpenTask({ status: undefined })).toBe(false);
    });
});

describe('computeReassignEligibility', () => {
    const absentUntil24 = [{ isVacation: true, start: '2026-06-24T06:00:00Z' }];

    it('includes an open task whose deadline falls within the absence window', () => {
        const tasks = [{ id: 'a', status: 'pending', deadline: '2026-06-23T08:00:00Z' }];
        const { eligible, ineligible, windowEnd } = computeReassignEligibility(tasks, absentUntil24);
        expect(windowEnd).toBe('2026-06-24');
        expect(eligible.map((t) => t.id)).toEqual(['a']);
        expect(ineligible).toHaveLength(0);
    });

    it('includes a task whose deadline is the LAST absence day (still away that day)', () => {
        const tasks = [{ id: 'b', status: 'in-progress', deadline: '2026-06-24T08:00:00Z' }];
        const { eligible } = computeReassignEligibility(tasks, absentUntil24);
        expect(eligible.map((t) => t.id)).toEqual(['b']);
    });

    it('EXCLUDES a task whose deadline is after the worker is back', () => {
        const tasks = [{ id: 'c', status: 'pending', deadline: '2026-06-26T08:00:00Z' }];
        const { eligible, ineligible } = computeReassignEligibility(tasks, absentUntil24);
        expect(eligible).toHaveLength(0);
        expect(ineligible.map((t) => t.id)).toEqual(['c']);
    });

    it('EXCLUDES an open task with no deadline (worker can still do it on return)', () => {
        const tasks = [{ id: 'd', status: 'pending' }];
        const { eligible, ineligible } = computeReassignEligibility(tasks, absentUntil24);
        expect(eligible).toHaveLength(0);
        expect(ineligible.map((t) => t.id)).toEqual(['d']);
    });

    it('EXCLUDES non-open tasks entirely (neither bucket)', () => {
        const tasks = [
            { id: 'done', status: 'completed', deadline: '2026-06-23T08:00:00Z' },
            { id: 'confirmed', status: 'confirmed', deadline: '2026-06-23T08:00:00Z' },
        ];
        const { eligible, ineligible } = computeReassignEligibility(tasks, absentUntil24);
        expect(eligible).toHaveLength(0);
        expect(ineligible).toHaveLength(0);
    });

    it('with NO absence on record, nothing qualifies even with a deadline', () => {
        const tasks = [{ id: 'e', status: 'pending', deadline: '2026-06-23T08:00:00Z' }];
        const { eligible, ineligible, windowEnd } = computeReassignEligibility(tasks, []);
        expect(windowEnd).toBeNull();
        expect(eligible).toHaveLength(0);
        expect(ineligible.map((t) => t.id)).toEqual(['e']);
    });

    it('splits a mixed task list correctly', () => {
        const tasks = [
            { id: 'in', status: 'pending', deadline: '2026-06-22T08:00:00Z' },     // eligible
            { id: 'noDeadline', status: 'in-progress' },                            // ineligible
            { id: 'after', status: 'pending', deadline: '2026-06-30T08:00:00Z' },  // ineligible
            { id: 'closed', status: 'completed', deadline: '2026-06-22T08:00:00Z' }, // dropped
        ];
        const { eligible, ineligible } = computeReassignEligibility(tasks, absentUntil24);
        expect(eligible.map((t) => t.id)).toEqual(['in']);
        expect(ineligible.map((t) => t.id).sort()).toEqual(['after', 'noDeadline']);
    });
});

// Regression: a SCOPED overseer (scopedManager / seniorManager) must still load the worker's open
// tasks. The old query ANDed `assignedUserId == worker` with `teamManagerIds array-contains viewer`,
// which the rules/index never support together, so the reassign list was always empty for exactly
// the overseers the feature exists for. The fix fetches the subtree slice by the stamp, then narrows
// to the worker client-side. We can't introspect the opaque `where()` objects, so we assert the
// SHAPE of the spec (which collection filter, whether a client-side owner filter is required) and
// replay that filter over a realistic subtree slice.
describe('workerTasksQuerySpec — read scope for the reassign task load', () => {
    const VIEWER = 'overseer-1';
    const WORKER = 'worker-7';

    // A subtree slice as Firestore would return it for `teamManagerIds array-contains overseer-1`:
    // several workers under the same overseer, NOT just the one being reassigned.
    const subtreeSlice = [
        { id: 't1', assignedUserId: WORKER, teamManagerIds: [VIEWER], status: 'pending' },
        { id: 't2', assignedUserId: WORKER, teamManagerIds: [VIEWER, 'overseer-2'], status: 'in-progress' },
        { id: 't3', assignedUserId: 'other-worker', teamManagerIds: [VIEWER], status: 'pending' },
    ];

    const applyClientFilter = (rows, spec) =>
        spec.filterOwnerClientSide ? rows.filter((t) => t.assignedUserId === WORKER) : rows;

    it('a scoped manager fetches the subtree slice, then keeps only this worker (non-empty)', () => {
        const spec = workerTasksQuerySpec({
            workerId: WORKER,
            viewerData: { role: 'manager', scopedManager: true },
            viewerUid: VIEWER,
        });
        // Subtree query + a client-side narrow, NOT an assignedUserId == AND array-contains query.
        expect(spec.constraints).toHaveLength(1);
        expect(spec.filterOwnerClientSide).toBe(true);
        // The whole point: the worker's open tasks survive; the sibling worker's row is dropped.
        const loaded = applyClientFilter(subtreeSlice, spec);
        expect(loaded.map((t) => t.id)).toEqual(['t1', 't2']);
        expect(loaded.length).toBeGreaterThan(0);
    });

    it('a senior manager is scoped the same way (subtree slice + client-side owner narrow)', () => {
        const spec = workerTasksQuerySpec({
            workerId: WORKER,
            viewerData: { role: 'seniorManager' },
            viewerUid: VIEWER,
        });
        expect(spec.filterOwnerClientSide).toBe(true);
        expect(applyClientFilter(subtreeSlice, spec).map((t) => t.id)).toEqual(['t1', 't2']);
    });

    it('a whole-team viewer (unscoped manager) queries the worker directly, no client-side narrow', () => {
        const spec = workerTasksQuerySpec({
            workerId: WORKER,
            viewerData: { role: 'manager', scopedManager: false },
            viewerUid: VIEWER,
        });
        expect(spec.constraints).toHaveLength(1);
        expect(spec.filterOwnerClientSide).toBe(false);
    });

    it('an admin queries the worker directly, no client-side narrow', () => {
        const spec = workerTasksQuerySpec({
            workerId: WORKER,
            viewerData: { role: 'admin' },
            viewerUid: VIEWER,
        });
        expect(spec.filterOwnerClientSide).toBe(false);
    });
});
