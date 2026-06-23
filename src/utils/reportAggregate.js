// Report aggregator — the single "data contract" every export channel consumes.
//
// WHY THIS EXISTS: the old exports dumped raw rows (one worker-day line, or a flat task array) and
// left the LLM to re-derive everything — often wrong (a clamped 960-min orphan reads as a full
// shift). This module instead serializes the CONCLUSION: the ~30 metrics the app already computes
// in workerStats (volume, day-rhythm percentiles, punctuality, plan-coverage, estimate accuracy,
// breaks, time-mix, absence-by-type) WITH period-over-period deltas, plus three signals workerStats
// does not carry (period earnings, the lifetime recognition rollup, a data-trust line). One
// uid-keyed object per worker, under a schemaVersion + assumptions manifest so any model reads it
// cold. Markdown / JSON / CSV are thin renderers over this — see render* below.
//
// PURE: no Firestore / network. The fetch + scope step lives in reportData.js (it genuinely differs
// per SDK); this core is unit-testable in isolation.

import {
    computeWorkerStats,
    computeDelta,
    formatStatValue,
    STAT_GROUPS,
    ON_TIME_GRACE_MIN,
} from './workerStats';
import { marginalNetEarnings, netToGross, EFFECTIVE_TAX_RATE, hasPayRate } from './payRate';
import {
    sanitizeReportMinutes,
    isImplausibleSessionMinutes,
    formatMinutesToHHMM,
    formatSignedMinutesToHHMM,
    getLithuanianDateString,
} from './timeUtils';

// Bumped whenever the serialized shape changes in a way a downstream consumer must notice.
export const REPORT_SCHEMA_VERSION = 1;

// Skirtumas (worked − planned) is meaningful only when the plan plausibly covers the worked span;
// below this fraction the timesheet prints "Nepakanka plano" instead of a fake surplus. Mirrors the
// gate the on-screen plan-coverage indicator uses.
const TIMESHEET_PLAN_FLOOR = 0.25;

// Lifetime recognition counters worth surfacing (subset of users/{uid}/achievements/_stats).
const RECOGNITION_FIELDS = [
    { key: 'completedTasks', label: 'Užbaigta' },
    { key: 'confirmedTasks', label: 'Priimta' },
    { key: 'onEstimate', label: 'Telpa į planą' },
    { key: 'punctualDays', label: 'Punktualių dienų' },
    { key: 'workDays', label: 'Darbo dienų' },
    { key: 'hardTasks', label: 'Sunkių užduočių' },
    { key: 'thorough', label: 'Kruopščių' },
    { key: 'planAheadWeeks', label: 'Suplanuota savaičių' },
];

const firstOfMonthStr = (dateStr) => `${dateStr.slice(0, 7)}-01`;
const monthKey = (dateStr) => dateStr.slice(0, 7);

// Scalar behind a metric value (workerStats returns {value,sub} for absenceDays, {parts} for split).
const scalarOf = (value) =>
    value && typeof value === 'object' && 'value' in value ? value.value : value;

// One human string per metric. 'split' is composite (workerStats kind), so format it explicitly;
// everything else routes through the app's shared formatter so the export reads like the UI.
function formatMetric(value, kind) {
    if (kind === 'split') {
        if (!value || !Array.isArray(value.parts)) return '—';
        return value.parts.map((p) => `${p.label} ${Math.round(p.pct)}%`).join(' · ');
    }
    return formatStatValue(value, kind);
}

