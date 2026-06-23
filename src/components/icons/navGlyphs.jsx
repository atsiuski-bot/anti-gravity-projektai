/**
 * Navigation glyphs (icon-system ADR 0010 §"Nav wayfinding"). Each primary destination gets a
 * deliberately unique silhouette, and personal-vs-team is a one-glance pattern-match: the SAME
 * base silhouette + a reusable two-heads "team" badge in the bottom-right corner. This removes
 * the History-used-twice collision (Ataskaitos vs Kom. ataskaitos) and frees `Users` from
 * double-duty (it no longer marks the team calendar).
 *
 * Drawing canon: 24px grid, 2px stroke, rounded joins, `currentColor` so the nav's active
 * (brand) / inactive (muted) text color flows straight through. The team badge sits on a small
 * white knockout so it reads as an applied modifier on the light nav surface; it is identical on
 * every team destination — only the base changes. Vartotojai keeps lucide `UserCog` (people as
 * SUBJECT, full scale) so "manage people" can never be confused with "team scope".
 *
 * Each component takes `className` (size + color via the consumer) and spreads the rest onto the
 * <svg> so `aria-hidden` lands on the element.
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

// The shared "team" modifier — two heads on a white knockout, bottom-right. Internal helper
// (not exported) so the file stays a clean set of nav-glyph components.
function TeamBadgeMark() {
    return (
        <g>
            <circle cx="17.5" cy="17.5" r="6.5" className="fill-white" stroke="none" />
            <circle cx="15.8" cy="16.4" r="1.7" fill="currentColor" stroke="none" />
            <path d="M12.8 21.2 a3 2.4 0 0 1 6 0" fill="currentColor" stroke="none" />
            <circle cx="20" cy="17.2" r="1.9" fill="currentColor" stroke="none" />
            <path d="M16.8 21.8 a3.2 2.6 0 0 1 6.4 0" fill="currentColor" stroke="none" />
        </g>
    );
}

// --- Tasks: a clipboard with a checked row ---
function TasksBase() {
    return (
        <>
            <rect x="5" y="4" width="14" height="17" rx="2.5" />
            <path d="M9.5 4 V3.4 A1.5 1.5 0 0 1 11 1.9 h2 A1.5 1.5 0 0 1 14.5 3.4 V4" />
            <path d="M8.5 11 l1.8 1.8 l3.4 -4" />
            <line x1="8.5" y1="16.5" x2="13" y2="16.5" />
        </>
    );
}
export function TasksGlyph({ className, ...props }) {
    return (<svg {...SVG} className={className} {...props}><TasksBase /></svg>);
}
export function TasksTeamGlyph({ className, ...props }) {
    return (<svg {...SVG} className={className} {...props}><TasksBase /><TeamBadgeMark /></svg>);
}

// --- Calendar: a header + grid with a marked "today" cell ---
function CalendarBase() {
    return (
        <>
            <rect x="4" y="5" width="16" height="15" rx="2.5" />
            <line x1="4" y1="9" x2="20" y2="9" />
            <line x1="8.5" y1="3" x2="8.5" y2="6" />
            <line x1="15.5" y1="3" x2="15.5" y2="6" />
            <rect x="7" y="12" width="3.6" height="3.6" rx="0.8" fill="currentColor" stroke="none" />
        </>
    );
}
export function CalendarGlyph({ className, ...props }) {
    return (<svg {...SVG} className={className} {...props}><CalendarBase /></svg>);
}
export function CalendarTeamGlyph({ className, ...props }) {
    return (<svg {...SVG} className={className} {...props}><CalendarBase /><TeamBadgeMark /></svg>);
}

// --- Reports: a document with three ascending bars (analytics, not an event log) ---
function ReportsBase() {
    return (
        <>
            <rect x="5" y="3" width="14" height="18" rx="2.5" />
            <line x1="9" y1="16.5" x2="9" y2="13" />
            <line x1="12" y1="16.5" x2="12" y2="10" />
            <line x1="15" y1="16.5" x2="15" y2="7.5" />
        </>
    );
}
export function ReportsGlyph({ className, ...props }) {
    return (<svg {...SVG} className={className} {...props}><ReportsBase /></svg>);
}
export function ReportsTeamGlyph({ className, ...props }) {
    return (<svg {...SVG} className={className} {...props}><ReportsBase /><TeamBadgeMark /></svg>);
}
