import { describe, it, expect } from 'vitest';
import {
    isoWeekday,
    daysInMonth,
    weekIndex,
    recurrenceFiresOn,
    nextOccurrence,
    describeRecurrence,
    defaultRecurrence,
} from './recurrence';

// Anchor: 2024-01-01 is a Monday (ISO 1). The rest of that week follows.
describe('isoWeekday — 1=Mon … 7=Sun, via UTC calendar', () => {
    it('maps the anchor week correctly', () => {
        expect(isoWeekday('2024-01-01')).toBe(1); // Mon
        expect(isoWeekday('2024-01-02')).toBe(2); // Tue
        expect(isoWeekday('2024-01-06')).toBe(6); // Sat
        expect(isoWeekday('2024-01-07')).toBe(7); // Sun (not 0)
    });
    it('returns null for malformed input', () => {
        expect(isoWeekday('')).toBeNull();
        expect(isoWeekday('nope')).toBeNull();
    });
});

describe('daysInMonth', () => {
    it('handles February in leap and non-leap years', () => {
        expect(daysInMonth(2024, 2)).toBe(29);
        expect(daysInMonth(2025, 2)).toBe(28);
        expect(daysInMonth(2025, 4)).toBe(30);
        expect(daysInMonth(2025, 1)).toBe(31);
    });
});

describe('weekIndex — Monday-aligned absolute week index', () => {
    it('increments by one each Monday and is equal within a Mon–Sun week', () => {
        const mon = weekIndex('2024-01-01');         // Monday
        expect(weekIndex('2024-01-07')).toBe(mon);   // same week (Sunday)
        expect(weekIndex('2024-01-08')).toBe(mon + 1); // next Monday
        expect(weekIndex('2024-01-15')).toBe(mon + 2);
        expect(weekIndex('2024-01-29')).toBe(mon + 4);
    });
    it('returns null for malformed input', () => {
        expect(weekIndex('nope')).toBeNull();
    });
});