// Period earnings, computed MONTH-AWARE because the net rate is marginal over CUMULATIVE monthly
// hours (mirrors EarningsModal). A window crossing a month boundary is split per calendar month;
// for the start month the pre-period hours seed the tier walk, later months start at zero. A naive
// period-sum would silently misprice the tier — so we never do that.
//
// Clamp policy MUST match the report's displayed "Viso dirbta" total (computeWorkerStats clamps
// every session to [0, 16h] with no allowLarge exemption). So we deliberately do NOT pass
// allowLarge here: a legacy isManualAdjustment row over 16h, or a negative correction, is bounded
// to [0, 16h] before it can seed or be priced — otherwise earnings would over-pay (un-clamped
// magnitude) or under-price (a negative prior-month row lowering the cumulative tier seed), and
// disagree with both the report's own hours total and the worker-facing EarningsModal.
function computePeriodEarnings(workSessions, window, tiers) {
    const { startStr, endStr } = window;
    const monthFloor = firstOfMonthStr(startStr);
    const prior = {}; // month -> worked minutes before the window, within the start month
    const inPeriod = {}; // month -> worked minutes inside the window

    for (const s of workSessions) {
        const d = s.date;
        if (!d) continue;
        const min = sanitizeReportMinutes(s.durationMinutes);
        if (d >= monthFloor && d < startStr) {
            prior[monthKey(d)] = (prior[monthKey(d)] || 0) + min;
        } else if (d >= startStr && d <= endStr) {
            inPeriod[monthKey(d)] = (inPeriod[monthKey(d)] || 0) + min;
        }
    }

    let net = 0;
    for (const m of Object.keys(inPeriod)) {
        const priorHours = (prior[m] || 0) / 60;
        const toHours = priorHours + inPeriod[m] / 60;
        net += marginalNetEarnings(priorHours, toHours, tiers);
    }
    if (!(net > 0)) return null;
    return {
        netEur: Math.round(net),
        grossEur: Math.round(netToGross(net)),
        taxPct: Math.round(EFFECTIVE_TAX_RATE * 100),
    };
}

// Data-trust line: how much of this worker's window is edited or implausible (would be silently
// clamped). Lets the brief caveat itself instead of presenting clamped garbage as fact. The
// implausible test uses the SAME 16h ceiling the displayed total and earnings clamp to (no
// allowLarge) — so any session that was capped is flagged here, and the three numbers never
// contradict each other (clamped total + a clean "nothing suspicious" line).
function computeDataTrust(workSessions, breakSessions, window) {
    const { startStr, endStr } = window;
    const inWin = (s) => s.date && s.date >= startStr && s.date <= endStr;
    let edited = 0;
    let implausible = 0;
    for (const s of workSessions) {
        if (!inWin(s)) continue;
        if (s.edited) edited += 1;
        if (isImplausibleSessionMinutes(s.durationMinutes)) implausible += 1;
    }
    for (const s of breakSessions) {
        if (!inWin(s)) continue;
        if (isImplausibleSessionMinutes(s.durationMinutes)) implausible += 1;
    }
    return { editedSessions: edited, implausibleSessions: implausible };
}

// Per-day work/break minutes for one worker, bucketed by Vilnius 'date' within the window.
// `allowLarge` honors manual-adjustment magnitudes (payroll/timesheet convention); leave it false
// for the analysis daily-log so it matches the report's 16h-clamped metrics.
function aggregateDaily(workSessions, breakSessions, window, { allowLarge = false } = {}) {
    const { startStr, endStr } = window;
    const inWin = (d) => d && d >= startStr && d <= endStr;
    const days = {};
    const bump = (date, key, mins) => {
        if (!days[date]) days[date] = { work: 0, break: 0 };
        days[date][key] += mins;
    };
    for (const s of workSessions || []) {
        if (!inWin(s.date)) continue;
        bump(s.date, 'work', sanitizeReportMinutes(s.durationMinutes, { allowLarge: allowLarge && s.isManualAdjustment }));
    }
    for (const s of breakSessions || []) {
        if (!inWin(s.date)) continue;
        bump(s.date, 'break', sanitizeReportMinutes(s.durationMinutes));
    }
    return days;
}

// Planned minutes for one worker over the window: calendar shifts (excluding approved leave),
// falling back to the weeklyExpectedHours baseline × weeks when no calendar plan exists. Mirrors
// Reports.fetchWorkHours so the timesheet's Planuota/Skirtumas match the on-screen figures.
function computePlannedMinutes(plannedShifts, window, expectedWeeklyHours) {
    const { startStr, endStr } = window;
    let planned = 0;
    for (const wh of plannedShifts || []) {
        if (!wh || !wh.start || !wh.end || wh.isVacation) continue;
        const dayStr = getLithuanianDateString(new Date(wh.start));
        if (dayStr < startStr || dayStr > endStr) continue;
        const mins = (new Date(wh.end).getTime() - new Date(wh.start).getTime()) / 60000;
        if (Number.isFinite(mins) && mins > 0) planned += mins;
    }
    planned = Math.round(planned);
    if (planned <= 0 && Number.isFinite(expectedWeeklyHours) && expectedWeeklyHours > 0) {
        const spanDays = Math.max(1, Math.round((Date.parse(`${endStr}T00:00:00Z`) - Date.parse(`${startStr}T00:00:00Z`)) / 86400000) + 1);
        planned = Math.round(expectedWeeklyHours * 60 * (spanDays / 7));
    }
    return planned;
}

