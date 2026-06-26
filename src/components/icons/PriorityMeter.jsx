import { getPriorityRank } from '../../utils/priority';

/**
 * PriorityMeter — a 1..4 signal-strength bar glyph that makes priority COUNTABLE instead of a
 * read-the-word task (icon-system, ADR 0010 §"Priority"). It leads the <PriorityBadge> label
 * and inherits the chip's (WCAG-tuned) text color via `currentColor`, so it never introduces a
 * new color and stays legible on every priority chip. The top rung (Skubus/urgent) adds a
 * categorical alert tick, so it reads as qualitatively different — not just "one more bar".
 *
 * rank (priority.js): LOW 1 · MEDIUM 2 · HIGH 3 · URGENT 4.
 * Decorative: the chip already carries the Lithuanian label, so this is purely additive glance
 * help and is marked aria-hidden.
 */
const HEIGHTS = [6, 9.5, 13, 16.5];

export default function PriorityMeter({ priority, className, ...props }) {
    const rank = getPriorityRank(priority); // 1..4
    const bars = Math.min(rank, 4);
    const urgent = rank >= 4;
    return (
        <svg viewBox="0 0 26 20" fill="none" className={className} aria-hidden="true" {...props}>
            {HEIGHTS.map((h, i) => (
                <rect
                    key={i}
                    x={2 + i * 5}
                    y={18 - h}
                    width="3"
                    height={h}
                    rx="1.2"
                    className={i < bars ? 'fill-current' : 'fill-current opacity-25'}
                />
            ))}
            {urgent && (
                <g className="fill-current">
                    <rect x="23" y="4" width="2.2" height="8" rx="1.1" />
                    <circle cx="24.1" cy="15.5" r="1.3" />
                </g>
            )}
        </svg>
    );
}
