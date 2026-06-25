import { describe, it, expect } from 'vitest';
import { buildReport, renderReportMarkdown, renderReportJSON, renderTimesheetCSV } from './reportAggregate';

// A worked session shaped like a Firestore work_sessions doc (only the fields the aggregator reads).
const session = (date, hours) => ({
    date,
    durationMinutes: hours * 60,
    startTime: `${date}T08:00:00.000Z`,
    endTime: `${date}T${String(8 + Math.min(hours, 12)).padStart(2, '0')}:00:00.000Z`,
});

// Tier boundary at 20 h keeps the month-crossing test small enough that every session stays
// under the 16 h session clamp (sanitizeReportMinutes) — real sessions never exceed a day.
const baseWorker = (over) => ({
    userId: 'u1',
    name: 'Test Worker',
    expectedWeeklyHours: 40,
    payRate: { tiers: [{ fromHours: 0, netRate: 10 }, { fromHours: 20, netRate: 15 }] },
    workSessions: [],
    breakSessions: [],
    plannedShifts: [],
    tasks: [],
    calendarRequests: null,
    recognition: null,
    ...over,
});

const buildOne = (worker, window, prevWindow, includeEarnings = true) =>
    buildReport({
        generatedAt: '2026-06-23 12:00:00',
        window,
        prevWindow,
        scopeLabel: '1 vykdytojas',
        includeEarnings,
        workers: [worker],
    });

describe('buildReport — period earnings (marginal over cumulative monthly hours)', () => {
    it('prices a single in-month period within the first tier', () => {
        // 10 h + 8 h = 18 h, all below the 20 h tier boundary → 18 h @ €10 = 180 €.
        const worker = baseWorker({ workSessions: [session('2026-06-10', 10), session('2026-06-11', 8)] });
        const report = buildOne(
            worker,
            { startStr: '2026-06-01', endStr: '2026-06-30' },
            { startStr: '2026-05-02', endStr: '2026-05-31' }
        );
        expect(report.workers[0].earnings.netEur).toBe(180);
        expect(report.workers[0].earnings.grossEur).toBeGreaterThan(180);
    });

    it('seeds the tier walk with prior-in-month hours and splits across a month boundary', () => {
        // Period crosses May→June. May already had 14 h before the window (seeds the tier walk);
        // in-window May adds 8 h (14→22 → 6 h @10 + 2 h @15 = 90 €). June starts fresh at zero
        // cumulative: 10 h @10 = 100 €. Correct = 190 €. A naive period-sum that ignores the prior
        // hours would price all 18 in-window hours at €10 = 180 € — silently 10 € short.
        const worker = baseWorker({
            workSessions: [
                session('2026-05-10', 14), // prior in-month, before the window
                session('2026-05-28', 8), //  in-window, May
                session('2026-06-03', 10), // in-window, June
            ],
        });
        const report = buildOne(
            worker,
            { startStr: '2026-05-25', endStr: '2026-06-05' },
            { startStr: '2026-05-13', endStr: '2026-05-24' }
        );
        expect(report.workers[0].earnings.netEur).toBe(190);
    });

    it('omits earnings when the worker has no pay rate', () => {
        const worker = baseWorker({ payRate: null, workSessions: [session('2026-06-10', 20)] });
        const report = buildOne(
            worker,
            { startStr: '2026-06-01', endStr: '2026-06-30' },
            { startStr: '2026-05-02', endStr: '2026-05-31' }
        );
        expect(report.workers[0].earnings).toBeNull();
    });

    it('omits earnings entirely when includeEarnings is false', () => {
        const worker = baseWorker({ workSessions: [session('2026-06-10', 50)] });
        const report = buildOne(
            worker,
            { startStr: '2026-06-01', endStr: '2026-06-30' },
            { startStr: '2026-05-02', endStr: '2026-05-31' },
            false
        );
        expect(report.workers[0].earnings).toBeNull();
        expect(report.team.netEarningsEur).toBeNull();
    });
});

