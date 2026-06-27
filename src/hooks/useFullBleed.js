import { useRef, useState, useCallback, useLayoutEffect, useEffect } from 'react';

/**
 * useFullBleed — widen an element to fill the whole CONTENT COLUMN (everything except the desktop
 * SideRail), escaping the page's centered `max-w-7xl` cap. A viewport breakout (`50% - 50vw`) can't
 * be used: the content column is offset by the rail and is itself collapsible, so the symmetric
 * breakout would shift the element past the screen edge. Instead we measure the column's real edges
 * and set the matching negative margins so the element lines up exactly with the column.
 *
 * The column is found via the explicit `[data-content-column]` anchor that Layout puts on it (NOT via
 * "main's parent"), so this keeps working even if the shell wraps `main` in extra elements — the
 * contract is a named attribute, greppable from both ends. If the anchor is ever absent the hook
 * no-ops (element stays at its natural in-flow width), so it degrades safely rather than breaking.
 *
 * The fit is kept current by three triggers, so no single one has to be reliable:
 *   1. window `resize` — viewport width changes;
 *   2. a ResizeObserver on the column — the rail being collapsed/expanded (which fires no resize);
 *   3. a post-paint re-measure after every render — the robust backstop. It runs in a plain (async)
 *      effect AFTER the browser has painted, so it (a) catches the vertical scrollbar that appears
 *      once content fills the page and narrows the column a few px, and (b) catches the rail toggle,
 *      which re-renders the host. Crucially it never runs DURING render, so it can't block a commit.
 * Every re-measure is a no-op unless the numbers actually changed; since a horizontal-margin change
 * can't add page height, it can never toggle the vertical scrollbar, so there is no feedback loop —
 * the value settles in one extra frame and the guard then short-circuits every later call.
 *
 * `enabled` gates the breakout: pass `false` (e.g. on mobile, where there is no SideRail and the
 * column IS the viewport) to keep the element at its natural in-flow width — full-bleed there would
 * just cancel `main`'s comfortable side padding and shove content to the screen edge. When it flips
 * from true → false the hook resets the margins back to null (one render), so toggling across the
 * breakpoint is clean.
 *
 * Returns [ref, style]: attach the ref to the element root and spread the style onto it. The style is
 * null until measured (and whenever disabled, or on any surface without the desktop column), leaving
 * the element at its natural in-flow width — a safe no-op fallback.
 *
 * @param {boolean} [enabled=true] - when false, the hook stays a no-op and returns a null style.
 */
export default function useFullBleed(enabled = true) {
    const ref = useRef(null);
    const [style, setStyle] = useState(null);
    const lastRef = useRef({ ml: null, mr: null });

    const measure = useCallback(() => {
        // Disabled (e.g. mobile): make sure we are at natural width, then stop. Guard on lastRef so
        // this resets to null at most once and never churns renders while it stays disabled.
        if (!enabled) {
            if (lastRef.current.ml !== null || lastRef.current.mr !== null) {
                lastRef.current = { ml: null, mr: null };
                setStyle(null);
            }
            return;
        }
        const el = ref.current;
        const main = el?.closest('main');
        const col = el?.closest('[data-content-column]');
        if (!main || !col) return;
        const cs = getComputedStyle(main);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        const m = main.getBoundingClientRect();
        const c = col.getBoundingClientRect();
        // Pull each edge from main's content box out to the column's edge. width stays auto so the
        // element simply fills the new box — no forced width to drift out of sync sub-pixel.
        const ml = Math.round(c.left - (m.left + padL));
        const mr = Math.round((m.right - padR) - c.right);
        if (ml === lastRef.current.ml && mr === lastRef.current.mr) return; // guard: no churn, no loop
        lastRef.current = { ml, mr };
        setStyle({ marginLeft: `${ml}px`, marginRight: `${mr}px` });
    }, [enabled]);

    // Mount: initial measure + observers for changes that do NOT re-render React.
    useLayoutEffect(() => {
        measure();
        const col = ref.current?.closest('[data-content-column]');
        const ro = col ? new ResizeObserver(measure) : null;
        if (col && ro) ro.observe(col);
        window.addEventListener('resize', measure);
        return () => {
            ro?.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [measure]);

    // Post-paint backstop (see #3 above): runs after every commit, but only ever applies a real
    // change, so it settles in one frame and is otherwise a cheap no-op.
    useEffect(() => { measure(); });

    return [ref, style];
}
