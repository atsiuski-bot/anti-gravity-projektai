import { describe, it, expect } from 'vitest';
import {
    isTaskSnoozed,
    hasReturnedFromSnooze,
    canSnoozeTask,
    splitSnoozedTasks,
    nextSnoozeWakeMs,
    getSnoozePresets,
    getSnoozeMinDate,
    snoozeUntilForDate,
    formatSnoozeUntil,
    snoozePassesDeadline,
} from './taskSnooze';

// Wednesday 2026-10-21 10:00 Vilnius (UTC+3, summer time until 2026-10-25).
const WED = new Date('2026-10-21T07:00:00.000Z');
// Friday 2026-10-23 10:00 Vilnius.
const FRI = new Date('2026-10-23T07:00:00.000Z');
// Saturday 2026-10-24 10:00 Vilnius.
const SAT = new Date('2026-10-24T07:00:00.000Z');

const task = (over = {}) => ({ id: 't1', status: 'approved', assignedUserId: 'w1', ...over });

describe('isTaskSnoozed', () => {
    it('is snoozed while the return instant is in the future', () => {
        expect(isTaskSnoozed(task({ snoozedUntil: '2026-10-22T04:00:00.000Z' }), WED)).toBe(true);
    });

    it('is not snoozed once the return instant has passed', () => {
        expect(isTaskSnoozed(task({ snoozedUntil: '2026-10-21T06:00:00.000Z' }), WED)).toBe(false);
    });

    it('a running task is never hidden, even with a future return instant', () => {
        expect(isTaskSnoozed(task({ snoozedUntil: '2026-10-22T04:00:00.000Z', timerStatus: 'running' }), WED)).toBe(false);
    });

    it('a finished task is not treated as snoozed', () => {
        expect(isTaskSnoozed(task({ snoozedUntil: '2026-10-22T04:00:00.000Z', completed: true }), WED)).toBe(false);
    });

    it('a missing or unparseable value is not snoozed', () => {
        expect(isTaskSnoozed(task(), WED)).toBe(false);
        expect(isTaskSnoozed(task({ snoozedUntil: 'nope' }), WED)).toBe(false);
    });
});

describe('hasReturnedFromSnooze', () => {
    it('flags a task that came back earlier in the current work day', () => {
        // Returned 07:00 Vilnius today; the work day started 05:00.
        expect(hasReturnedFromSnooze(task({ snoozedUntil: '2026-10-21T04:00:00.000Z' }), WED)).toBe(true);
    });

    it('drops the flag once the task came back on an earlier work day', () => {
        expect(hasReturnedFromSnooze(task({ snoozedUntil: '2026-10-20T04:00:00.000Z' }), WED)).toBe(false);
    });

    it('is false while still snoozed', () => {
        expect(hasReturnedFromSnooze(task({ snoozedUntil: '2026-10-22T04:00:00.000Z' }), WED)).toBe(false);
    });
});

describe('canSnoozeTask', () => {
    const me = { uid: 'w1' };

    it('the assignee may snooze their approved task', () => {
        expect(canSnoozeTask({ task: task(), currentUser: me })).toBe(true);
    });

    it('a non-assignee may snooze only as a manager', () => {
        expect(canSnoozeTask({ task: task(), currentUser: { uid: 'x' } })).toBe(false);
        expect(canSnoozeTask({ task: task(), currentUser: { uid: 'x' }, isManager: true })).toBe(true);
    });

    it('refuses running, unapproved, finished, quick-work and call tasks', () => {
        expect(canSnoozeTask({ task: task(), currentUser: me, isRunning: true })).toBe(false);
        expect(canSnoozeTask({ task: task({ timerStatus: 'running' }), currentUser: me })).toBe(false);
        expect(canSnoozeTask({ task: task({ status: 'unapproved' }), currentUser: me })).toBe(false);
        expect(canSnoozeTask({ task: task({ status: 'completed', completed: true }), currentUser: me })).toBe(false);
        expect(canSnoozeTask({ task: task({ isQuickWork: true }), currentUser: me })).toBe(false);
        expect(canSnoozeTask({ task: task({ isSystemTask: true }), currentUser: me })).toBe(false);
    });
});

