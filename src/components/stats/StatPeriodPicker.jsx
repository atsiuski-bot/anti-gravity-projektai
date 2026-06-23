import { useState } from 'react';
import clsx from 'clsx';
import DatePicker from '../ui/DatePicker';
import { getLithuanianDateString, addDaysToDateString } from '../../utils/timeUtils';
import { PRESETS, rangeForPreset } from '../../utils/statsPeriods';

/**
 * The standard period control at the top of the statistics surface: rolling presets
 * (Savaitė / Mėnuo / 3 mėn. / Pusmetis) plus a Custom range (two localized DatePickers).
 * Controlled — emits `{ key, startStr, endStr }` through `onChange`.
 */
export default function StatPeriodPicker({ value, onChange }) {
    const today = getLithuanianDateString();
    const [customStart, setCustomStart] = useState(value?.startStr || addDaysToDateString(today, -29));
    const [customEnd, setCustomEnd] = useState(value?.endStr || today);

    const selectPreset = (key) => {
        if (key === 'custom') {
            onChange({ key, startStr: customStart, endStr: customEnd });
        } else {
            onChange({ key, ...rangeForPreset(key, today) });
        }
    };

    // Keep the range ordered so a reversed pick can't produce an empty window.
    const commitCustom = (startStr, endStr) => {
        const [s, e] = startStr <= endStr ? [startStr, endStr] : [endStr, startStr];
        setCustomStart(s);
        setCustomEnd(e);
        onChange({ key: 'custom', startStr: s, endStr: e });
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Laikotarpis">
                {PRESETS.map((p) => (
                    <button
                        key={p.key}
                        type="button"
                        onClick={() => selectPreset(p.key)}
                        aria-pressed={value?.key === p.key}
                        className={clsx(
                            'rounded-control px-3 py-1.5 text-caption font-semibold min-h-touch transition-colors',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                            value?.key === p.key
                                ? 'bg-brand text-white'
                                : 'border border-line bg-surface-sunken text-ink hover:bg-surface-card'
                        )}
                    >
                        {p.label}
                    </button>
                ))}
            </div>
            {value?.key === 'custom' && (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-caption text-ink-muted">Nuo</span>
                    <DatePicker value={customStart} max={customEnd} onChange={(s) => commitCustom(s, customEnd)} />
                    <span className="text-caption text-ink-muted">iki</span>
                    <DatePicker value={customEnd} min={customStart} max={today} onChange={(e) => commitCustom(customStart, e)} />
                </div>
            )}
        </div>
    );
}
