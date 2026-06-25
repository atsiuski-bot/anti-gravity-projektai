/**
 * Aggregated, derived per-worker statistics over a selectable period.
 *
 * This module is PURE (no Firestore, no React): given the raw documents already fetched for a
 * single worker plus a [start, end] day window, `computeWorkerStats` returns one flat map of
 * metric-key -> value. The hook (`useWorkerStats`) fetches once over the union range and calls
 * this twice — current vs previous equal-length window — so the panel can render a delta arrow
 * per metric.
 *
 * `STAT_GROUPS` is the single source of truth for WHAT is shown and HOW: each metric declares
 * its label (user-facing Lithuanian, formal "Jūs" register), a value format, and `goodWhen`
 * ('up' | 'down' | 'neutral') so the UI can colour a change green/red by whether it is an
 * IMPROVEMENT, not merely by numeric direction (DESIGN decision B — semantic colouring).
 *
 * All time math buckets by the Vilnius calendar day, reusing timeUtils so this view agrees with
 * Reports/DailyStatistics to the minute. Stored session durations are funnelled through
 * `sanitizeReportMinutes` (the same read-side clamp the reports use) before summing.
 */
import {
    getLithuanianDateString,
    sanitizeReportMinutes,
    calculateCurrentTotalMinutes,
    parseTimeStringToMinutes,
} from './timeUtils';

// Punctuality grace: a start within this many minutes of the planned shift start still counts
// as "on time". Field staff on phones outdoors should not be flagged for a one-minute drift.
export const ON_TIME_GRACE_MIN = 10;

// A reschedule/cancel counts as "late" when the worker raised it within this many days of the
// affected shift — the last-minute changes that actually disrupt planning.
export const LATE_RESCHEDULE_DAYS = 3;

// Absence taxonomy labels (mirrors src/utils/absence.js ABSENCE_TYPES), used both in the compute
// (the absence breakdown caption) and as user-facing copy. Declared up here so computeWorkerStats
// can read it without tripping no-use-before-define.
export const ABSENCE_LABELS = {
    vacation: 'Atostogos',
    sick: 'Liga',
    holiday: 'Šventė',
    unpaid: 'Neapmokama',
};

// ---------------------------------------------------------------------------
// Small numeric helpers (null = "no data", never silently 0).
// ---------------------------------------------------------------------------
const sum = (arr) => arr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
const average = (arr) => (arr.length ? sum(arr) / arr.length : null);
const ratioPct = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

/**
 * Linear-interpolation percentile (`p` in 0..100) over a numeric array; null if empty. P50 is the
 * median. Distribution stats sit alongside the averages so a lopsided spread (a few very long days
 * pulling the mean up) is visible rather than hidden inside a single average.
 */
const percentile = (arr, p) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

/** Hour-of-day as a decimal (e.g. 8.5 = 08:30) in the Vilnius wall clock, from a UTC ISO. */
const vilniusHourDecimal = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Vilnius',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const hh = Number(parts.find((p) => p.type === 'hour')?.value);
    const mm = Number(parts.find((p) => p.type === 'minute')?.value);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    // 24:00 is emitted by some engines for midnight; normalise to 0.
    return (hh % 24) + mm / 60;
};

/** Positive minute span between two ISO instants (0 if reversed / malformed). */
const minutesBetween = (startIso, endIso) => {
    if (!startIso || !endIso) return 0;
    const a = new Date(startIso).getTime();
    const b = new Date(endIso).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return Math.max(0, (b - a) / 60000);
};

/** Whole calendar days between two ISO instants (b - a), floored; null if malformed. */
const daysBetween = (aIso, bIso) => {
    const a = new Date(aIso).getTime();
    const b = new Date(bIso).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.floor((b - a) / 86400000);
};

const inWindow = (dayStr, startStr, endStr) =>
    !!dayStr && dayStr >= startStr && dayStr <= endStr;

/** Category of a work_sessions row: 'call' (system), 'quick', or 'task'. */
const sessionCategory = (s) => {
    if (s.isSystemTask) return 'call';
    if (s.isQuickWork) return 'quick';
    return 'task';
};

