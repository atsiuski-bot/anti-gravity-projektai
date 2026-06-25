import { describe, it, expect } from 'vitest';
import { shiftRange, resolvePresetRange, PERIOD_PRESETS } from './periodPresets';
import { getLithuanianDateString } from '../../utils/timeUtils';

// ---------------------------------------------------------------------------
// shiftRange — pure calendar arithmetic for period navigation.
//
// Strategy: use PAST dates for most cases so the "end capped at today" branch
// never fires and expected values are fully deterministic. Future dates are
// used only for the cap tests (where we call getLithuanianDateString() in the
// assertion to stay in sync with the test runner's wall clock).
// ---------------------------------------------------------------------------

describe('shiftRange — week', () => {
    it('shifts back one week (7 days, Monday-aligned)', () => {
        // 2024-06-17 (Mon) – 2024-06-23 (Sun) → back → 2024-06-10 – 2024-06-16
        expect(shiftRange('week', { start: '2024-06-17', end: '2024-06-23' }, -1))
            .toEqual({ start: '2024-06-10', end: '2024-06-16' });
    });

    it('shifts forward one week', () => {
        expect(shiftRange('week', { start: '2024-06-10', end: '2024-06-16' }, 1))
            .toEqual({ start: '2024-06-17', end: '2024-06-23' });
    });

    it('crosses a month boundary on backward shift', () => {
        // 2024-06-03 (Mon) – 2024-06-09 (Sun) → back → 2024-05-27 – 2024-06-02
        expect(shiftRange('week', { start: '2024-06-03', end: '2024-06-09' }, -1))
            .toEqual({ start: '2024-05-27', end: '2024-06-02' });
    });

    it('crosses year boundary on backward shift', () => {
        // 2024-01-01 (Mon) – 2024-01-07 (Sun) → back → 2023-12-25 – 2023-12-31
        expect(shiftRange('week', { start: '2024-01-01', end: '2024-01-07' }, -1))
            .toEqual({ start: '2023-12-25', end: '2023-12-31' });
    });

    it('caps end at today when forward shift would exceed today', () => {
        const today = getLithuanianDateString();
        // Shifting a far-future week forward — end always capped
        const result = shiftRange('week', { start: '2030-01-06', end: '2030-01-12' }, 1);
        expect(result.start).toBe('2030-01-13');
        expect(result.end).toBe(today);
    });
});

describe('shiftRange — month', () => {
    it('shifts back one month (mid-year)', () => {
        // 2024-06-01 – 2024-06-30 → back → 2024-05-01 – 2024-05-31
        expect(shiftRange('month', { start: '2024-06-01', end: '2024-06-30' }, -1))
            .toEqual({ start: '2024-05-01', end: '2024-05-31' });
    });

    it('shifts forward one month (mid-year)', () => {
        expect(shiftRange('month', { start: '2024-05-01', end: '2024-05-31' }, 1))
            .toEqual({ start: '2024-06-01', end: '2024-06-30' });
    });

    it('rolls back from January to December of previous year', () => {
        expect(shiftRange('month', { start: '2024-01-01', end: '2024-01-31' }, -1))
            .toEqual({ start: '2023-12-01', end: '2023-12-31' });
    });

    it('rolls forward from December to January of next year', () => {
        expect(shiftRange('month', { start: '2023-12-01', end: '2023-12-31' }, 1))
            .toEqual({ start: '2024-01-01', end: '2024-01-31' });
    });

    it('handles February in a leap year (2024)', () => {
        // March 2024 → back → February 2024 (29 days)
        expect(shiftRange('month', { start: '2024-03-01', end: '2024-03-31' }, -1))
            .toEqual({ start: '2024-02-01', end: '2024-02-29' });
    });

    it('handles February in a non-leap year (2023)', () => {
        expect(shiftRange('month', { start: '2023-03-01', end: '2023-03-31' }, -1))
            .toEqual({ start: '2023-02-01', end: '2023-02-28' });
    });

    it('caps end at today when forward shift exceeds today', () => {
        const today = getLithuanianDateString();
        const result = shiftRange('month', { start: '2030-01-01', end: '2030-01-31' }, 1);
        expect(result.start).toBe('2030-02-01');
        expect(result.end).toBe(today);
    });
});

