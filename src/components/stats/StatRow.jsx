import clsx from 'clsx';
import InfoPopover from '../ui/InfoPopover';
import StatDelta from './StatDelta';
import { formatStatValue, computeDelta } from '../../utils/workerStats';

// Time-split bar colours reuse the app's signature session palette (red quick-work, blue call,
// amber break, green task) so the breakdown reads consistently with the rest of the app.
const SPLIT_BG = {
    task: 'bg-session-task-accent',
    quick: 'bg-session-quickWork-accent',
    call: 'bg-session-call-accent',
    break: 'bg-session-break-accent',
};

/** Composite stacked-bar row (kind: 'split') — a percentage breakdown, no single delta. */
function SplitRow({ label, hint, parts }) {
    return (
        <div className="py-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
                <span className="text-caption text-ink-muted">{label}</span>
                {hint && <InfoPopover label={`${label} – paaiškinimas`}>{hint}</InfoPopover>}
            </div>
            {parts ? (
                <>
                    <div
                        className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-sunken"
                        role="img"
                        aria-label={parts.map((p) => `${p.label} ${Math.round(p.pct)}%`).join(', ')}
                    >
                        {parts.map((p) =>
                            p.pct > 0 ? (
                                <div key={p.key} className={clsx('h-full', SPLIT_BG[p.key])} style={{ width: `${p.pct}%` }} />
                            ) : null
                        )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        {parts.map((p) => (
                            <span key={p.key} className="inline-flex items-center gap-1 text-caption text-ink-muted">
                                <span className={clsx('h-2 w-2 rounded-full', SPLIT_BG[p.key])} aria-hidden="true" />
                                {p.label} {Math.round(p.pct)}%
                            </span>
                        ))}
                    </div>
                </>
            ) : (
                <span className="text-body text-ink-muted">—</span>
            )}
        </div>
    );
}

/**
 * One metric line: label (+ optional info hint), the formatted value, and a semantic delta vs the
 * previous period. `kind: 'split'` defers to the stacked-bar variant. A value that carries a `sub`
 * (e.g. absence breakdown by type) renders that as a caption under the row.
 */
export default function StatRow({ metric, current, previous }) {
    const { label, kind, goodWhen, hint } = metric;

    if (kind === 'split') {
        return <SplitRow label={label} hint={hint} parts={current?.parts || null} />;
    }

    const delta = computeDelta(current, previous, goodWhen);
    const sub = current && typeof current === 'object' && 'sub' in current ? current.sub : null;

    return (
        <div className="py-2.5">
            <div className="flex items-baseline justify-between gap-3">
                <span className="flex items-center gap-1.5 text-caption text-ink-muted">
                    {label}
                    {hint && <InfoPopover label={`${label} – paaiškinimas`}>{hint}</InfoPopover>}
                </span>
                <span className="flex items-baseline gap-2 text-right">
                    <span className="text-body-lg font-semibold text-ink-strong tabular-nums">
                        {formatStatValue(current, kind)}
                    </span>
                    <StatDelta delta={delta} />
                </span>
            </div>
            {sub && <p className="mt-0.5 text-caption text-ink-muted">{sub}</p>}
        </div>
    );
}