describe('buildReport — data trust + manifest', () => {
    it('counts edited and implausible sessions inside the window', () => {
        const worker = baseWorker({
            workSessions: [
                { ...session('2026-06-10', 5), edited: true },
                { ...session('2026-06-11', 5), durationMinutes: 5000 }, // > 16 h → implausible
                session('2026-06-12', 5),
            ],
        });
        const report = buildOne(
            worker,
            { startStr: '2026-06-01', endStr: '2026-06-30' },
            { startStr: '2026-05-02', endStr: '2026-05-31' }
        );
        expect(report.workers[0].dataTrust.editedSessions).toBe(1);
        expect(report.workers[0].dataTrust.implausibleSessions).toBe(1);
    });

    it('carries a schema version, timezone and assumptions manifest', () => {
        const report = buildOne(
            baseWorker({}),
            { startStr: '2026-06-01', endStr: '2026-06-30' },
            { startStr: '2026-05-02', endStr: '2026-05-31' }
        );
        expect(report.schemaVersion).toBeGreaterThanOrEqual(1);
        expect(report.manifest.timezone).toBe('Europe/Vilnius');
        expect(report.manifest.assumptions.length).toBeGreaterThan(0);
    });
});

describe('buildReport — consistent clamp policy (totalHours == earnings == data-trust)', () => {
    it('clamps an over-16h manual-adjustment session everywhere: 16h total, 16h-priced, and flagged', () => {
        // A legacy isManualAdjustment row of 1200 min (20h). Earnings must price the CLAMPED 16h
        // (not 20h), and the same row must be flagged implausible — so the three numbers agree.
        const worker = baseWorker({
            payRate: { tiers: [{ fromHours: 0, netRate: 10 }] },
            workSessions: [
                {
                    date: '2026-06-10',
                    durationMinutes: 1200,
                    isManualAdjustment: true,
                    startTime: '2026-06-10T08:00:00.000Z',
                    endTime: '2026-06-10T08:00:00.000Z',
                },
            ],
        });
        const report = buildOne(
            worker,
            { startStr: '2026-06-01', endStr: '2026-06-30' },
            { startStr: '2026-05-02', endStr: '2026-05-31' }
        );
        expect(report.workers[0].earnings.netEur).toBe(160); // 16h clamped * €10, NOT 20h
        expect(report.workers[0].dataTrust.implausibleSessions).toBe(1);
        expect(report.workers[0].metrics.totalHours.formatted).toBe('16h');
    });

    it('does not let a negative manual-adjustment prior row lower the cumulative tier seed', () => {
        // Prior-in-month: 18h normal (clamps to 16h) + a -10h manual correction (must clamp to 0,
        // NOT pass through and drop the seed). In-window 6h then prices at 16→22 = 4h@10 + 2h@15 = 70.
        const worker = baseWorker({
            workSessions: [
                session('2026-06-05', 18),
                {
                    date: '2026-06-08',
                    durationMinutes: -600,
                    isManualAdjustment: true,
                    startTime: '2026-06-08T08:00:00.000Z',
                    endTime: '2026-06-08T08:00:00.000Z',
                },
                session('2026-06-20', 6),
            ],
        });
        const report = buildOne(
            worker,
            { startStr: '2026-06-15', endStr: '2026-06-30' },
            { startStr: '2026-05-30', endStr: '2026-06-14' }
        );
        expect(report.workers[0].earnings.netEur).toBe(70);
    });
});

describe('buildReport — clock metrics carry no relative delta', () => {
    it('emits a null delta for a clock-of-day metric (avgStart)', () => {
        const worker = baseWorker({ workSessions: [session('2026-06-10', 8), session('2026-05-10', 8)] });
        const report = buildOne(
            worker,
            { startStr: '2026-06-01', endStr: '2026-06-30' },
            { startStr: '2026-05-01', endStr: '2026-05-31' }
        );
        expect(report.workers[0].metrics.avgStart.delta).toBeNull();
    });
});

