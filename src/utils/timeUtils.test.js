import { describe, it, expect } from 'vitest';
import {
    MAX_SESSION_MINUTES,
    clampSessionMinutes,
    parseTimeStringToMinutes,
    getLithuanianDateString,
    getLithuanian3AMCutoff,
    addDaysToDateString,
    calculateCurrentTotalMinutes,
} from './timeUtils';

// These are characterization tests for the pure time-math + timezone helpers that the
// 2026-06-21 fix pass changed. They pin behavior so a future refactor of the hours math
// (the thing people are paid by) can't silently regress. No clock mocking is needed:
// every function either takes its time as an argument or is exercised with deltas whose
// clamp boundaries are deterministic.

describe('clampSessionMinutes (ghost-time guard)', () => {
    it('exposes a 16h ceiling', () => {
        expect(MAX_SESSION_MINUTES).toBe(16 * 60);
        expect(MAX_SESSION_MINUTES).toBe(960);
    });

    it('collapses negative / non-finite deltas to 0 (backward clock, future start)', () => {
        expect(clampSessionMinutes(-5)).toBe(0);
        expect(clampSessionMinutes(-0.001)).toBe(0);
        expect(clampSessionMinutes(NaN)).toBe(0);
        expect(clampSessionMinutes(Infinity)).toBe(0);
        expect(clampSessionMinutes(-Infinity)).toBe(0);
    });

    it('passes plausible values through unchanged', () => {
        expect(clampSessionMinutes(0)).toBe(0);
        expect(clampSessionMinutes(30)).toBe(30);
        expect(clampSessionMinutes(123.456)).toBeCloseTo(123.456, 5);
        expect(clampSessionMinutes(MAX_SESSION_MINUTES)).toBe(MAX_SESSION_MINUTES);
    });

    it('caps an implausibly large value at the ceiling (orphaned/skewed interval)', () => {
        expect(clampSessionMinutes(961)).toBe(960);
        expect(clampSessionMinutes(2000)).toBe(960);
        expect(clampSessionMinutes(60 * 1000)).toBe(960);
    });
});

describe('parseTimeStringToMinutes (anchored, malformed -> 0)', () => {
    it('parses well-formed hour/minute strings', () => {
        expect(parseTimeStringToMinutes('1h')).toBe(60);
        expect(parseTimeStringToMinutes('30m')).toBe(30);
        expect(parseTimeStringToMinutes('1h 30m')).toBe(90);
        expect(parseTimeStringToMinutes('2val')).toBe(120); // 'val' is the hour unit
        expect(parseTimeStringToMinutes('45min')).toBe(45);
    });

    it('treats comma as the decimal separator', () => {
        expect(parseTimeStringToMinutes('1,5h')).toBe(90);
        expect(parseTimeStringToMinutes('0,5h')).toBe(30);
    });

    it('normalizes case and surrounding whitespace', () => {
        expect(parseTimeStringToMinutes('1H')).toBe(60);
        expect(parseTimeStringToMinutes('  1h 30m  ')).toBe(90);
    });

    it('rejects malformed input to 0 rather than partial-matching', () => {
        expect(parseTimeStringToMinutes('-30m')).toBe(0);
        expect(parseTimeStringToMinutes('2h 2h')).toBe(0);
        expect(parseTimeStringToMinutes('30.5m')).toBe(0); // minutes must be integer
        expect(parseTimeStringToMinutes('10m20m')).toBe(0);
        expect(parseTimeStringToMinutes('abc')).toBe(0);
    });

    it('guards non-string and empty input', () => {
        expect(parseTimeStringToMinutes(null)).toBe(0);
        expect(parseTimeStringToMinutes(undefined)).toBe(0);
        expect(parseTimeStringToMinutes(123)).toBe(0);
        expect(parseTimeStringToMinutes('')).toBe(0);
    });
});

