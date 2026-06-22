/**
 * Role/rank insignia (icon-system ADR 0007 §"Role insignia"). A chevron ladder read by
 * COUNTING — so the 4-level hierarchy is legible at scan time and Vadovas vs Vyr. vadovas (today
 * color-identical) differ by shape, not color:
 *   Vykdytojas  — no insignia (absence is the signal; keeps the default calm)
 *   Vadovas     — one up-chevron
 *   Vyr. vadovas — two stacked up-chevrons
 *   Administratorius — a shield (a different KIND of authority, per founder; shield only, no chevrons)
 *
 * Drawing canon: 24px grid, 2px stroke, rounded joins, `currentColor` so each glyph inherits
 * the role pill's text tone. Rank rides shape/count, never color. Components-only file (the
 * role -> glyph map lives in ./roleInsigniaMap.js).
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

export function RoleManagerGlyph({ className, ...props }) {
    return (
        <svg {...SVG} className={className} {...props}>
            <path d="M5 15 l7 -6 l7 6" />
        </svg>
    );
}

export function RoleSeniorGlyph({ className, ...props }) {
    return (
        <svg {...SVG} className={className} {...props}>
            <path d="M5 17 l7 -6 l7 6" />
            <path d="M5 11 l7 -6 l7 6" />
        </svg>
    );
}

export function RoleAdminGlyph({ className, ...props }) {
    return (
        <svg {...SVG} className={className} {...props}>
            <path d="M12 3 L19 6 V11 Q19 16.5 12 20.5 Q5 16.5 5 11 V6 Z" />
        </svg>
    );
}
