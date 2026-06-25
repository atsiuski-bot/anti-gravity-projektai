import { getLithuanianDateString, addDaysToDateString } from '../../utils/timeUtils';

// Period ladder shared by every report surface (team work report, calendar history, and the
// per-member statistics drill-down): a single day (default) up through the year, plus a custom
// from/to range driven by the date pickers.
export const PERIOD_PRESETS = [
    { id: 'day', label: 'Ši diena' },
    { id: 'week', label: 'Ši savaitė' },
    { id: 'month', label: 'Šis mėnuo' },
    { id: '3months', label: '3 mėnesiai' },
    { id: 'year', label: 'Šie metai' },
];

// Resolve a period preset to a from/to range. All math is pure date-string arithmetic
// (addDaysToDateString is DST-safe), weeks are Monday-started per Lithuanian convention, and
// every range ends "today" so the report always runs up to the current day. Pure (returns the
// range) so every picker can share one source of truth.
export function resolvePresetRange(preset) {
    const today = getLithuanianDateString();
    const pad = (n) => String(n).padStart(2, '0');
    const dayOfWeek = (dateStr) => {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
    };
    const firstOfMonth = (dateStr) => `${dateStr.slice(0, 7)}-01`;
    const mondayOffset = (dayOfWeek(today) + 6) % 7; // days since this week's Monday
    const [y, m] = today.split('-').map(Number);

    let start;
    const end = today;
    switch (preset) {
        case 'day':
            start = today;
            break;
        case 'week':
            start = addDaysToDateString(today, -mondayOffset);
            break;
        case 'month':
            start = firstOfMonth(today);
            break;
        case '3months': {
            // Current month plus the two preceding it = 3 calendar months through today.
            const d = new Date(Date.UTC(y, m - 1 - 2, 1));
            start = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
            break;
        }
        case 'year':
            start = `${today.slice(0, 4)}-01-01`;
            break;
        default:
            return null;
    }
    return { start, end };
}

// Shift a date range by one period unit in `direction` (+1 forward, -1 back). Named presets use
// their canonical unit (week = 7 days aligned to Monday, month/3months/year = calendar boundaries);
// 'custom' shifts by the current window length. The returned end is capped at today so future
// ranges are never produced.
export function shiftRange(reportPeriod, dateRange, direction) {
    const today = getLithuanianDateString();
    const pad = (n) => String(n).padStart(2, '0');
    const [sy, sm] = dateRange.start.split('-').map(Number);
    const [ey, em, ed] = dateRange.end.split('-').map(Number);

    if (reportPeriod === 'week') {
        const newStart = addDaysToDateString(dateRange.start, direction * 7);
        const newEnd = addDaysToDateString(newStart, 6);
        return { start: newStart, end: newEnd > today ? today : newEnd };
    }

    if (reportPeriod === 'month') {
        let newY = sy, newM = sm + direction;
        while (newM > 12) { newM -= 12; newY++; }
        while (newM < 1) { newM += 12; newY--; }
        const lastDay = new Date(Date.UTC(newY, newM, 0)).getUTCDate();
        const end = `${newY}-${pad(newM)}-${pad(lastDay)}`;
        return { start: `${newY}-${pad(newM)}-01`, end: end > today ? today : end };
    }

    if (reportPeriod === '3months') {
        let newStartY = sy, newStartM = sm + direction * 3;
        while (newStartM > 12) { newStartM -= 12; newStartY++; }
        while (newStartM < 1) { newStartM += 12; newStartY--; }
        let newEndY = newStartY, newEndM = newStartM + 2;
        while (newEndM > 12) { newEndM -= 12; newEndY++; }
        const lastDay = new Date(Date.UTC(newEndY, newEndM, 0)).getUTCDate();
        const end = `${newEndY}-${pad(newEndM)}-${pad(lastDay)}`;
        return { start: `${newStartY}-${pad(newStartM)}-01`, end: end > today ? today : end };
    }

    if (reportPeriod === 'year') {
        const newStartY = sy + direction;
        const end = `${newStartY}-12-31`;
        return { start: `${newStartY}-01-01`, end: end > today ? today : end };
    }

    // custom: shift by the current window's day count
    const sd = Number(dateRange.start.split('-')[2]);
    const startDate = new Date(Date.UTC(sy, sm - 1, sd));
    const endDate = new Date(Date.UTC(ey, em - 1, ed));
    const days = Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
    const newStart = addDaysToDateString(dateRange.start, direction * days);
    const newEnd = addDaysToDateString(dateRange.end, direction * days);
    return { start: newStart, end: newEnd > today ? today : newEnd };
}