// ---------------------------------------------------------------------------
// Core compute
// ---------------------------------------------------------------------------
/**
 * @param {Object} raw
 * @param {Array}  raw.workSessions   work_sessions docs (have date, startTime, endTime, durationMinutes, isQuickWork, isSystemTask)
 * @param {Array}  raw.breakSessions  break_sessions docs (date, durationMinutes)
 * @param {Array}  raw.plannedShifts  work_hours docs ({ start, end, absenceType, isVacation })
 * @param {Array}  raw.tasks          completed task docs (tasks + archived_tasks), assigned to the worker
 * @param {Array}  raw.calendarRequests calendar_requests docs ({ type, createdAt, requestedEvent, originalEvent })
 * @param {Object} window  { startStr, endStr } inclusive YYYY-MM-DD bounds (Vilnius days)
 * @param {Object} opts    { expectedWeeklyHours }
 * @returns {Object} flat metric-key -> value (number | null | {parts} | {value, sub})
 */
export function computeWorkerStats(raw, window, opts = {}) {
    const { startStr, endStr } = window;
    const expectedWeeklyHours = Number(opts.expectedWeeklyHours) || 0;
    const periodDays = Math.max(1, (daysBetween(`${startStr}T00:00:00Z`, `${endStr}T00:00:00Z`) ?? 0) + 1);

    const workSessions = (raw.workSessions || []).filter((s) => inWindow(s.date, startStr, endStr));
    const breakSessions = (raw.breakSessions || []).filter((s) => inWindow(s.date, startStr, endStr));

    // --- Per-day work aggregation: first start, last end, worked/break minutes, break count.
    const days = {};
    const dayOf = (k) => (days[k] || (days[k] = {
        workMin: 0, breakMin: 0, breakCount: 0, firstStart: null, lastEnd: null,
    }));

    const catMinutes = { task: 0, quick: 0, call: 0 };
    workSessions.forEach((s) => {
        const mins = sanitizeReportMinutes(s.durationMinutes);
        const d = dayOf(s.date);
        d.workMin += mins;
        catMinutes[sessionCategory(s)] += mins;
        if (s.startTime && (!d.firstStart || s.startTime < d.firstStart)) d.firstStart = s.startTime;
        if (s.endTime && (!d.lastEnd || s.endTime > d.lastEnd)) d.lastEnd = s.endTime;
    });
    breakSessions.forEach((s) => {
        const d = dayOf(s.date);
        d.breakMin += sanitizeReportMinutes(s.durationMinutes);
        d.breakCount += 1;
    });

    const dayKeys = Object.keys(days);
    const workedDayKeys = dayKeys.filter((k) => days[k].workMin > 0);
    const activeDays = workedDayKeys.length;

    const totalWorkMin = sum(workedDayKeys.map((k) => days[k].workMin));
    const totalBreakMin = sum(dayKeys.map((k) => days[k].breakMin));

    // --- Day rhythm: per worked-day length (span minus breaks), span, start/end clock.
    const dayLengths = [];
    const daySpans = [];
    const startHours = [];
    const endHours = [];
    workedDayKeys.forEach((k) => {
        const d = days[k];
        const span = minutesBetween(d.firstStart, d.lastEnd);
        if (span > 0) {
            daySpans.push(span);
            dayLengths.push(Math.max(0, span - d.breakMin));
        }
        const sh = vilniusHourDecimal(d.firstStart);
        const eh = vilniusHourDecimal(d.lastEnd);
        if (sh != null) startHours.push(sh);
        if (eh != null) endHours.push(eh);
    });

    // --- Planned shifts (work_hours): planned work minutes/days and absence breakdown.
    const planned = (raw.plannedShifts || []).filter((p) => inWindow(getLithuanianDateString(p.start), startStr, endStr));
    const plannedWorkByDay = {};
    const plannedStartByDay = {};
    const absenceByType = {};
    let absenceDays = 0;
    planned.forEach((p) => {
        const k = getLithuanianDateString(p.start);
        const type = p.absenceType || (p.isVacation ? 'vacation' : null);
        if (type) {
            absenceByType[type] = (absenceByType[type] || 0) + 1;
            absenceDays += 1;
            return;
        }
        plannedWorkByDay[k] = (plannedWorkByDay[k] || 0) + minutesBetween(p.start, p.end);
        // Earliest planned start for the day drives the punctuality comparison.
        if (!plannedStartByDay[k] || p.start < plannedStartByDay[k]) plannedStartByDay[k] = p.start;
    });
    const plannedDayKeys = Object.keys(plannedWorkByDay);
    const plannedMin = sum(plannedDayKeys.map((k) => plannedWorkByDay[k]));

    // --- Punctuality: compare each planned day's earliest actual start to the plan.
    const latenessSamples = [];
    let onTimeCount = 0;
    let punctualityDenom = 0;
    plannedDayKeys.forEach((k) => {
        const plannedStart = vilniusHourDecimal(plannedStartByDay[k]);
        const actualStart = days[k]?.firstStart ? vilniusHourDecimal(days[k].firstStart) : null;
        if (plannedStart == null || actualStart == null) return; // planned but absent -> not a punctuality sample
        punctualityDenom += 1;
        const lateMin = Math.max(0, (actualStart - plannedStart) * 60);
        latenessSamples.push(lateMin);
        if (lateMin <= ON_TIME_GRACE_MIN) onTimeCount += 1;
    });

    // --- Reschedules / cancellations from calendar_requests (worker-initiated changes).
    let reschedules = 0;
    let lateReschedules = 0;
    (raw.calendarRequests || []).forEach((r) => {
        if (r.type !== 'edit' && r.type !== 'delete') return;
        const shiftStart = r.requestedEvent?.start || r.originalEvent?.start;
        const refDay = shiftStart ? getLithuanianDateString(shiftStart) : null;
        if (!inWindow(refDay, startStr, endStr)) return;
        reschedules += 1;
        const lead = r.createdAt && shiftStart ? daysBetween(r.createdAt, shiftStart) : null;
        if (lead != null && lead <= LATE_RESCHEDULE_DAYS) lateReschedules += 1;
    });

    // --- Tasks: throughput, duration, estimate accuracy, approval. Exclude system/quick rows
    //     so "užduotys" reflects real assigned work, not call/quick-work auto-logs.
    const tasks = (raw.tasks || []).filter((t) => {
        if (t.isSystemTask || t.isQuickWork) return false;
        const day = getLithuanianDateString(t.confirmedAt || t.completedAt || t.archivedAt || t.createdAt);
        return inWindow(day, startStr, endStr);
    });
    const completedCount = tasks.length;
    const taskDurations = tasks.map((t) => calculateCurrentTotalMinutes(t)).filter((m) => m > 0);

    const estimateRatios = [];
    let onEstimate = 0;
    let estimateDenom = 0;
    tasks.forEach((t) => {
        const est = parseTimeStringToMinutes(t.estimatedTime);
        const actual = calculateCurrentTotalMinutes(t);
        if (est > 0 && actual > 0) {
            estimateDenom += 1;
            estimateRatios.push(actual / est);
            if (actual <= est) onEstimate += 1;
        }
    });
    const confirmedCount = tasks.filter((t) => t.status === 'confirmed' || t.confirmedAt).length;
    const highPriorityShare = ratioPct(
        tasks.filter((t) => ['URGENT', 'HIGH'].includes(String(t.priority || '').toUpperCase())).length,
        completedCount,
    );

    // --- Time split across categories (share of all tracked minutes incl. breaks).
    const totalTracked = catMinutes.task + catMinutes.quick + catMinutes.call + totalBreakMin;
    const split = totalTracked > 0 ? {
        parts: [
            { key: 'task', label: 'Užduotys', pct: (catMinutes.task / totalTracked) * 100 },
            { key: 'quick', label: 'Greitas', pct: (catMinutes.quick / totalTracked) * 100 },
            { key: 'call', label: 'Skambučiai', pct: (catMinutes.call / totalTracked) * 100 },
            { key: 'break', label: 'Pertraukos', pct: (totalBreakMin / totalTracked) * 100 },
        ],
    } : null;

    const weeks = periodDays / 7;
    const absenceSub = Object.keys(absenceByType).length
        ? Object.entries(absenceByType).map(([k, n]) => `${ABSENCE_LABELS[k] || k}: ${n}`).join(' · ')
        : null;

    return {
        // G1 — Apimtis ir laikas
        totalHours: totalWorkMin > 0 ? totalWorkMin / 60 : (activeDays ? 0 : null),
        // Exact minutes (work + break) kept alongside the rounded `totalHours` so the on-screen
        // team summary can render the Veikla/Pertraukos/Viso triplet to the minute, matching the
        // timeline's own totals. Inert to the export (not a STAT_GROUPS metric key).
        totalWorkMinutes: totalWorkMin,
        totalBreakMinutes: totalBreakMin,
        activeDays: dayKeys.length ? activeDays : null,
        weekConsistency: activeDays ? activeDays / weeks : null,
        avgPerDay: activeDays ? totalWorkMin / 60 / activeDays : null,
        normCoverage: expectedWeeklyHours > 0 && activeDays
            ? ratioPct(totalWorkMin / 60 / weeks, expectedWeeklyHours)
            : null,
        productivePct: ratioPct(totalWorkMin, totalWorkMin + totalBreakMin),

        // G2 — Dienos ritmas
        avgDayLength: average(dayLengths) != null ? average(dayLengths) / 60 : null,
        avgStart: average(startHours),
        avgEnd: average(endHours),
        avgSpan: average(daySpans) != null ? average(daySpans) / 60 : null,

        // G2b — Pasiskirstymas: median + quartiles for day length and start (depth past the means)
        medianDayLength: percentile(dayLengths, 50) != null ? percentile(dayLengths, 50) / 60 : null,
        p25DayLength: percentile(dayLengths, 25) != null ? percentile(dayLengths, 25) / 60 : null,
        p75DayLength: percentile(dayLengths, 75) != null ? percentile(dayLengths, 75) / 60 : null,
        medianStart: percentile(startHours, 50),
        p25Start: percentile(startHours, 25),
        p75Start: percentile(startHours, 75),

        // G3 — Punktualumas ir disciplina
        onTimePct: punctualityDenom ? ratioPct(onTimeCount, punctualityDenom) : null,
        avgLatenessMin: average(latenessSamples),
        planCoveragePct: plannedMin > 0 ? ratioPct(totalWorkMin, plannedMin) : null,
        plannedVsWorkedDaysPct: plannedDayKeys.length
            ? ratioPct(plannedDayKeys.filter((k) => days[k]?.workMin > 0).length, plannedDayKeys.length)
            : null,
        reschedules: raw.calendarRequests ? reschedules : null,
        lateReschedules: raw.calendarRequests ? lateReschedules : null,

        // G4 — Užduotys: našumas ir kokybė
        completedCount: completedCount || (tasks ? 0 : null),
        completedPerDay: activeDays ? completedCount / activeDays : (completedCount ? completedCount / periodDays : null),
        avgTaskDuration: average(taskDurations),
        estimateAccuracyPct: estimateDenom ? average(estimateRatios) * 100 : null,
        onEstimatePct: estimateDenom ? ratioPct(onEstimate, estimateDenom) : null,
        approvalPct: completedCount ? ratioPct(confirmedCount, completedCount) : null,

        // G5 — Pertraukos ir sudėtis
        avgBreakPerDay: activeDays ? totalBreakMin / activeDays : null,
        breakSharePct: ratioPct(totalBreakMin, totalWorkMin + totalBreakMin),
        avgBreakCount: activeDays ? sum(dayKeys.map((k) => days[k].breakCount)) / activeDays : null,
        timeSplit: split,
        highPriorityPct: highPriorityShare,
        absenceDays: planned.length ? { value: absenceDays, sub: absenceSub } : null,
    };
}