describe('recurrenceFiresOn', () => {
    it('daily fires every day', () => {
        const r = { active: true, freq: 'daily' };
        expect(recurrenceFiresOn(r, '2024-01-01')).toBe(true);
        expect(recurrenceFiresOn(r, '2024-01-07')).toBe(true);
    });

    it('weekly fires only on the selected weekdays', () => {
        const r = { active: true, freq: 'weekly', byWeekday: [1] }; // Mondays
        expect(recurrenceFiresOn(r, '2024-01-01')).toBe(true);  // Mon
        expect(recurrenceFiresOn(r, '2024-01-02')).toBe(false); // Tue
        expect(recurrenceFiresOn(r, '2024-01-08')).toBe(true);  // next Mon
    });

    it('weekly with multiple weekdays', () => {
        const r = { active: true, freq: 'weekly', byWeekday: [1, 5] }; // Mon + Fri
        expect(recurrenceFiresOn(r, '2024-01-01')).toBe(true);  // Mon
        expect(recurrenceFiresOn(r, '2024-01-05')).toBe(true);  // Fri
        expect(recurrenceFiresOn(r, '2024-01-03')).toBe(false); // Wed
    });

    it('every-2-weeks fires only on anchor-phase weeks', () => {
        // Anchor week = the 2024-01-01 Monday; fire Mondays every 2nd week.
        const r = { active: true, freq: 'weekly', byWeekday: [1], interval: 2, anchorDate: '2024-01-01' };
        expect(recurrenceFiresOn(r, '2024-01-01')).toBe(true);  // anchor week
        expect(recurrenceFiresOn(r, '2024-01-08')).toBe(false); // off week
        expect(recurrenceFiresOn(r, '2024-01-15')).toBe(true);  // +2 weeks
        expect(recurrenceFiresOn(r, '2024-01-22')).toBe(false); // off week
        expect(recurrenceFiresOn(r, '2024-01-16')).toBe(false); // on-week but Tue, not selected
    });

    it('every-4-weeks fires once per 4-week cycle on the selected weekday', () => {
        const r = { active: true, freq: 'weekly', byWeekday: [1], interval: 4, anchorDate: '2024-01-01' };
        expect(recurrenceFiresOn(r, '2024-01-01')).toBe(true);
        expect(recurrenceFiresOn(r, '2024-01-08')).toBe(false);
        expect(recurrenceFiresOn(r, '2024-01-15')).toBe(false);
        expect(recurrenceFiresOn(r, '2024-01-22')).toBe(false);
        expect(recurrenceFiresOn(r, '2024-01-29')).toBe(true);  // +4 weeks
    });

    it('the anchor phase selects which alternating weeks fire (two crews, opposite phase)', () => {
        const crewA = { active: true, freq: 'weekly', byWeekday: [1], interval: 2, anchorDate: '2024-01-01' };
        const crewB = { active: true, freq: 'weekly', byWeekday: [1], interval: 2, anchorDate: '2024-01-08' };
        expect(recurrenceFiresOn(crewA, '2024-01-01')).toBe(true);
        expect(recurrenceFiresOn(crewB, '2024-01-01')).toBe(false);
        expect(recurrenceFiresOn(crewA, '2024-01-08')).toBe(false);
        expect(recurrenceFiresOn(crewB, '2024-01-08')).toBe(true);
    });

    it('interval 1 or a missing anchor degrades to plain weekly (legacy-compatible)', () => {
        const everyWeek = { active: true, freq: 'weekly', byWeekday: [1], interval: 1, anchorDate: '2024-01-01' };
        expect(recurrenceFiresOn(everyWeek, '2024-01-01')).toBe(true);
        expect(recurrenceFiresOn(everyWeek, '2024-01-08')).toBe(true);
        const noAnchor = { active: true, freq: 'weekly', byWeekday: [1], interval: 2 };
        expect(recurrenceFiresOn(noAnchor, '2024-01-01')).toBe(true);
        expect(recurrenceFiresOn(noAnchor, '2024-01-08')).toBe(true); // no phase → every week
        const legacy = { active: true, freq: 'weekly', byWeekday: [1] }; // pre-interval doc
        expect(recurrenceFiresOn(legacy, '2024-01-08')).toBe(true);
    });

    it('monthly fires on the target day, clamping past month-end to the last day', () => {
        const r = { active: true, freq: 'monthly', byMonthDay: 15 };
        expect(recurrenceFiresOn(r, '2025-03-15')).toBe(true);
        expect(recurrenceFiresOn(r, '2025-03-14')).toBe(false);

        const rEnd = { active: true, freq: 'monthly', byMonthDay: 31 };
        expect(recurrenceFiresOn(rEnd, '2025-02-28')).toBe(true);  // clamped to Feb's last day
        expect(recurrenceFiresOn(rEnd, '2025-02-27')).toBe(false);
        expect(recurrenceFiresOn(rEnd, '2025-01-31')).toBe(true);  // real 31st
    });

    it('a paused recurrence never fires', () => {
        const r = { active: false, freq: 'daily' };
        expect(recurrenceFiresOn(r, '2024-01-01')).toBe(false);
    });

    it('an explicitly skipped date never fires', () => {
        const r = { active: true, freq: 'weekly', byWeekday: [1], skipDates: ['2024-01-08'] };
        expect(recurrenceFiresOn(r, '2024-01-01')).toBe(true);
        expect(recurrenceFiresOn(r, '2024-01-08')).toBe(false); // skipped this Monday
        expect(recurrenceFiresOn(r, '2024-01-15')).toBe(true);  // following Monday still fires
    });
});

describe('nextOccurrence', () => {
    it('finds the next firing day on/after a start date', () => {
        const r = { active: true, freq: 'weekly', byWeekday: [1] };
        expect(nextOccurrence(r, '2024-01-02')).toBe('2024-01-08'); // next Monday after Tue
        expect(nextOccurrence(r, '2024-01-01')).toBe('2024-01-01'); // the start day itself fires
    });
    it('returns null for a paused recurrence', () => {
        expect(nextOccurrence({ active: false, freq: 'daily' }, '2024-01-01')).toBeNull();
    });
});

describe('describeRecurrence — Lithuanian summary', () => {
    it('summarizes each cadence', () => {
        expect(describeRecurrence({ active: true, freq: 'daily' })).toBe('Kasdien');
        expect(describeRecurrence({ active: true, freq: 'weekly', byWeekday: [1] })).toBe('Kas savaitę: Pr');
        expect(describeRecurrence({ active: true, freq: 'weekly', byWeekday: [1, 5] })).toBe('Kas savaitę: Pr, Pn');
        expect(describeRecurrence({ active: true, freq: 'weekly', byWeekday: [1], interval: 2 })).toBe('Kas 2 sav.: Pr');
        expect(describeRecurrence({ active: true, freq: 'weekly', byWeekday: [3], interval: 4 })).toBe('Kas 4 sav.: Tr');
        expect(describeRecurrence({ active: true, freq: 'monthly', byMonthDay: 10 })).toBe('Kas mėnesį, 10 d.');
        expect(describeRecurrence({ active: false, freq: 'daily' })).toBe('Pristabdyta');
    });
});

describe('defaultRecurrence', () => {
    it('is weekly-on-Monday and active', () => {
        const r = defaultRecurrence();
        expect(r.active).toBe(true);
        expect(r.freq).toBe('weekly');
        expect(r.byWeekday).toEqual([1]);
    });
});