describe('renderers', () => {
    const window = { startStr: '2026-06-01', endStr: '2026-06-30' };
    const prevWindow = { startStr: '2026-05-02', endStr: '2026-05-31' };
    const worker = baseWorker({ workSessions: [session('2026-06-10', 8), session('2026-06-11', 5)] });
    const report = buildOne(worker, window, prevWindow);

    it('Markdown includes the worker name and the reading-guide header', () => {
        const md = renderReportMarkdown(report);
        expect(md).toContain('# Gildijos veiklos ataskaita');
        expect(md).toContain('Test Worker');
        expect(md).toContain('Skaitymo gairės modeliui');
    });

    it('Markdown omits the daily log by default and includes it (labeled) when requested', () => {
        expect(renderReportMarkdown(report)).not.toContain('Dienų išklotinė');
        const withDaily = renderReportMarkdown(
            buildReport({ generatedAt: 'x', window, prevWindow, scopeLabel: 's', includeEarnings: true, includeDaily: true, workers: [worker] })
        );
        expect(withDaily).toContain('Dienų išklotinė (faktai, ne išvada)');
        expect(withDaily).toContain('2026-06-10');
    });

    it('JSON carries the per-day array only when includeDaily is on', () => {
        expect(JSON.parse(renderReportJSON(report)).workers[0].daily).toBeUndefined();
        const withDaily = buildReport({ generatedAt: 'x', window, prevWindow, scopeLabel: 's', includeEarnings: true, includeDaily: true, workers: [worker] });
        expect(JSON.parse(renderReportJSON(withDaily)).workers[0].daily).toHaveLength(2);
    });

    it('Timesheet CSV has the per-day header, one row per worked day, and a Viso total', () => {
        const csv = renderTimesheetCSV([worker], window);
        const header = csv.split('\n')[0];
        expect(header).toContain('Meistras');
        expect(header).toContain('Data');
        expect(header).toContain('Skirtumas (val:min)');
        expect(csv).toContain('2026-06-10');
        expect(csv).toContain('2026-06-11');
        expect(csv).toContain('Viso');
    });

    it('Timesheet CSV omits the money columns entirely when includeEarnings is off', () => {
        const csv = renderTimesheetCSV([worker], window);
        const header = csv.split('\n')[0];
        expect(header).not.toContain('Neto (€)');
        expect(header).not.toContain('Bruto (€)');
        // Every row keeps the base 6-column width — no trailing money cells.
        csv.replace(/^\uFEFF/, '')
            .split('\n')
            .forEach((line) => expect(line.split(',').length).toBe(6));
    });

    it('Timesheet CSV adds Neto/Bruto columns, populated only on the Viso row', () => {
        // 8h + 5h = 13h @ €10 (under the 20h tier) → 130 € neto; gross is higher.
        const csv = renderTimesheetCSV([worker], window, { includeEarnings: true });
        const lines = csv.replace(/^\uFEFF/, '').split('\n');
        const header = lines[0].split(',');
        expect(header).toContain('Neto (€)');
        expect(header).toContain('Bruto (€)');
        expect(header.length).toBe(8);

        const dayLines = lines.filter((l) => /,2026-06-1[01],/.test(l));
        expect(dayLines).toHaveLength(2);
        // Daily rows pad the two money columns blank (trailing ",,") — money must NOT appear per day.
        dayLines.forEach((l) => {
            const cells = l.split(',');
            expect(cells.length).toBe(8);
            expect(cells[6]).toBe('');
            expect(cells[7]).toBe('');
        });

        const visoLine = lines.find((l) => l.includes(',Viso,'));
        const visoCells = visoLine.split(',');
        expect(visoCells.length).toBe(8);
        expect(visoCells[6]).toBe('130'); // Neto
        expect(Number(visoCells[7])).toBeGreaterThan(130); // Bruto > Neto
    });

    it('Timesheet CSV leaves money cells blank on the Viso row when the worker has no pay rate', () => {
        const noRate = baseWorker({ payRate: null, workSessions: [session('2026-06-10', 8)] });
        const csv = renderTimesheetCSV([noRate], window, { includeEarnings: true });
        const lines = csv.replace(/^\uFEFF/, '').split('\n');
        expect(lines[0].split(',').length).toBe(8); // header still widened
        const visoCells = lines.find((l) => l.includes(',Viso,')).split(',');
        expect(visoCells.length).toBe(8);
        expect(visoCells[6]).toBe('');
        expect(visoCells[7]).toBe('');
    });

    it('Timesheet CSV money values are plain integers needing no CSV escaping', () => {
        // Euro cells carry only digits (Math.round'd integers), so they stay unquoted — the field
        // count is stable and a euro figure never spills into an adjacent column.
        const csv = renderTimesheetCSV([worker], window, { includeEarnings: true });
        const visoCells = csv.replace(/^\uFEFF/, '').split('\n').find((l) => l.includes(',Viso,')).split(',');
        expect(visoCells[6]).toMatch(/^\d+$/);
        expect(visoCells[7]).toMatch(/^\d+$/);
        expect(visoCells[6]).not.toContain('"');
        expect(visoCells[7]).not.toContain('"');
    });
});
