import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import clsx from 'clsx';

/**
 * Period-over-period delta chip with SEMANTIC colour (DESIGN decision B): green = improvement,
 * red = regression — not raw numeric direction. So a drop in lateness or break-share reads green.
 * `delta` is the output of `computeDelta` ({ pct, direction, improved }) or null (no baseline →
 * render nothing). `improved: null` (neutral metric or 0% change) stays muted.
 */
export default function StatDelta({ delta }) {
    if (!delta) return null;
    const { pct, direction, improved } = delta;
    const Icon = direction === 'up' ? ArrowUp : direction === 'down' ? ArrowDown : Minus;
    const tone =
        improved === true
            ? 'text-feedback-success'
            : improved === false
                ? 'text-feedback-danger'
                : 'text-ink-muted';
    const dirWord = direction === 'up' ? 'daugiau' : direction === 'down' ? 'mažiau' : 'be pokyčio';
    return (
        <span
            className={clsx('inline-flex items-center gap-0.5 text-caption font-semibold tabular-nums', tone)}
            aria-label={`${dirWord} ${Math.abs(pct)}% nei praėjusį laikotarpį`}
        >
            <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
            {pct > 0 ? '+' : ''}{pct}%
        </span>
    );
}
