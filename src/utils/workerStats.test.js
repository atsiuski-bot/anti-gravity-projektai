import { describe, it, expect } from 'vitest';
import { computeWorkerStats, computeDelta, formatStatValue } from './workerStats';

// All fixture timestamps are in JUNE so the Vilnius wall clock is a FIXED UTC+3 (no DST ambiguity):
// a UTC instant + 3h is the Vilnius hour the compute reads. e.g. 06:00Z -> 09:00 local.
const WINDOW = { startStr: '2026-06-01', endStr: '2026-06-30' };

const RAW = {
    workSessions: [
        // 2026-06-10: 09:00–17:00 local (06:00Z–14:00Z) = 480 min
        { userId: 'w1', date: '2026-06-10', startTime: '2026-06-10T06:00:00Z', endTime: '2026-06-10T14:00:00Z', durationMinutes: 480 },
        // 2026-06-11: 10:00–16:00 local (07:00Z–13:00Z) = 360 min
        { userId: 'w1', date: '2026-06-11', startTime: '2026-06-11T07:00:00Z', endTime: '2026-06-11T13:00:00Z', durationMinutes: 360 },
        // OUT OF WINDOW — must be excluded from every metric.
        { userId: 'w1', date: '2026-05-30', startTime: '2026-05-30T06:00:00Z', endTime: '2026-05-30T10:00:00Z', durationMinutes: 240 },
    ],
    breakSessions: [
        { userId: 'w1', date: '2026-06-10', durationMinutes: 30 },
        { userId: 'w1', date: '2026-06-11', durationMinutes: 30 },
    ],
    tasks: [
        { assignedUserId: 'w1', status: 'confirmed', confirmedAt: '2026-06-10T15:00:00Z', estimatedTime: '2h', manualMinutes: 100, priority: 'HIGH' },
        { assignedUserId: 'w1', status: 'completed', completedAt: '2026-06-11T14:00:00Z', estimatedTime: '1h', manualMinutes: 90, priority: 'LOW' },
        // A quick-work auto-log: must NOT count toward task throughput/quality.
        { assignedUserId: 'w1', status: 'completed', completedAt: '2026-06-11T15:00:00Z', isQuickWork: true, manualMinutes: 20, priority: 'MEDIUM' },
    ],
    plannedShifts: [
        { userId: 'w1', start: '2026-06-10T06:00:00Z', end: '2026-06-10T14:00:00Z' }, // plan 09:00, actual 09:00 -> on time
        { userId: 'w1', start: '2026-06-11T06:00:00Z', end: '2026-06-11T14:00:00Z' }, // plan 09:00, actual 10:00 -> 60 min late
        { userId: 'w1', start: '2026-06-12T06:00:00Z', end: '2026-06-12T14:00:00Z', absenceType: 'sick' }, // absence, not a work shift
    ],
    calendarRequests: [
        { type: 'edit', createdAt: '2026-06-08T08:00:00Z', requestedEvent: { start: '2026-06-20T08:00:00Z' } }, // lead 12d -> not late
        { type: 'delete', createdAt: '2026-06-18T10:00:00Z', requestedEvent: { start: '2026-06-20T08:00:00Z' } }, // lead ~2d -> late
        { type: 'add', createdAt: '2026-06-01T08:00:00Z', requestedEvent: { start: '2026-06-20T08:00:00Z' } }, // 'add' is ignored
    ],
};

describe('computeWorkerStats — volume & rhythm', () => {
    const s = computeWorkerStats(RAW, WINDOW, { expectedWeeklyHours: 40 });

    it('sums worked hours and active days, excluding out-of-window rows', () => {
        expect(s.totalHours).toBe(14); // 480 + 360 min, the 240-min 05-30 row excluded
        expect(s.activeDays).toBe(2);
        expect(s.avgPerDay).toBeCloseTo(7, 5);
    });

    it('derives day length (span minus breaks), span, start and end clock', () => {
        expect(s.avgDayLength).toBeCloseTo(6.5, 5); // (450 + 330) / 2 / 60
        expect(s.avgSpan).toBeCloseTo(7, 5); // (480 + 360) / 2 / 60
        expect(s.avgStart).toBeCloseTo(9.5, 5); // 09:00 & 10:00 local
        expect(s.avgEnd).toBeCloseTo(16.5, 5); // 17:00 & 16:00 local
    });

    it('computes productive share and norm coverage', () => {
        expect(s.productivePct).toBeCloseTo(93.33, 1); // 840 / 900
        expect(s.normCoverage).toBeCloseTo(8.17, 1); // (14 / (30/7)) / 40 * 100
    });
});

describe('computeWorkerStats — distribution (median / quartiles)', () => {
    const s = computeWorkerStats(RAW, WINDOW, {});

    it('returns median and quartiles of day length', () => {
        expect(s.medianDayLength).toBeCloseTo(6.5, 5); // median of [5.5h, 7.5h]
        expect(s.p25DayLength).toBeCloseTo(6, 5);
        expect(s.p75DayLength).toBeCloseTo(7, 5);
    });

    it('returns the median start hour', () => {
        expect(s.medianStart).toBeCloseTo(9.5, 5);
        expect(formatStatValue(s.medianStart, 'clock')).toBe('09:30');
    });
});

