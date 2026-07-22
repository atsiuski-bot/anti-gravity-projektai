/**
 * linkify — split free text into plain-text and URL segments so a renderer can turn bare pasted
 * URLs into clickable links. Pure string logic, deliberately kept out of the React component file
 * (so fast-refresh stays happy and the parsing is unit-testable on its own).
 *
 * We only ever recognise `http(s)://…` and `www.…` matches — never `javascript:` or other schemes —
 * so pasted text can't smuggle an executable URL into a link.
 */

// http(s) URLs, or www.-prefixed bare domains. Deliberately conservative: a leading scheme or a
// literal "www." anchor, so ordinary words with dots ("v1.2", "file.txt") are left as plain text.
const URL_PATTERN = /((?:https?:\/\/|www\.)[^\s<]+)/gi;

// Trailing punctuation that is almost always sentence/clause punctuation, not part of the URL
// (e.g. "see http://x.lt." or "(http://x.lt)"). Trimmed off the link and rendered as plain text.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"»]+$/;

// What must SURVIVE the peel for a match to still be a link: a whole anchor (scheme or "www.")
// plus at least one character to point at. The peel can otherwise eat the anchoring dot — "www.!"
// becomes the bare word "www" — and a bare word is a RELATIVE href: the browser resolves it
// against our own origin, so tapping it hits the SPA fallback and cold-boots a second copy of the
// PWA in a new tab, which is alarming when the first tab has a timer running. Anything that no
// longer looks like a URL goes back into the plain-text stream (fail closed: render, never link).
const USABLE_LINK = /^(?:https?:\/\/|www\.)[^\s<]+$/i;

export function splitTextWithLinks(text) {
    if (typeof text !== 'string' || text.length === 0) return [];

    const parts = [];
    let lastIndex = 0;
    let match;
    URL_PATTERN.lastIndex = 0;

    while ((match = URL_PATTERN.exec(text)) !== null) {
        const raw = match[0];
        const start = match.index;

        // Peel trailing punctuation back into the plain-text stream.
        const trailing = raw.match(TRAILING_PUNCTUATION);
        const url = trailing ? raw.slice(0, raw.length - trailing[0].length) : raw;
        const tail = trailing ? trailing[0] : '';

        if (start > lastIndex) parts.push({ type: 'text', value: text.slice(lastIndex, start) });
        if (USABLE_LINK.test(url)) {
            // Case-insensitively, because the match itself is: a phone keyboard auto-capitalises the
            // first word of a comment ("Www.regitra.lt"), and a case-sensitive test would leave that
            // one un-prefixed — the same relative-href trap the check above exists to close.
            const isBareWww = url.slice(0, 4).toLowerCase() === 'www.';
            parts.push({ type: 'link', value: url, href: isBareWww ? `https://${url}` : url });
            if (tail) parts.push({ type: 'text', value: tail });
        } else {
            // Nothing link-shaped left after the peel — emit the match verbatim, punctuation and all.
            parts.push({ type: 'text', value: raw });
        }

        lastIndex = start + raw.length;
    }

    if (lastIndex < text.length) parts.push({ type: 'text', value: text.slice(lastIndex) });
    return parts;
}
