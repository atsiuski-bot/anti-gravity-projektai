import React from 'react';
import { splitTextWithLinks } from '../../utils/linkify';

/**
 * Linkify — turn bare URLs inside free text into safe, clickable links.
 *
 * Workers and managers paste raw links (a Drive folder, a Maps pin, a form) straight into a task
 * description or comment. Rendered as plain text they are dead — the user has to select-copy-paste
 * into a browser. This splits the text on URL boundaries and renders each URL as an anchor while
 * leaving every other character untouched, so surrounding whitespace (the caller keeps
 * `whitespace-pre-wrap`) and punctuation survive exactly.
 *
 * Safety: links open in a new tab with `rel="noopener noreferrer nofollow"` so the opened page can
 * neither reach back into our `window` nor inherit referrer/ranking signal. The click is stopped
 * from bubbling so opening a link inside a tappable card never also triggers the card.
 */
export default function Linkify({ text, className }) {
    const parts = splitTextWithLinks(text);
    if (parts.length === 0) return null;

    return (
        <>
            {parts.map((part, i) =>
                part.type === 'link' ? (
                    <a
                        key={i}
                        href={part.href}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        onClick={(e) => e.stopPropagation()}
                        className={
                            className ??
                            'break-all font-medium text-brand underline decoration-brand/40 underline-offset-2 ' +
                                'hover:decoration-brand focus-visible:outline-none focus-visible:ring-2 ' +
                                'focus-visible:ring-brand focus-visible:ring-offset-1 rounded-sm'
                        }
                    >
                        {part.value}
                    </a>
                ) : (
                    <React.Fragment key={i}>{part.value}</React.Fragment>
                ),
            )}
        </>
    );
}