// ---------------------------------------------------------------------------
// Presentation metadata
// ---------------------------------------------------------------------------
/**
 * Format a raw metric value for display. `kind`:
 *   'hours'   value is already in hours -> "Xh Ym"
 *   'minutes' value is minutes -> "Xm" / "Xh Ym"
 *   'pct'     -> "X%"
 *   'count'   -> integer
 *   'days'    -> "X d."
 *   'rate'    -> one-decimal number (e.g. days/week, tasks/day)
 *   'clock'   -> decimal hour-of-day -> "HH:MM"
 */
export function formatStatValue(value, kind) {
    if (value == null) return '—';
    const v = typeof value === 'object' && 'value' in value ? value.value : value;
    switch (kind) {
        case 'hours': {
            const total = Math.round(v * 60);
            const h = Math.floor(total / 60);
            const m = total % 60;
            if (h === 0) return `${m}m`;
            return m === 0 ? `${h}h` : `${h}h ${m}m`;
        }
        case 'minutes': {
            const total = Math.round(v);
            if (total < 60) return `${total}m`;
            const h = Math.floor(total / 60);
            const m = total % 60;
            return m === 0 ? `${h}h` : `${h}h ${m}m`;
        }
        case 'pct':
            return `${Math.round(v)}%`;
        case 'count':
            return `${Math.round(v)}`;
        case 'days':
            return `${Math.round(v)} d.`;
        case 'rate':
            return v.toFixed(1);
        case 'clock': {
            const hh = Math.floor(v);
            const mm = Math.round((v - hh) * 60);
            const norm = mm === 60 ? [hh + 1, 0] : [hh, mm];
            return `${String(norm[0]).padStart(2, '0')}:${String(norm[1]).padStart(2, '0')}`;
        }
        default:
            return `${v}`;
    }
}