// Build the full report object from already-fetched, per-worker-sliced raw data.
//
// input.workers[]: { userId, name, expectedWeeklyHours?, payRate?, recognition?,
//                    workSessions, breakSessions, plannedShifts, tasks, calendarRequests }
// `includeDaily` appends a per-worker daily work/break log (the "evidence" behind the metrics) —
// off by default to keep the analysis lean; turn on for a focused single-worker / short-span pull.
export function buildReport({ generatedAt, window, prevWindow, scopeLabel, includeEarnings, includeDaily = false, workers }) {
    const opts = (w) => ({ expectedWeeklyHours: w.expectedWeeklyHours });

    const builtWorkers = workers.map((w) => {
        const raw = {
            workSessions: w.workSessions || [],
            breakSessions: w.breakSessions || [],
            plannedShifts: w.plannedShifts || [],
            tasks: w.tasks || [],
            calendarRequests: w.calendarRequests || null,
        };
        const current = computeWorkerStats(raw, window, opts(w));
        const previous = computeWorkerStats(raw, prevWindow, opts(w));

        const metricsByKey = {};
        for (const group of STAT_GROUPS) {
            for (const m of group.metrics) {
                const value = current[m.key];
                metricsByKey[m.key] = {
                    label: m.label,
                    kind: m.kind,
                    value: scalarOf(value),
                    raw: value,
                    formatted: formatMetric(value, m.kind),
                    // A clock-of-day metric is an absolute position, not a quantity — a relative %
                    // change of "08:30" is meaningless and an LLM may misread it as a trend, so no
                    // delta for clock metrics. (Quantities keep their period-over-period delta.)
                    delta: m.kind === 'clock' ? null : computeDelta(value, previous[m.key], m.goodWhen),
                };
            }
        }

        const earnings =
            includeEarnings && hasPayRate(w.payRate)
                ? computePeriodEarnings(raw.workSessions, window, w.payRate.tiers)
                : null;

        const recognition = w.recognition
            ? RECOGNITION_FIELDS
                  .map((f) => ({ ...f, value: w.recognition[f.key] }))
                  .filter((f) => Number.isFinite(f.value))
            : null;

        let daily = null;
        if (includeDaily) {
            const days = aggregateDaily(raw.workSessions, raw.breakSessions, window, { allowLarge: false });
            daily = Object.keys(days)
                .sort()
                .map((date) => ({
                    date,
                    workMinutes: Math.round(days[date].work),
                    breakMinutes: Math.round(days[date].break),
                }));
        }

        return {
            userId: w.userId,
            name: w.name,
            current,
            metricsByKey,
            earnings,
            recognition,
            daily,
            dataTrust: computeDataTrust(raw.workSessions, raw.breakSessions, window),
        };
    });

    // Team rollup — a few cross-worker headlines so the brief opens with the whole-team picture.
    const sum = (sel) => builtWorkers.reduce((a, w) => a + (sel(w) || 0), 0);
    const onTimeVals = builtWorkers.map((w) => w.current.onTimePct).filter((v) => Number.isFinite(v));
    const team = {
        workerCount: builtWorkers.length,
        totalHours: Math.round(sum((w) => w.current.totalHours) * 10) / 10,
        // Exact team-wide work/break minutes — the on-screen summary renders Darbas/Pertraukos/Viso
        // from these (one source of truth) so the merged card never disagrees with itself.
        totalWorkMinutes: sum((w) => w.current.totalWorkMinutes),
        totalBreakMinutes: sum((w) => w.current.totalBreakMinutes),
        completedTasks: sum((w) => w.current.completedCount),
        avgOnTimePct: onTimeVals.length
            ? Math.round(onTimeVals.reduce((a, b) => a + b, 0) / onTimeVals.length)
            : null,
        netEarningsEur: includeEarnings ? sum((w) => w.earnings?.netEur) : null,
        grossEarningsEur: includeEarnings ? sum((w) => w.earnings?.grossEur) : null,
    };

    return {
        schemaVersion: REPORT_SCHEMA_VERSION,
        generatedAt,
        manifest: {
            timezone: 'Europe/Vilnius',
            taxRatePct: Math.round(EFFECTIVE_TAX_RATE * 100),
            onTimeGraceMin: ON_TIME_GRACE_MIN,
            assumptions: [
                'Laikas — Europe/Vilnius vietinis.',
                'Trukmės apkarpytos iki realių ribų (darbo sesija ≤ 16 val.) prieš sumuojant.',
                `Punktualumas: darbas pradėtas ≤ ${ON_TIME_GRACE_MIN} min. po planuotos pamainos = „laiku".`,
                'Δ — pokytis prieš ankstesnį tokio paties ilgio laikotarpį; „geriau"/„prasčiau" pagal metrikos kryptį.',
                'Uždarbis — neto po mokesčių, tarpinis pagal vykdytojo tarifų pakopas ir kaupiamas mėnesio valandas.',
                'Pripažinimo skaičiai — viso per visą laiką (ne šio laikotarpio).',
            ],
        },
        period: {
            start: window.startStr,
            end: window.endStr,
            compareStart: prevWindow.startStr,
            compareEnd: prevWindow.endStr,
        },
        scope: scopeLabel,
        team,
        workers: builtWorkers.map((w) => ({
            userId: w.userId,
            name: w.name,
            metrics: w.metricsByKey,
            earnings: w.earnings,
            recognition: w.recognition,
            dataTrust: w.dataTrust,
            ...(w.daily ? { daily: w.daily } : {}),
        })),
    };
}

