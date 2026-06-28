import { describe, it, expect } from 'vitest';
import {
    MAX_SESSION_MINUTES,
    clampSessionMinutes,
    parseTimeStringToMinutes,
    getLithuanianDateString,
    getLithuanian3AMCutoff,
    getCurrentWorkDayCutoff,
    addDaysToDateString,
    calculateCurrentTotalMinutes,
    formatMinutesToHHMM,
    formatSignedMinutesToHHMM,
    vilniusWallClockToISO,
    relativeDeadline,
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

describe('getCurrentWorkDayCutoff (work-day flips at 03:00 Vilnius, device-tz-independent)', () => {
    it('keeps TODAY when the instant is past 03:00 Vilnius even if the device-local hour is < 3', () => {
        // 01:30 UTC on a winter day is 03:30 Vilnius (UTC+2) — i.e. just AFTER today's 03:00
        // cutoff, so the work day is TODAY (2026-01-15). The old getHours() < 3 test read the
        // DEVICE-local hour, which is < 3 on UTC-1..UTC+1 devices for this instant and wrongly
        // rolled the cutoff back to yesterday. The DST-safe Vilnius comparison must not.
        const now = new Date('2026-01-15T01:30:00Z');
        expect(getCurrentWorkDayCutoff(now).toISOString()).toBe('2026-01-15T01:00:00.000Z');
    });

    it('rolls back to YESTERDAY when the instant is before today\'s 03:00 Vilnius', () => {
        // 00:30 UTC on a winter day is 02:30 Vilnius — still BEFORE 03:00, so the work day is
        // the previous calendar day (2026-01-14), whose 03:00 cutoff is 2026-01-14T01:00 UTC.
        const now = new Date('2026-01-15T00:30:00Z');
        expect(getCurrentWorkDayCutoff(now).toISOString()).toBe('2026-01-14T01:00:00.000Z');
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

describe('calculateCurrentTotalMinutes — credit composition & skew (ghost-time hardening)', () => {
    it('does NOT double-count the actualTime fallback after a manual time edit (timeChanged guard)', () => {
        // After an admin edits the task total, manual/timer read 0 but actualTime still holds the
        // OLD string. timeChanged short-circuits the fallback so the edited value is not re-added.
        expect(
            calculateCurrentTotalMinutes({ manualMinutes: 0, timerMinutes: 0, timeChanged: true, actualTime: '5h' })
        ).toBe(0);
        // Without the flag the same shape DOES fall back — proving the flag is what suppresses it.
        expect(
            calculateCurrentTotalMinutes({ manualMinutes: 0, timerMinutes: 0, actualTime: '5h' })
        ).toBe(300);
    });

    it('sums manual + timer + explicit adjustments + a live running interval together', () => {
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const total = calculateCurrentTotalMinutes({
            manualMinutes: 100,
            timerMinutes: 20,
            timeAdjustments: [{ durationMinutes: 15 }, { durationMinutes: -5 }],
            timerStatus: 'running',
            timerStartedAt: tenMinAgo,
        });
        // 100 + 20 + (15 - 5) = 130 base, plus ~10 live minutes.
        expect(total).toBeGreaterThan(139.5);
        expect(total).toBeLessThan(141);
    });

    it('ignores an unparseable timerStartedAt instead of poisoning the total with NaN', () => {
        expect(
            calculateCurrentTotalMinutes({ manualMinutes: 42, timerStatus: 'running', timerStartedAt: 'not-a-date' })
        ).toBe(42);
    });

    it('does not add the running interval unless timerStatus is exactly "running"', () => {
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        // Same stale timestamp, but paused -> the interval must not be credited live.
        expect(
            calculateCurrentTotalMinutes({ manualMinutes: 30, timerStatus: 'paused', timerStartedAt: hourAgo })
        ).toBe(30);
    });
});

describe('formatMinutesToHHMM (carry-the-minute, payroll CSV)', () => {
    it('carries a [59.5, 60) minute remainder into the hour instead of printing ":60"', () => {
        // The exact regression: 3h59m30s used to render "03:60".
        expect(formatMinutesToHHMM(239.5)).toBe('04:00');
        expect(formatMinutesToHHMM(599.5)).toBe('10:00');
        expect(formatMinutesToHHMM(59.5)).toBe('01:00');
        // The minute field is never 60 for any input.
        for (let m = 0; m <= 720; m += 0.5) {
            expect(formatMinutesToHHMM(m).endsWith(':60')).toBe(false);
        }
    });

    it('zero-pads hours and minutes', () => {
        expect(formatMinutesToHHMM(0)).toBe('00:00');
        expect(formatMinutesToHHMM(5)).toBe('00:05');
        expect(formatMinutesToHHMM(65)).toBe('01:05');
        expect(formatMinutesToHHMM(600)).toBe('10:00');
    });

    it('rounds to the nearest whole minute', () => {
        expect(formatMinutesToHHMM(90.4)).toBe('01:30');
        expect(formatMinutesToHHMM(90.6)).toBe('01:31');
    });

    it('renders magnitude only (sign is dropped) and guards junk input', () => {
        expect(formatMinutesToHHMM(-90)).toBe('01:30');
        expect(formatMinutesToHHMM(NaN)).toBe('00:00');
        expect(formatMinutesToHHMM(Infinity)).toBe('00:00');
        expect(formatMinutesToHHMM(null)).toBe('00:00');
        expect(formatMinutesToHHMM(undefined)).toBe('00:00');
    });
});

describe('formatSignedMinutesToHHMM (difference columns)', () => {
    it('prefixes a sign and carries the minute', () => {
        expect(formatSignedMinutesToHHMM(239.5)).toBe('+04:00');
        expect(formatSignedMinutesToHHMM(-239.5)).toBe('-04:00');
    });

    it('renders zero unsigned', () => {
        expect(formatSignedMinutesToHHMM(0)).toBe('00:00');
        expect(formatSignedMinutesToHHMM(0.2)).toBe('00:00');
    });

    it('guards non-finite input', () => {
        expect(formatSignedMinutesToHHMM(NaN)).toBe('00:00');
        expect(formatSignedMinutesToHHMM(Infinity)).toBe('00:00');
    });
});

describe('relativeDeadline (Vilnius-day bucketed, colour-coded)', () => {
    // `now` is injected so the buckets are deterministic without mocking the clock. The reference
    // is a mid-day UTC instant, which is the same Vilnius calendar day in both winter and summer.
    const now = new Date('2026-06-23T12:00:00Z'); // Vilnius day 2026-06-23

    it('returns null when there is no deadline', () => {
        expect(relativeDeadline(null, now)).toBeNull();
        expect(relativeDeadline(undefined, now)).toBeNull();
        expect(relativeDeadline('', now)).toBeNull();
    });

    it('labels today as "Šiandien" with the warning tone', () => {
        expect(relativeDeadline('2026-06-23', now)).toEqual({ label: 'Šiandien', tone: 'warning' });
    });

    it('labels tomorrow as "Rytoj" with no urgency colour (neutral)', () => {
        expect(relativeDeadline('2026-06-24', now)).toEqual({ label: 'Rytoj', tone: 'neutral' });
    });

    it('labels an overdue deadline as "Vėluoja N d." with the danger tone', () => {
        expect(relativeDeadline('2026-06-22', now)).toEqual({ label: 'Vėluoja 1 d.', tone: 'danger' });
        expect(relativeDeadline('2026-06-20', now)).toEqual({ label: 'Vėluoja 3 d.', tone: 'danger' });
        // Crosses a month boundary (overdue count keeps stepping by calendar days).
        expect(relativeDeadline('2026-05-31', now)).toEqual({ label: 'Vėluoja 23 d.', tone: 'danger' });
    });

    it('shows a zero-padded "MM.DD d." date for deadlines 2+ days out (neutral)', () => {
        expect(relativeDeadline('2026-06-25', now)).toEqual({ label: '06.25 d.', tone: 'neutral' });
        expect(relativeDeadline('2026-12-01', now)).toEqual({ label: '12.01 d.', tone: 'neutral' });
    });

    it('buckets by the Vilnius calendar day, not the raw UTC day', () => {
        // 23:30 UTC on Jun 22 is 02:30 Vilnius on Jun 23 (summer, UTC+3) — i.e. TODAY, not overdue.
        expect(relativeDeadline('2026-06-22T23:30:00Z', now)).toEqual({ label: 'Šiandien', tone: 'warning' });
        // 22:30 UTC on Jun 23 is 01:30 Vilnius on Jun 24 — i.e. TOMORROW.
        expect(relativeDeadline('2026-06-23T22:30:00Z', now)).toEqual({ label: 'Rytoj', tone: 'neutral' });
    });

    it('echoes an unparseable deadline verbatim with the neutral tone', () => {
        expect(relativeDeadline('not-a-date', now)).toEqual({ label: 'not-a-date', tone: 'neutral' });
    });
});

describe('vilniusWallClockToISO (Vilnius wall-clock -> UTC ISO, DST-safe)', () => {
    // The admin session editor types a Vilnius local day + clock; this is the inverse of the
    // getLithuanianDateString()/HH:MM pair the UI renders. The offset is read from a noon
    // reference (never inside the spring-forward gap), so summer credits UTC+3 and winter UTC+2.
    it('applies the summer offset (UTC+3): subtracts 3h', () => {
        expect(vilniusWallClockToISO('2026-06-23', '14:30')).toBe('2026-06-23T11:30:00.000Z');
    });

    it('applies the winter offset (UTC+2): subtracts 2h', () => {
        expect(vilniusWallClockToISO('2026-01-15', '14:30')).toBe('2026-01-15T12:30:00.000Z');
    });

    it('rolls back across the UTC day boundary when the local hour underflows', () => {
        // 01:00 Vilnius summer is 22:00 UTC the PREVIOUS day (01:00 - 3h).
        expect(vilniusWallClockToISO('2026-06-23', '01:00')).toBe('2026-06-22T22:00:00.000Z');
    });

    // Round-trip: rendering a stored UTC instant as the Vilnius (day, HH:MM) the admin sees and
    // feeding it straight back must reproduce the exact same instant — otherwise an untouched
    // edit would silently shift the time by the Vilnius offset. The HH:MM derivation mirrors the
    // Intl formatting the UI uses to display a session's clock.
    const vilniusHHMM = (date) => {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Vilnius',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(date);
        let hh = parts.find((p) => p.type === 'hour').value;
        const mm = parts.find((p) => p.type === 'minute').value;
        if (hh === '24') hh = '00'; // some runtimes render midnight as "24"
        return `${hh}:${mm}`;
    };

    it('round-trips getLithuanianDateString + the Intl HH:MM derivation back to the same instant', () => {
        const instants = [
            '2026-06-23T11:30:00.000Z', // summer, mid-day Vilnius (14:30)
            '2026-01-15T12:30:00.000Z', // winter, mid-day Vilnius (14:30)
            '2026-06-23T22:00:00.000Z', // summer, crosses into the NEXT Vilnius day (01:00)
            '2026-07-10T05:07:00.000Z', // arbitrary summer instant
            '2026-02-28T19:43:00.000Z', // arbitrary winter instant
        ];
        for (const iso of instants) {
            const d = new Date(iso);
            const dateStr = getLithuanianDateString(d);
            const timeStr = vilniusHHMM(d);
            expect(vilniusWallClockToISO(dateStr, timeStr)).toBe(iso);
        }
    });

    it('returns null on malformed date/time shape', () => {
        expect(vilniusWallClockToISO('2026-6-23', '14:30')).toBeNull(); // month not 2-digit
        expect(vilniusWallClockToISO('2026-06-23', '14')).toBeNull(); // no minutes
        expect(vilniusWallClockToISO('2026-06-23', '1430')).toBeNull(); // no colon
        expect(vilniusWallClockToISO('garbage', '14:30')).toBeNull();
        expect(vilniusWallClockToISO('2026-06-23', 'garbage')).toBeNull();
    });

    it('returns null on out-of-range date/time components', () => {
        expect(vilniusWallClockToISO('2026-13-01', '14:30')).toBeNull(); // month 13
        expect(vilniusWallClockToISO('2026-00-10', '14:30')).toBeNull(); // month 0
        expect(vilniusWallClockToISO('2026-06-32', '14:30')).toBeNull(); // day 32
        expect(vilniusWallClockToISO('2026-06-00', '14:30')).toBeNull(); // day 0
        expect(vilniusWallClockToISO('2026-06-23', '25:00')).toBeNull(); // hour 25
        expect(vilniusWallClockToISO('2026-06-23', '14:60')).toBeNull(); // minute 60
    });

    it('returns null on non-string input', () => {
        expect(vilniusWallClockToISO(null, '14:30')).toBeNull();
        expect(vilniusWallClockToISO('2026-06-23', null)).toBeNull();
        expect(vilniusWallClockToISO(undefined, undefined)).toBeNull();
        expect(vilniusWallClockToISO(20260623, 1430)).toBeNull();
    });
});