/**
 * Declarative group/metric model. Titles + labels are user-facing Lithuanian (formal). `goodWhen`
 * drives semantic delta colouring; `hint` is an optional one-line explanation for an InfoPopover.
 */
export const STAT_GROUPS = [
    {
        key: 'volume',
        title: 'Apimtis ir laikas',
        metrics: [
            { key: 'totalHours', label: 'Viso dirbta', kind: 'hours', goodWhen: 'up' },
            { key: 'activeDays', label: 'Aktyvios dienos', kind: 'days', goodWhen: 'up' },
            { key: 'weekConsistency', label: 'Dienų per savaitę (vid.)', kind: 'rate', goodWhen: 'neutral' },
            { key: 'avgPerDay', label: 'Vid. per dieną', kind: 'hours', goodWhen: 'up' },
            { key: 'normCoverage', label: 'Normos padengimas', kind: 'pct', goodWhen: 'up', hint: 'Vid. savaitės valandos prieš nustatytą savaitės normą.' },
            { key: 'productivePct', label: 'Produktyvus laikas', kind: 'pct', goodWhen: 'up', hint: 'Veiklos laikas iš viso prie veiklos + pertraukų laiko.' },
        ],
    },
    {
        key: 'rhythm',
        title: 'Dienos ritmas',
        metrics: [
            { key: 'avgDayLength', label: 'Vid. veiklos dienos ilgis', kind: 'hours', goodWhen: 'neutral', hint: 'Nuo pirmo starto iki paskutinės pabaigos, atėmus pertraukas.' },
            { key: 'avgStart', label: 'Vid. starto valanda', kind: 'clock', goodWhen: 'neutral' },
            { key: 'avgEnd', label: 'Vid. pabaigos valanda', kind: 'clock', goodWhen: 'neutral' },
            { key: 'avgSpan', label: 'Dienos tįsumas', kind: 'hours', goodWhen: 'neutral', hint: 'Nuo pirmo starto iki paskutinės pabaigos, įskaitant tarpus.' },
        ],
    },
    {
        key: 'distribution',
        title: 'Pasiskirstymas',
        metrics: [
            { key: 'medianDayLength', label: 'Dienos ilgio mediana', kind: 'hours', goodWhen: 'neutral', hint: 'Vidurinė reikšmė — pusė dienų trumpesnės, pusė ilgesnės. Atsparesnė kraštutinumams nei vidurkis.' },
            { key: 'p25DayLength', label: 'Dienos ilgis P25', kind: 'hours', goodWhen: 'neutral', hint: 'Ketvirtadalis dienų trumpesnės už šią reikšmę.' },
            { key: 'p75DayLength', label: 'Dienos ilgis P75', kind: 'hours', goodWhen: 'neutral', hint: 'Trys ketvirtadaliai dienų trumpesnės už šią reikšmę.' },
            { key: 'medianStart', label: 'Starto mediana', kind: 'clock', goodWhen: 'neutral' },
            { key: 'p25Start', label: 'Startas P25 (anksti)', kind: 'clock', goodWhen: 'neutral', hint: 'Ketvirtadalis dienų pradėta anksčiau už šį laiką.' },
            { key: 'p75Start', label: 'Startas P75 (vėlai)', kind: 'clock', goodWhen: 'neutral', hint: 'Trys ketvirtadaliai dienų pradėta anksčiau už šį laiką.' },
        ],
    },
    {
        key: 'discipline',
        title: 'Patikimumas',
        metrics: [
            { key: 'onTimePct', label: 'Startas laiku', kind: 'pct', goodWhen: 'up', hint: `Dienos, kai veikla pradėta ≤ ${ON_TIME_GRACE_MIN} min. po planuoto veiklos laiko pradžios.` },
            { key: 'avgLatenessMin', label: 'Vid. vėlavimas', kind: 'minutes', goodWhen: 'down' },
            { key: 'planCoveragePct', label: 'Plano padengimas', kind: 'pct', goodWhen: 'up', hint: 'Faktinės valandos prieš planuotas veiklos laiko valandas.' },
            { key: 'plannedVsWorkedDaysPct', label: 'Suplanuotos dienos atidirbtos', kind: 'pct', goodWhen: 'up' },
            { key: 'reschedules', label: 'Atšaukimai / perplanavimai', kind: 'count', goodWhen: 'down' },
            { key: 'lateReschedules', label: `Vėlyvi (≤ ${LATE_RESCHEDULE_DAYS} d.)`, kind: 'count', goodWhen: 'down', hint: 'Atšaukimai/perplanavimai pateikti likus mažiau kaip 3 d. iki veiklos laiko.' },
        ],
    },
    {
        key: 'tasks',
        title: 'Užduotys: našumas ir kokybė',
        metrics: [
            { key: 'completedCount', label: 'Užbaigta užduočių', kind: 'count', goodWhen: 'up' },
            { key: 'completedPerDay', label: 'Vid. per dieną', kind: 'rate', goodWhen: 'up' },
            { key: 'avgTaskDuration', label: 'Vid. užduoties trukmė', kind: 'minutes', goodWhen: 'neutral' },
            { key: 'estimateAccuracyPct', label: 'Plano tikslumas', kind: 'pct', goodWhen: 'neutral', hint: 'Faktinis laikas prieš numatytą (100% = tiksliai pataikyta).' },
            { key: 'onEstimatePct', label: 'Telpa į planą', kind: 'pct', goodWhen: 'up', hint: 'Užduotys, neviršijusios numatyto laiko.' },
            { key: 'approvalPct', label: 'Priimta koordinatoriaus', kind: 'pct', goodWhen: 'up' },
        ],
    },
    {
        key: 'mix',
        title: 'Pertraukos ir sudėtis',
        metrics: [
            { key: 'avgBreakPerDay', label: 'Vid. pertraukų per dieną', kind: 'minutes', goodWhen: 'neutral' },
            { key: 'breakSharePct', label: 'Pertraukų dalis', kind: 'pct', goodWhen: 'down', hint: 'Pertraukų laikas iš viso prie veiklos + pertraukų laiko.' },
            { key: 'avgBreakCount', label: 'Vid. pertraukų skaičius', kind: 'rate', goodWhen: 'neutral' },
            { key: 'timeSplit', label: 'Laiko pasiskirstymas', kind: 'split', goodWhen: 'neutral' },
            { key: 'highPriorityPct', label: 'Skubių / aukštų dalis', kind: 'pct', goodWhen: 'neutral', hint: 'Užbaigtos aukšto ir skubaus prioriteto užduotys.' },
            { key: 'absenceDays', label: 'Neatvykimai', kind: 'days', goodWhen: 'down' },
        ],
    },
];

/**
 * Period-over-period delta for one metric. Returns null when either side lacks data or the metric
 * is a composite (split) or the baseline is 0 (no meaningful percentage). `pct` is the relative
 * change; `improved` applies `goodWhen` so the UI colours by improvement, not raw direction.
 */
export function computeDelta(curr, prev, goodWhen) {
    const c = typeof curr === 'object' && curr && 'value' in curr ? curr.value : curr;
    const p = typeof prev === 'object' && prev && 'value' in prev ? prev.value : prev;
    if (c == null || p == null || typeof c !== 'number' || typeof p !== 'number') return null;
    if (p === 0) return null;
    const pct = ((c - p) / Math.abs(p)) * 100;
    if (!Number.isFinite(pct)) return null;
    const rounded = Math.round(pct);
    if (rounded === 0 || goodWhen === 'neutral') {
        return { pct: rounded, direction: rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat', improved: null };
    }
    const direction = rounded > 0 ? 'up' : 'down';
    const improved = goodWhen === 'up' ? rounded > 0 : rounded < 0;
    return { pct: rounded, direction, improved };
}
