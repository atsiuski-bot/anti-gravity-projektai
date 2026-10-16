import { describe, it, expect } from 'vitest';
import { daysBetween, dutyStatus, sortDuties, validateDutyMark, validateDutyFields } from './duties';

describe('daysBetween', () => {
    it('counts whole calendar days, across a month and a DST boundary', () => {
        expect(daysBetween('2026-10-15', '2026-10-22')).toBe(7);
        expect(daysBetween('2026-10-22', '2026-10-15')).toBe(-7);
        expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2); // EU DST ends 2026-10-25
        expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1);
    });
});

describe('dutyStatus', () => {
    const weekly = { coveredThrough: '2026-10-15', intervalDays: 7 };

    it('a never-marked duty has no due date', () => {
        expect(dutyStatus({ intervalDays: 7 }, '2026-10-16')).toMatchObject({ kind: 'never', nextDue: null });
        expect(dutyStatus({ coveredThrough: null, intervalDays: 7 }, '2026-10-16').kind).toBe('never');
    });

    it('the next round is due one interval after the watermark', () => {
        expect(dutyStatus(weekly, '2026-10-16')).toMatchObject({ kind: 'ok', nextDue: '2026-10-22', label: 'Laiku' });
    });

    it('is "due soon" the day before and on the due day', () => {
        expect(dutyStatus(weekly, '2026-10-20').kind).toBe('ok');
        expect(dutyStatus(weekly, '2026-10-21').kind).toBe('soon');
        expect(dutyStatus(weekly, '2026-10-22').kind).toBe('soon');
    });

    it('is late once today passes the due day, counting the days', () => {
        expect(dutyStatus(weekly, '2026-10-23')).toMatchObject({ kind: 'late', daysLate: 1, label: 'Vėluoja 1 d.' });
        expect(dutyStatus(weekly, '2026-10-30')).toMatchObject({ kind: 'late', daysLate: 8 });
    });

    it('a watermark ahead of today stays on time until one interval past it', () => {
        expect(dutyStatus({ coveredThrough: '2026-10-24', intervalDays: 7 }, '2026-10-17'))
            .toMatchObject({ kind: 'ok', nextDue: '2026-10-31' });
    });

    it('honours the longer cadences', () => {
        expect(dutyStatus({ coveredThrough: '2026-10-01', intervalDays: 30 }, '2026-10-16').nextDue).toBe('2026-10-31');
        expect(dutyStatus({ coveredThrough: '2026-10-01', intervalDays: 14 }, '2026-10-16').kind).toBe('late');
    });
});

describe('sortDuties', () => {
    it('puts late first (most late first), then never, soon, ok; ties by title', () => {
        const today = '2026-10-16';
        const duties = [
            { id: 'ok', title: 'B', coveredThrough: '2026-10-15', intervalDays: 7 },
            { id: 'late1', title: 'A', coveredThrough: '2026-10-07', intervalDays: 7 },
            { id: 'late5', title: 'Z', coveredThrough: '2026-10-03', intervalDays: 7 },
            { id: 'never', title: 'C' },
            { id: 'soon', title: 'D', coveredThrough: '2026-10-09', intervalDays: 7 },
            { id: 'ok2', title: 'A', coveredThrough: '2026-10-14', intervalDays: 7 },
        ];
        expect(sortDuties(duties, today).map((d) => d.id)).toEqual(['late5', 'late1', 'never', 'soon', 'ok2', 'ok']);
    });
});

describe('validateDutyMark', () => {
    it('accepts past, today and future dates (work entered in advance); rejects a missing date', () => {
        expect(validateDutyMark('2026-10-16', '2026-10-16')).toBeNull();
        expect(validateDutyMark('2026-10-01', '2026-10-16')).toBeNull();
        expect(validateDutyMark('2026-10-24', '2026-10-16')).toBeNull();
        expect(validateDutyMark('', '2026-10-16')).toMatch(/datą/);
    });

    it('rejects an over-long note', () => {
        expect(validateDutyMark('2026-10-16', '2026-10-16', 'x'.repeat(501))).toMatch(/per ilga/);
    });
});

describe('validateDutyFields', () => {
    it('requires a title, a known cadence and an owner', () => {
        expect(validateDutyFields({ title: 'Atsiliepimai', intervalDays: 7, ownerId: 'u1' })).toBeNull();
        expect(validateDutyFields({ title: '  ', intervalDays: 7, ownerId: 'u1' })).toMatch(/pavadinimą/);
        expect(validateDutyFields({ title: 'A', intervalDays: 5, ownerId: 'u1' })).toMatch(/dažnumą/);
        expect(validateDutyFields({ title: 'A', intervalDays: 7, ownerId: '' })).toMatch(/asmenį/);
    });
});