describe('splitSnoozedTasks / nextSnoozeWakeMs', () => {
    const a = task({ id: 'a' });
    const later = task({ id: 'later', snoozedUntil: '2026-10-28T04:00:00.000Z' });
    const sooner = task({ id: 'sooner', snoozedUntil: '2026-10-22T04:00:00.000Z' });
    const back = task({ id: 'back', snoozedUntil: '2026-10-20T04:00:00.000Z' });

    it('keeps input order for active tasks and orders parked ones soonest first', () => {
        const { active, snoozed } = splitSnoozedTasks([later, a, sooner, back], WED);
        expect(active.map((t) => t.id)).toEqual(['a', 'back']);
        expect(snoozed.map((t) => t.id)).toEqual(['sooner', 'later']);
    });

    it('reports the soonest future return instant', () => {
        expect(nextSnoozeWakeMs([later, a, sooner, back], WED)).toBe(Date.parse('2026-10-22T04:00:00.000Z'));
        expect(nextSnoozeWakeMs([a, back], WED)).toBe(null);
    });
});

describe('getSnoozePresets', () => {
    it('midweek: tomorrow, next Monday, and in a week — all 07:00 Vilnius', () => {
        const presets = getSnoozePresets(WED);
        expect(presets.map((p) => [p.key, p.label, p.dateStr])).toEqual([
            ['next-work-day', 'Rytoj rytą', '2026-10-22'],
            ['monday', 'Pirmadienį', '2026-10-26'],
            ['week', 'Po savaitės', '2026-10-28'],
        ]);
        // Summer time: 07:00 Vilnius = 04:00 UTC.
        expect(presets[0].until).toBe('2026-10-22T04:00:00.000Z');
        // After the 2026-10-25 DST switch: 07:00 Vilnius = 05:00 UTC.
        expect(presets[1].until).toBe('2026-10-26T05:00:00.000Z');
    });

    it('Friday: the next work day is Monday, so the duplicate Monday preset is dropped', () => {
        const presets = getSnoozePresets(FRI);
        expect(presets.map((p) => [p.key, p.label, p.dateStr])).toEqual([
            ['next-work-day', 'Pirmadienį rytą', '2026-10-26'],
            ['week', 'Po savaitės', '2026-10-30'],
        ]);
    });

    it('Saturday: skips Sunday to Monday', () => {
        expect(getSnoozePresets(SAT)[0]).toMatchObject({ label: 'Pirmadienį rytą', dateStr: '2026-10-26' });
    });

    it('custom date: tomorrow is the earliest, returning at 07:00', () => {
        expect(getSnoozeMinDate(WED)).toBe('2026-10-22');
        expect(snoozeUntilForDate('2026-11-02')).toBe('2026-11-02T05:00:00.000Z');
    });
});

describe('formatSnoozeUntil', () => {
    it('describes the return instant relative to now', () => {
        expect(formatSnoozeUntil('2026-10-21T12:00:00.000Z', WED)).toBe('šiandien 15:00');
        expect(formatSnoozeUntil('2026-10-22T04:00:00.000Z', WED)).toBe('rytoj 07:00');
        expect(formatSnoozeUntil('2026-10-26T05:00:00.000Z', WED)).toBe('pirm. 07:00');
        expect(formatSnoozeUntil('2026-11-04T05:00:00.000Z', WED)).toBe('11.04 07:00');
        expect(formatSnoozeUntil(null, WED)).toBe('');
    });
});

describe('snoozePassesDeadline', () => {
    it('warns only when the return day is after the deadline day', () => {
        const due = task({ deadline: '2026-10-23' });
        expect(snoozePassesDeadline(due, '2026-10-22T04:00:00.000Z')).toBe(false);
        expect(snoozePassesDeadline(due, '2026-10-23T04:00:00.000Z')).toBe(false);
        expect(snoozePassesDeadline(due, '2026-10-26T05:00:00.000Z')).toBe(true);
        expect(snoozePassesDeadline(task(), '2026-10-26T05:00:00.000Z')).toBe(false);
    });
});