describe('computeWorkerStats — tasks (throughput & quality)', () => {
    const s = computeWorkerStats(RAW, WINDOW, {});

    it('counts only real completed tasks (quick-work excluded)', () => {
        expect(s.completedCount).toBe(2);
        expect(s.completedPerDay).toBeCloseTo(1, 5);
        expect(s.avgTaskDuration).toBeCloseTo(95, 5); // (100 + 90) / 2
    });

    it('derives estimate accuracy, on-estimate, approval and priority share', () => {
        expect(s.estimateAccuracyPct).toBeCloseTo(116.67, 1); // mean(100/120, 90/60) * 100
        expect(s.onEstimatePct).toBe(50); // only the 100<=120 task fits
        expect(s.approvalPct).toBe(50); // 1 confirmed of 2
        expect(s.highPriorityPct).toBe(50); // 1 HIGH of 2
    });
});

describe('computeWorkerStats — discipline (punctuality & reschedules)', () => {
    const s = computeWorkerStats(RAW, WINDOW, {});

    it('measures punctuality against planned shift starts', () => {
        expect(s.onTimePct).toBe(50); // 1 of 2 planned days on time
        expect(s.avgLatenessMin).toBeCloseTo(30, 5); // mean(0, 60)
        expect(s.planCoveragePct).toBeCloseTo(87.5, 1); // 840 worked / 960 planned
        expect(s.plannedVsWorkedDaysPct).toBe(100); // both planned work days were worked
    });

    it('counts worker-initiated reschedules and flags the late ones', () => {
        expect(s.reschedules).toBe(2); // edit + delete; 'add' ignored
        expect(s.lateReschedules).toBe(1); // only the <=3d-before one
    });

    it('breaks down absences by type', () => {
        expect(s.absenceDays.value).toBe(1);
        expect(s.absenceDays.sub).toContain('Liga');
    });

    it('returns null reschedules when calendar requests are unavailable', () => {
        const noCal = computeWorkerStats({ ...RAW, calendarRequests: null }, WINDOW, {});
        expect(noCal.reschedules).toBeNull();
        expect(noCal.lateReschedules).toBeNull();
    });
});

describe('computeWorkerStats — breaks & mix', () => {
    const s = computeWorkerStats(RAW, WINDOW, {});

    it('derives break duration, share and count per day', () => {
        expect(s.avgBreakPerDay).toBeCloseTo(30, 5);
        expect(s.breakSharePct).toBeCloseTo(6.67, 1); // 60 / 900
        expect(s.avgBreakCount).toBeCloseTo(1, 5);
    });

    it('splits tracked time across categories', () => {
        const task = s.timeSplit.parts.find((p) => p.key === 'task');
        const brk = s.timeSplit.parts.find((p) => p.key === 'break');
        expect(task.pct).toBeCloseTo(93.33, 1);
        expect(brk.pct).toBeCloseTo(6.67, 1);
    });
});

describe('computeWorkerStats — empty input', () => {
    const s = computeWorkerStats(
        { workSessions: [], breakSessions: [], tasks: [], plannedShifts: [], calendarRequests: [] },
        WINDOW,
        {}
    );

    it('returns null for data-less metrics rather than a fake zero', () => {
        expect(s.totalHours).toBeNull();
        expect(s.activeDays).toBeNull();
        expect(s.avgStart).toBeNull();
        expect(s.medianDayLength).toBeNull();
        expect(s.onTimePct).toBeNull();
        expect(s.timeSplit).toBeNull();
    });
});

describe('computeDelta — semantic direction', () => {
    it('marks a rise in a good-up metric as improved', () => {
        expect(computeDelta(110, 100, 'up')).toMatchObject({ pct: 10, direction: 'up', improved: true });
    });
    it('marks a rise in a good-down metric as a regression', () => {
        expect(computeDelta(110, 100, 'down')).toMatchObject({ pct: 10, direction: 'up', improved: false });
    });
    it('marks a fall in a good-down metric as improved', () => {
        expect(computeDelta(90, 100, 'down')).toMatchObject({ pct: -10, direction: 'down', improved: true });
    });
    it('leaves neutral metrics uncoloured', () => {
        expect(computeDelta(110, 100, 'neutral').improved).toBeNull();
    });
    it('returns null with no usable baseline', () => {
        expect(computeDelta(100, 0, 'up')).toBeNull();
        expect(computeDelta(null, 5, 'up')).toBeNull();
    });
    it('unwraps a { value } composite (e.g. absence days)', () => {
        expect(computeDelta({ value: 3 }, { value: 2 }, 'down')).toMatchObject({ direction: 'up', improved: false });
    });
});

describe('formatStatValue', () => {
    it('formats hours, minutes, percentages, counts, rates and clock', () => {
        expect(formatStatValue(8, 'hours')).toBe('8h');
        expect(formatStatValue(6.5, 'hours')).toBe('6h 30m');
        expect(formatStatValue(0.5, 'hours')).toBe('30m');
        expect(formatStatValue(95, 'minutes')).toBe('1h 35m');
        expect(formatStatValue(30, 'minutes')).toBe('30m');
        expect(formatStatValue(93.3, 'pct')).toBe('93%');
        expect(formatStatValue(2, 'count')).toBe('2');
        expect(formatStatValue(1, 'days')).toBe('1 d.');
        expect(formatStatValue(1, 'rate')).toBe('1.0');
        expect(formatStatValue(9.5, 'clock')).toBe('09:30');
    });
    it('renders an em dash for missing values and unwraps composites', () => {
        expect(formatStatValue(null, 'hours')).toBe('—');
        expect(formatStatValue({ value: 1, sub: 'x' }, 'days')).toBe('1 d.');
    });
});