describe('shiftRange — 3months', () => {
    it('shifts back one quarter (mid-year)', () => {
        // Apr–Jun 2024 → back → Jan–Mar 2024
        expect(shiftRange('3months', { start: '2024-04-01', end: '2024-06-30' }, -1))
            .toEqual({ start: '2024-01-01', end: '2024-03-31' });
    });

    it('shifts forward one quarter (mid-year)', () => {
        expect(shiftRange('3months', { start: '2024-01-01', end: '2024-03-31' }, 1))
            .toEqual({ start: '2024-04-01', end: '2024-06-30' });
    });

    it('rolls back across year boundary (Jan–Mar → Oct–Dec prev year)', () => {
        expect(shiftRange('3months', { start: '2024-01-01', end: '2024-03-31' }, -1))
            .toEqual({ start: '2023-10-01', end: '2023-12-31' });
    });

    it('rolls forward across year boundary (Oct–Dec → Jan–Mar next year)', () => {
        expect(shiftRange('3months', { start: '2023-10-01', end: '2023-12-31' }, 1))
            .toEqual({ start: '2024-01-01', end: '2024-03-31' });
    });

    it('computes correct end for quarter ending in a 30-day month', () => {
        // Nov–Dec 2023 + Jan 2024... wait: Apr–Jun ends June 30; test Sep–Nov ending Nov 30
        expect(shiftRange('3months', { start: '2024-06-01', end: '2024-08-31' }, 1))
            .toEqual({ start: '2024-09-01', end: '2024-11-30' });
    });
});

describe('shiftRange — year', () => {
    it('shifts back one year', () => {
        expect(shiftRange('year', { start: '2024-01-01', end: '2024-12-31' }, -1))
            .toEqual({ start: '2023-01-01', end: '2023-12-31' });
    });

    it('shifts forward one year into the past', () => {
        expect(shiftRange('year', { start: '2022-01-01', end: '2022-12-31' }, 1))
            .toEqual({ start: '2023-01-01', end: '2023-12-31' });
    });

    it('caps end at today when forward year exceeds today', () => {
        const today = getLithuanianDateString();
        const result = shiftRange('year', { start: '2030-01-01', end: '2030-12-31' }, 1);
        expect(result.start).toBe('2031-01-01');
        expect(result.end).toBe(today);
    });
});

describe('shiftRange — custom (shift by window length)', () => {
    it('shifts a single-day window back', () => {
        // 1-day custom: shifts by 1 day back
        expect(shiftRange('custom', { start: '2024-06-10', end: '2024-06-10' }, -1))
            .toEqual({ start: '2024-06-09', end: '2024-06-09' });
    });

    it('shifts a 7-day custom window forward', () => {
        expect(shiftRange('custom', { start: '2024-06-03', end: '2024-06-09' }, 1))
            .toEqual({ start: '2024-06-10', end: '2024-06-16' });
    });

    it('shifts a 30-day custom window back across month boundary', () => {
        // 2024-06-01 – 2024-06-30 = 30 days → shift back 30 days → 2024-05-02 – 2024-05-31
        expect(shiftRange('custom', { start: '2024-06-01', end: '2024-06-30' }, -1))
            .toEqual({ start: '2024-05-02', end: '2024-05-31' });
    });

    it('caps end at today when custom shift would exceed today', () => {
        const today = getLithuanianDateString();
        const result = shiftRange('custom', { start: '2030-01-01', end: '2030-01-07' }, 1);
        expect(result.start).toBe('2030-01-08');
        expect(result.end).toBe(today);
    });
});

// ---------------------------------------------------------------------------
// resolvePresetRange — smoke tests (returns valid ISO ranges for all presets)
// ---------------------------------------------------------------------------

describe('resolvePresetRange', () => {
    const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

    it('returns null for unknown preset', () => {
        expect(resolvePresetRange('unknown')).toBeNull();
    });

    for (const { id } of PERIOD_PRESETS) {
        it(`returns a valid {start, end} for preset "${id}"`, () => {
            const range = resolvePresetRange(id);
            expect(range).not.toBeNull();
            expect(range.start).toMatch(ISO_RE);
            expect(range.end).toMatch(ISO_RE);
            expect(range.start <= range.end).toBe(true);
        });
    }

    it('week range always starts on a Monday', () => {
        const { start } = resolvePresetRange('week');
        const [y, m, d] = start.split('-').map(Number);
        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        expect(dow).toBe(1); // 1 = Monday
    });

    it('month range always starts on day 01', () => {
        const { start } = resolvePresetRange('month');
        expect(start.endsWith('-01')).toBe(true);
    });

    it('year range always starts on Jan 01', () => {
        const { start } = resolvePresetRange('year');
        expect(start.slice(5)).toBe('01-01');
    });

    it('all presets end on today', () => {
        const today = getLithuanianDateString();
        for (const { id } of PERIOD_PRESETS) {
            expect(resolvePresetRange(id).end).toBe(today);
        }
    });
});
