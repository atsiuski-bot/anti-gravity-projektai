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