describe('getLithuanianDateString (Vilnius calendar day)', () => {
    it('buckets a late-UTC instant into the NEXT Vilnius day (winter, UTC+2)', () => {
        // 23:30 UTC on Jan 15 is 01:30 Vilnius on Jan 16.
        expect(getLithuanianDateString(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-16');
    });

    it('buckets a late-UTC instant into the NEXT Vilnius day (summer, UTC+3)', () => {
        // 22:30 UTC on Jul 15 is 01:30 Vilnius on Jul 16.
        expect(getLithuanianDateString(new Date('2026-07-15T22:30:00Z'))).toBe('2026-07-16');
    });

    it('keeps a midday instant on the same day', () => {
        expect(getLithuanianDateString(new Date('2026-03-10T12:00:00Z'))).toBe('2026-03-10');
        expect(getLithuanianDateString(new Date('2026-07-10T12:00:00Z'))).toBe('2026-07-10');
    });

    it('accepts an ISO string as well as a Date', () => {
        expect(getLithuanianDateString('2026-07-15T22:30:00Z')).toBe('2026-07-16');
    });
});

describe('getLithuanian3AMCutoff (03:00 Vilnius as a UTC instant, DST-safe)', () => {
    it('winter date -> 01:00 UTC (offset +2)', () => {
        expect(getLithuanian3AMCutoff('2026-01-15').toISOString()).toBe('2026-01-15T01:00:00.000Z');
    });

    it('summer date -> 00:00 UTC (offset +3)', () => {
        expect(getLithuanian3AMCutoff('2026-07-15').toISOString()).toBe('2026-07-15T00:00:00.000Z');
    });
});

describe('addDaysToDateString (UTC calendar arithmetic, DST-independent)', () => {
    it('crosses month and year boundaries', () => {
        expect(addDaysToDateString('2026-01-31', 1)).toBe('2026-02-01');
        expect(addDaysToDateString('2026-12-31', 1)).toBe('2027-01-01');
    });

    it('subtracts days', () => {
        expect(addDaysToDateString('2026-03-01', -1)).toBe('2026-02-28');
    });

    it('handles leap day', () => {
        expect(addDaysToDateString('2024-02-28', 1)).toBe('2024-02-29');
        expect(addDaysToDateString('2024-03-01', -1)).toBe('2024-02-29');
    });

    it('defaults to +1 day', () => {
        expect(addDaysToDateString('2026-06-15')).toBe('2026-06-16');
    });
});

describe('calculateCurrentTotalMinutes', () => {
    it('returns 0 for a non-object / missing task', () => {
        expect(calculateCurrentTotalMinutes(null)).toBe(0);
        expect(calculateCurrentTotalMinutes(undefined)).toBe(0);
        expect(calculateCurrentTotalMinutes('nope')).toBe(0);
        expect(calculateCurrentTotalMinutes({})).toBe(0);
    });

    it('sums manual + timer minutes', () => {
        expect(calculateCurrentTotalMinutes({ manualMinutes: 30, timerMinutes: 15 })).toBe(45);
        expect(calculateCurrentTotalMinutes({ timerMinutes: 20 })).toBe(20);
    });

    it('falls back to actualTime / accumulatedMinutes only when the primary total is 0', () => {
        expect(calculateCurrentTotalMinutes({ actualTime: '1h 30m' })).toBe(90);
        expect(calculateCurrentTotalMinutes({ accumulatedMinutes: 45 })).toBe(45);
        // Primary total non-zero -> fallback ignored (no double counting).
        expect(calculateCurrentTotalMinutes({ timerMinutes: 10, actualTime: '1h' })).toBe(10);
    });

    it('adds explicit time adjustments', () => {
        expect(
            calculateCurrentTotalMinutes({
                manualMinutes: 10,
                timeAdjustments: [{ durationMinutes: 5 }, { durationMinutes: 3 }],
            })
        ).toBe(18);
    });

    it('ignores a future timer start (negative elapsed clamps to 0)', () => {
        const future = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
        expect(
            calculateCurrentTotalMinutes({ manualMinutes: 5, timerStatus: 'running', timerStartedAt: future })
        ).toBe(5);
    });

    it('caps a stale running timer at the 16h ceiling (crash-orphan ghost time)', () => {
        const longAgo = new Date(Date.now() - 1000 * 60 * 60 * 1000).toISOString(); // 1000h ago
        expect(
            calculateCurrentTotalMinutes({ timerStatus: 'running', timerStartedAt: longAgo })
        ).toBe(MAX_SESSION_MINUTES);
    });

    it('adds a plausible running interval roughly equal to its elapsed', () => {
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const total = calculateCurrentTotalMinutes({ timerStatus: 'running', timerStartedAt: thirtyMinAgo });
        expect(total).toBeGreaterThan(29.5);
        expect(total).toBeLessThan(31);
    });
});
