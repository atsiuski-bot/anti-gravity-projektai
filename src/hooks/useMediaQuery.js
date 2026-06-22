import { useState, useEffect } from 'react';

/**
 * Subscribe to a CSS media query. The initial value is read synchronously from `matchMedia`
 * so the very first paint already matches the real viewport — no layout flash.
 *
 * WHY THIS EXISTS (and why most responsive choices must NOT use it): the design system
 * mandates CSS breakpoints, not JS width flags, for visual responsive behaviour like
 * card-vs-table density (DESIGN_SYSTEM §9). This hook is reserved for the narrow case where
 * the two layouts mount DIFFERENT side effects that a CSS `hidden` toggle cannot separate —
 * because `display:none` keeps a React subtree mounted and its effects running. The concrete
 * driver: the desktop side rail and the mobile bottom bar each render the session timers,
 * whose `useTimerState` starts a `SoundManager` singleton beep and fires a screen-reader
 * live-region announcement. Keeping both in the DOM would double both. So we gate the *mount*,
 * not the *visibility*. Prefer plain `lg:`/`sm:` classes everywhere else.
 *
 * @param {string} query - e.g. '(min-width: 1024px)'
 * @returns {boolean}
 */
export function useMediaQuery(query) {
    const [matches, setMatches] = useState(() =>
        typeof window !== 'undefined' && window.matchMedia
            ? window.matchMedia(query).matches
            : false
    );

    useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return undefined;
        const mql = window.matchMedia(query);
        const onChange = (event) => setMatches(event.matches);
        // Re-sync in case the query (or viewport) changed between render and effect commit.
        setMatches(mql.matches);
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, [query]);

    return matches;
}