// ---------------------------------------------------------------------------
// Renderers — thin views over the report object. Same data, three surfaces.
// ---------------------------------------------------------------------------

const eur = (n) => `${Number(n).toLocaleString('lt-LT')} €`;

function deltaSuffix(delta) {
    if (!delta || delta.pct === 0) return '';
    const arrow = delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '→';
    const sign = delta.pct > 0 ? '+' : '';
    const tag = delta.improved === true ? ', geriau' : delta.improved === false ? ', prasčiau' : '';
    return ` (${arrow} ${sign}${delta.pct}%${tag})`;
}

// Markdown — the primary paste-target for a manager dropping the report into an LLM. Narrative
// header + team rollup + one section per worker, every metric grouped exactly as the UI groups it.
export function renderReportMarkdown(report) {
    const L = [];
    L.push('# WORKZ darbo ataskaita');
    L.push('');
    L.push(`- Laikotarpis: ${report.period.start} – ${report.period.end}`);
    L.push(`- Lyginama su: ${report.period.compareStart} – ${report.period.compareEnd}`);
    L.push(`- Sudaryta: ${report.generatedAt} (${report.manifest.timezone})`);
    L.push(`- Aprėptis: ${report.scope}`);
    L.push(`- Schema: v${report.schemaVersion}`);
    L.push('');
    L.push('> Skaitymo gairės modeliui:');
    report.manifest.assumptions.forEach((a) => L.push(`> - ${a}`));
    L.push('');

    const t = report.team;
    L.push('## Komandos suvestinė');
    L.push(`- Vykdytojų: ${t.workerCount}`);
    L.push(`- Viso dirbta: ${formatStatValue(t.totalHours, 'hours')}`);
    L.push(`- Užbaigta užduočių: ${t.completedTasks}`);
    if (Number.isFinite(t.avgOnTimePct)) L.push(`- Vid. punktualus startas: ${t.avgOnTimePct}%`);
    if (t.netEarningsEur) L.push(`- Uždarbis (neto): ${eur(t.netEarningsEur)} (bruto ${eur(t.grossEarningsEur)}, mokesčiai ~${report.manifest.taxRatePct}%)`);
    L.push('');

    for (const w of report.workers) {
        L.push(`## ${w.name}`);
        L.push('');
        for (const group of STAT_GROUPS) {
            L.push(`### ${group.title}`);
            for (const m of group.metrics) {
                const cell = w.metrics[m.key];
                if (!cell) continue;
                let line = `- ${cell.label}: ${cell.formatted}`;
                if (m.key === 'absenceDays' && cell.raw && cell.raw.sub) line += ` (${cell.raw.sub})`;
                line += deltaSuffix(cell.delta);
                L.push(line);
            }
            L.push('');
        }
        if (w.earnings) {
            L.push('### Uždarbis');
            L.push(`- Neto: ${eur(w.earnings.netEur)} · Bruto: ${eur(w.earnings.grossEur)} (mokesčiai ~${w.earnings.taxPct}%)`);
            L.push('');
        }
        if (w.recognition && w.recognition.length) {
            L.push('### Pripažinimas (viso per visą laiką)');
            L.push('- ' + w.recognition.map((f) => `${f.label}: ${f.value}`).join(' · '));
            L.push('');
        }
        L.push('### Duomenų patikimumas');
        L.push(`- Redaguotų sesijų: ${w.dataTrust.editedSessions} · Įtartinų trukmių: ${w.dataTrust.implausibleSessions}`);
        if (w.dataTrust.implausibleSessions > 0) L.push('  - Įspėjimas: skaičiai gali būti apkarpyti — patikrinkite šias sesijas.');
        L.push('');

        // Optional raw evidence — kept clearly separate from the metrics above so the model treats
        // it as the daily log behind the conclusion, not as numbers to re-total.
        if (w.daily && w.daily.length) {
            L.push('### Dienų išklotinė (faktai, ne išvada)');
            w.daily.forEach((d) =>
                L.push(`- ${d.date}: darbas ${formatStatValue(d.workMinutes, 'minutes')} · pertraukos ${formatStatValue(d.breakMinutes, 'minutes')}`)
            );
            L.push('');
        }
    }

    return L.join('\n');
}

