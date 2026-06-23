import { createContext, useContext, useState, useEffect, useCallback } from 'react';

/**
 * ThemeContext — the app-wide light/dark theme (ADR 0008).
 *
 * The user's CHOICE is one of three values:
 *   - 'system' (default) — follow the OS `prefers-color-scheme`
 *   - 'light'
 *   - 'dark'
 * which resolves to an effective theme ('light' | 'dark') applied as the `data-theme`
 * attribute on <html>. The CSS-variable palette in `index.css` keys off that attribute, so
 * flipping it re-paints the whole app (DESIGN_SYSTEM tokens are var-backed).
 *
 * Placement: this provider sits ABOVE AuthProvider so the theme is live pre-login and during
 * the auth spinner (AuthProvider gates its children behind a full-screen loader). It is
 * therefore auth-agnostic — it persists the choice only to localStorage. Cross-device sync to
 * the Firestore user doc is bridged by <ThemeSync> inside the authed tree (it adopts
 * `userData.themePreference`), and ProfilePage writes the doc when the user changes the theme.
 *
 * The boot script in index.html already set `data-theme` from localStorage before first paint
 * (no flash); this provider re-asserts it and keeps it in sync with runtime changes and the OS.
 */

const STORAGE_KEY = 'theme';
const VALID = ['system', 'light', 'dark'];

const ThemeContext = createContext({
    preference: 'system',
    resolvedTheme: 'light',
    setPreference: () => {},
});

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
    return useContext(ThemeContext);
}

function readStoredPreference() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return VALID.includes(stored) ? stored : 'system';
    } catch {
        return 'system';
    }
}

function prefersDark() {
    return typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }) {
    const [preference, setPreferenceState] = useState(readStoredPreference);
    // Track the OS preference so a 'system' choice re-resolves when the OS flips.
    const [systemDark, setSystemDark] = useState(prefersDark);

    const resolvedTheme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

    // Subscribe to OS changes only while following the system (cheap, and avoids reacting to
    // OS flips the user has explicitly overridden).
    useEffect(() => {
        if (preference !== 'system' || !window.matchMedia) return undefined;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (e) => setSystemDark(e.matches);
        mq.addEventListener('change', onChange);
        // Re-sync immediately in case it changed between mount and this effect.
        setSystemDark(mq.matches);
        return () => mq.removeEventListener('change', onChange);
    }, [preference]);

    // The single side-effect: reflect the resolved theme onto <html> + the PWA status-bar color.
    useEffect(() => {
        document.documentElement.dataset.theme = resolvedTheme;
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', resolvedTheme === 'dark' ? '#0E1117' : '#ffffff');
    }, [resolvedTheme]);

    // Update the choice + persist to localStorage (the offline / logged-out fallback). Firestore
    // persistence is the caller's job (ProfilePage), so this stays auth-agnostic.
    const setPreference = useCallback((next) => {
        if (!VALID.includes(next)) return;
        setPreferenceState(next);
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            /* private mode / storage disabled — the in-memory state still applies the theme */
        }
    }, []);

    return (
        <ThemeContext.Provider value={{ preference, resolvedTheme, setPreference }}>
            {children}
        </ThemeContext.Provider>
    );
}
