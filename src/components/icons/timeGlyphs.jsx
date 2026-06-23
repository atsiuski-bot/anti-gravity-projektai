/**
 * Time / extension glyphs (icon-system ADR 0010 §"Notifications"). The three time-extension
 * notices share ONE hourglass at the same shape and size, so they read as a progression — the
 * founder's exact design:
 *   TimeUp   — empty hourglass (the worker hit the limit / "laikas baigėsi")
 *   Granted  — hourglass with a filled interior + a small "+" corner mark (laikas pratęstas)
 *   Denied   — hourglass with a filled interior + a small "×" corner mark (laikas nepratęstas)
 *
 * All `currentColor`, so the consumer's tone class colors the whole glyph (green for granted,
 * red for denied/time-up). This replaces a bare Clock used for all three — and Clock is now
 * reserved for time-of-day / duration, not "waiting". Components-only file.
 */

const SVG = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    xmlns: 'http://www.w3.org/2000/svg',
};

function Hourglass() {
    return (
        <>
            <path d="M7 4 H17" />
            <path d="M7 20 H17" />
            <path d="M8 4 Q8 9 12 12 Q8 15 8 20" />
            <path d="M16 4 Q16 9 12 12 Q16 15 16 20" />
        </>
    );
}

function Sand() {
    return (
        <>
            <path d="M9.5 6 H14.5 L12 11 Z" fill="currentColor" stroke="none" />
            <path d="M9.5 18 H14.5 L12 13 Z" fill="currentColor" stroke="none" />
        </>
    );
}

export function TimeUpGlyph({ className, ...props }) {
    return (<svg {...SVG} className={className} {...props}><Hourglass /></svg>);
}

export function TimeGrantedGlyph({ className, ...props }) {
    return (
        <svg {...SVG} className={className} {...props}>
            <Hourglass /><Sand />
            <path d="M19.5 3 V8 M17 5.5 H22" />
        </svg>
    );
}

export function TimeDeniedGlyph({ className, ...props }) {
    return (
        <svg {...SVG} className={className} {...props}>
            <Hourglass /><Sand />
            <path d="M17.5 3.5 L22 8 M22 3.5 L17.5 8" />
        </svg>
    );
}