// JSON — the structured co-artifact (the same object, pretty-printed) for deterministic / machine use.
export function renderReportJSON(report) {
    return JSON.stringify(report, null, 2);
}

// CSV — a per-worker-per-DAY timesheet for payroll / Excel (replaces the old standalone export).
// One row per worked day (work + break, HH:MM), then a per-worker "Viso" total carrying Planuota +
// Skirtumas (gated by the plan-coverage floor). Operates on the RAW fetched slice (`workers`), not
// the aggregated report object. Honors manual-adjustment magnitudes (payroll convention) — distinct
// from the analysis metrics, which clamp every session at 16h for outlier resistance.
export function renderTimesheetCSV(workers, window) {
    const escape = (str) => {
        if (str === null || str === undefined) return '';
        const s = String(str);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = ['Vykdytojas', 'Data', 'Darbas (val:min)', 'Pertraukos (val:min)', 'Planuota (val:min)', 'Skirtumas (val:min)'];
    const rows = [];

    for (const w of workers) {
        const days = aggregateDaily(w.workSessions, w.breakSessions, window, { allowLarge: true });
        let totalWork = 0;
        let totalBreak = 0;
        Object.keys(days)
            .sort()
            .forEach((date) => {
                const d = days[date];
                totalWork += d.work;
                totalBreak += d.break;
                rows.push([escape(w.name), escape(date), escape(formatMinutesToHHMM(d.work)), escape(formatMinutesToHHMM(d.break)), '', ''].join(','));
            });

        const planned = computePlannedMinutes(w.plannedShifts, window, w.expectedWeeklyHours);
        const hasPlan = planned > 0;
        const planCovers = hasPlan && (totalWork <= 0 || planned >= TIMESHEET_PLAN_FLOOR * totalWork);
        const plannedCell = hasPlan ? formatMinutesToHHMM(planned) : '';
        const skirtumasCell = !hasPlan ? '' : planCovers ? formatSignedMinutesToHHMM(totalWork - planned) : 'Nepakanka plano';
        rows.push([escape(w.name), escape('Viso'), escape(formatMinutesToHHMM(totalWork)), escape(formatMinutesToHHMM(totalBreak)), escape(plannedCell), escape(skirtumasCell)].join(','));
    }

    // BOM so Excel reads the Lithuanian diacritics as UTF-8.
    return '﻿' + [headers.join(','), ...rows].join('\n');
}
