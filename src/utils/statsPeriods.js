import { getWorkDayString, addDaysToDateString } from './timeUtils';

/**
 * Rolling-window period presets for the worker-stats surface. Equal-length windows are what make
 * the period-over-period comparison meaningful (each compares against the immediately preceding
 * window of the same length). Lives apart from the picker COMPONENT so the component file exports
 * only a component (react-refresh/only-export-components).
 */
export const PRESETS = [
    { key: 'week', label: 'Savaitė', days: 7 },
    { key: 'month', label: 'Mėnuo', days: 30 },
    { key: 'quarter', label: '3 mėn.', days: 90 },
    { key: 'half', label: 'Pusmetis', days: 180 },
    { key: 'custom', label: 'Custom', days: null },
];

/** [start, end] YYYY-MM-DD window for a preset key (null for custom), ending on the current WORK
 *  day (Vilnius) — the same key the session rows it selects are stamped with. */
export function rangeForPreset(key, today = getWorkDayString()) {
    const preset = PRESETS.find((p) => p.key === key);
    if (!preset || !preset.days) return null;
    return { startStr: addDaysToDateString(today, -(preset.days - 1)), endStr: today };
}
