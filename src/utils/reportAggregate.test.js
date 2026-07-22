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

describe('buildReport — multi-tariff earnings (bill each task by the tariff the manager chose)', () => {
    // A meistras with two NAMED tariffs. PayRateModal mirrors the FIRST one into the legacy `tiers`
    // field, so `payRate.tiers` is the default/cheap table — pricing a period off it under-paid
    // every hour worked on a task the manager assigned the expensive tariff to.
    const multiRate = {
        tiers: [{ fromHours: 0, netRate: 10 }], // legacy mirror of rates[0]
        rates: [
            { id: 'r-statyba', label: 'Statyba', tiers: [{ fromHours: 0, netRate: 10 }] },
            { id: 'r-griovimas', label: 'Griovimas', tiers: [{ fromHours: 0, netRate: 25 }] },
        ],
    };
    const window = { startStr: '2026-06-01', endStr: '2026-06-30' };
    const prevWindow = { startStr: '2026-05-02', endStr: '2026-05-31' };

    it('prices demolition hours at the demolition tariff, not the default one', () => {
        const worker = baseWorker({
            payRate: multiRate,
            workSessions: [{ ...session('2026-06-10', 10), taskId: 'task-demo' }],
            taskPayRateIds: { 'task-demo': 'r-griovimas' },
        });
        const report = buildOne(worker, window, prevWindow);
        expect(report.workers[0].earnings.netEur).toBe(250); // 10 h @ €25, NOT 10 h @ €10
    });

    it('mixes tariffs within one month and leaves an unknown task on the default tariff', () => {
        // 4 h demolition (@25 = 100) + 4 h on a task with no chosen tariff (@10 = 40) = 140 €.
        const worker = baseWorker({
            payRate: multiRate,
            workSessions: [
                { ...session('2026-06-10', 4), taskId: 'task-demo' },
                { ...session('2026-06-11', 4), taskId: 'quick_1720000000000' },
            ],
            taskPayRateIds: { 'task-demo': 'r-griovimas' },
        });
        const report = buildOne(worker, window, prevWindow);
        expect(report.workers[0].earnings.netEur).toBe(140);
    });

    it('carries the same per-task tariff into the payroll CSV money column', () => {
        const worker = baseWorker({
            payRate: multiRate,
            workSessions: [{ ...session('2026-06-10', 10), taskId: 'task-demo' }],
            taskPayRateIds: { 'task-demo': 'r-griovimas' },
        });
        const visoCells = renderTimesheetCSV([worker], window, { includeEarnings: true })
            .split('\n')
            .find((l) => l.includes(',Viso,'))
            .split(',');
        expect(visoCells[6]).toBe('250');
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

    // Triage sweep #9: a manual deduction can net a day/period negative; the payroll cell must show a
    // real minus, not the abs'd positive that reads as worked time (and not a '+' on normal positives).
    it('Timesheet CSV renders a net-negative day and total with a real minus sign', () => {
        const deducted = baseWorker({
            workSessions: [
                session('2026-06-10', 1), // +1h worked
                { date: '2026-06-10', durationMinutes: -180, isManualAdjustment: true,
                  startTime: '2026-06-10T08:00:00.000Z', endTime: '2026-06-10T08:00:00.000Z' }, // -3h correction
            ],
        });
        const lines = renderTimesheetCSV([deducted], window).split('\n');
        expect(lines.find((l) => /,2026-06-10,/.test(l)).split(',')[2]).toBe('-02:00');
        expect(lines.find((l) => l.includes(',Viso,')).split(',')[2]).toBe('-02:00');
    });

    // A plain task's hand-entered manualMinutes is additive worked time with no work_sessions row.
    // The on-screen day view has always counted it; the payroll CSV summed sessions only, so the
    // downloaded timesheet reported fewer hours than the screen it was exported from.
    it('Timesheet CSV counts a finished plain task\'s manualMinutes on its finish day', () => {
        const withManual = baseWorker({
            workSessions: [session('2026-06-10', 2)],
            tasks: [{ id: 'tm1', manualMinutes: 90, completedAt: '2026-06-10T12:00:00.000Z' }],
        });
        const lines = renderTimesheetCSV([withManual], window).split('\n');
        expect(lines.find((l) => /,2026-06-10,/.test(l)).split(',')[2]).toBe('03:30'); // 2h + 1h30
        expect(lines.find((l) => l.includes(',Viso,')).split(',')[2]).toBe('03:30');
    });

    it('Timesheet CSV never double-counts quick-work / re-derived task minutes', () => {
        // Quick-work and call tasks already log a dedicated work_session of the same length, and a
        // timeChanged task had its time re-derived INTO work_sessions — counting either again doubles it.
        const noDouble = baseWorker({
            workSessions: [session('2026-06-10', 2)],
            tasks: [
                { id: 'q1', manualMinutes: 45, isQuickWork: true, completedAt: '2026-06-10T12:00:00.000Z' },
                { id: 'c1', manualMinutes: 20, isSystemTask: true, completedAt: '2026-06-10T12:00:00.000Z' },
                { id: 'e1', manualMinutes: 60, timeChanged: true, completedAt: '2026-06-10T12:00:00.000Z' },
            ],
        });
        const lines = renderTimesheetCSV([noDouble], window).split('\n');
        expect(lines.find((l) => l.includes(',Viso,')).split(',')[2]).toBe('02:00');
    });

    it('Timesheet CSV renders a normal positive day with no leading + sign', () => {
        const dayCells = renderTimesheetCSV([worker], window)
            .split('\n').find((l) => /,2026-06-10,/.test(l)).split(',');
        expect(dayCells[2]).toBe('08:00');
        expect(dayCells[2]).not.toContain('+');
    });
});
