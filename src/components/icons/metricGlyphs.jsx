/**
 * Reports metric glyphs (icon-system ADR 0010 §"Reports time-bar"). One primitive — a short
 * horizontal time-bar — modulated on a single axis (fill state), so a time figure is read by
 * shape, not by a borrowed icon:
 *   Planned = hollow/dashed bar (intended, not yet real)
 *   Worked  = solid-filled bar (real time spent) — replaces Clock on "Veikla"
 *   Total   = two thin bars merging into one thick bar — replaces Zap on "Viso"
 *
 * This removes two verified collisions in the daily report: Clock labelled both the day-span
 * AND the worked total, and Zap meant "sum" here while meaning "quick-work running" everywhere
 * else. Clock stays for the time-of-day span (its reserved meaning).
 *
 * Drawing canon: 24px grid, `currentColor` so each bar inherits the figure's existing text color
 * (no new color introduced). Decorative next to an already-labelled figure, hence aria-hidden by
 * the caller. Components-only file.
 */

const SVG = { viewBox: '0 0 24 24', xmlns: 'http://www.w3.org/2000/svg' };

export function MetricPlannedGlyph({ className, ...props }) {
    return (
        <svg {...SVG} fill="none" className={className} {...props}>
            <rect x="3" y="10" width="18" height="4" rx="2" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2.5" />
        </svg>
    );
}

export function MetricWorkedGlyph({ className, ...props }) {
    return (
        <svg {...SVG} className={className} {...props}>
            <rect x="3" y="10" width="18" height="4" rx="2" className="fill-current" />
        </svg>
    );
}

export function MetricTotalGlyph({ className, ...props }) {
    return (
        <svg {...SVG} className={className} {...props}>
            <rect x="3" y="7.7" width="9" height="2.6" rx="1.3" className="fill-current" />
            <rect x="3" y="13.7" width="9" height="2.6" rx="1.3" className="fill-current" />
            <rect x="12" y="10" width="9" height="4" rx="2" className="fill-current" />
        </svg>
    );
}
