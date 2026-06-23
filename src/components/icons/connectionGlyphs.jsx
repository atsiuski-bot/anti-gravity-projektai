/**
 * Connection feedback glyphs (icon-system ADR 0010 §"Empty states + connection"). The offline
 * banner's message is "saved on your phone, will sync later" — but a bare WifiOff reads as
 * "no wifi", a different (and more alarming) claim. A cloud with a down-arrow says "stored
 * locally now"; the syncing variant adds a refresh ring. Slate/indigo only — never red (red is
 * reserved for the quick-work session) and never the call blue.
 *
 * Drawing canon: 24px grid, 2px stroke, rounded joins, `currentColor` (the banner is slate with
 * white text, so the glyph inherits white). Components-only file.
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

// Offline: data is being kept on the device (cloud + down-arrow into local storage).
export function ConnectionOfflineGlyph({ className, ...props }) {
    return (
        <svg {...SVG} className={className} {...props}>
            <path d="M7 17 a3.6 3.6 0 0 1 0.4 -7.1 a5.4 5.4 0 0 1 10.4 1 a3.4 3.4 0 0 1 -0.3 6.1" />
            <line x1="12" y1="10.5" x2="12" y2="16.5" />
            <path d="M9.5 14 l2.5 2.5 l2.5 -2.5" />
        </svg>
    );
}

// Syncing: queued local data is going back up (cloud + refresh ring).
export function ConnectionSyncingGlyph({ className, ...props }) {
    return (
        <svg {...SVG} className={className} {...props}>
            <path d="M7 17 a3.6 3.6 0 0 1 0.4 -7.1 a5.4 5.4 0 0 1 10.4 1 a3.4 3.4 0 0 1 -0.3 6.1" />
            <path d="M14.5 13.5 a3 3 0 1 1 -1 -2.4" />
            <path d="M13.6 9.6 l0.4 2.2 l-2.2 0.2" />
        </svg>
    );
}
