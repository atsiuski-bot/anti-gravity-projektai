// Sign-in environment facts — WHICH Google handshake can physically complete on this device.
//
// Background (reported 2026-08-19): a manager who signed OUT inside the INSTALLED iOS app could
// never sign back in, while the same account signed in fine from a normal Safari tab. Firebase
// Auth's `lastLoginAt` confirmed it — no successful sign-in was ever recorded for those attempts,
// so the failure happened in the Google handshake itself, before any app logic ran.
//
// The mechanism is a WebKit change, not an app bug: in a home-screen (standalone) web app the
// popup opened by `signInWithPopup` gets a NULL `window.opener` (iOS 17.5 onward). The popup
// therefore cannot post the credential back to the page that opened it, so the flow can never
// complete there — no amount of retrying helps, and signing out becomes a one-way door out of the
// installed app.
//
// A redirect has no opener to lose, so it is the only handshake left in that one environment.
// Everywhere else the popup is still the RIGHT choice — Firebase recommends it precisely because
// it is immune to the third-party-storage blocking that breaks redirects — so this narrows the
// switch to iOS-standalone only and leaves every other browser untouched.

/** sessionStorage key marking "we navigated away for a redirect sign-in and expect a result back". */
export const REDIRECT_PENDING_KEY = 'workz_auth_redirect_pending';
/** sessionStorage key carrying a coded sign-in failure across a page load, for Login to render. */
export const LOGIN_ERROR_KEY = 'workz_auth_login_error';
/** Fired when a failure is parked, so a Login page that mounted FIRST still learns about it. */
export const LOGIN_ERROR_EVENT = 'workz-login-error';

/**
 * Read the two environment facts that decide the handshake. Kept as a plain descriptor (rather
 * than reading globals deep inside the decision) so the decision itself stays pure and testable.
 *
 * @param {Window} [win] - injectable for tests.
 * @returns {{ios: boolean, standalone: boolean}}
 */
export function readSignInEnvironment(win = typeof window !== 'undefined' ? window : undefined) {
    const nav = win?.navigator;
    const ua = nav?.userAgent || '';
    // iPadOS 13+ reports itself as desktop Safari ("Macintosh"); a touch-capable Mac is really an
    // iPad, and it carries the same WebKit popup limitation.
    const ios =
        (/iPad|iPhone|iPod/.test(ua) && !win?.MSStream) ||
        (/Macintosh/.test(ua) && (nav?.maxTouchPoints || 0) > 1);
    const standalone =
        win?.matchMedia?.('(display-mode: standalone)')?.matches === true ||
        nav?.standalone === true;
    return { ios, standalone };
}

/**
 * True when `signInWithPopup` cannot possibly complete here, so sign-in must go through a redirect.
 * Deliberately narrow: ONLY the installed iOS/iPadOS app. An installed Android/desktop app keeps a
 * working `window.opener`, and there the popup remains the more reliable path.
 *
 * @param {{ios?: boolean, standalone?: boolean}} env - from readSignInEnvironment().
 */
export function isPopupSignInBlocked(env) {
    return !!env?.ios && !!env?.standalone;
}

/**
 * Which origin serves the Google sign-in helper (`/__/auth/*`) — i.e. Firebase's `authDomain`.
 *
 * Firebase's own origin is the better default and stays the answer nearly everywhere: the popup
 * flow does not care that the helper is cross-origin, and letting Firebase host it means never
 * having to keep a copy in step.
 *
 * The installed iOS app is where that reasoning inverts, because there BOTH routes are shut. The
 * popup cannot run at all (null `window.opener`, above), leaving only a redirect — and a
 * redirect's return leg reads the credential back through an iframe on the HELPER's origin, which
 * is precisely the third-party storage Safari partitions away. Pointing that one environment at
 * our own origin (where `public/__/auth/` serves a vendored copy of the same helper) removes the
 * third party instead of arguing with it: same-origin storage is never partitioned.
 *
 * Two properties worth keeping:
 *   - It reads `location.host`, so the helper always comes from whichever origin actually served
 *     the app, rather than a hardcoded domain that silently rots on a rename.
 *   - Every fallback lands on `hostedDomain`. Without a DOM (tests, SSR) or without a host there
 *     is nothing to self-host FROM, and the hosted helper is the only answer that can work.
 *
 * Each origin used this way needs its `/__/auth/handler` URL authorized in the Google OAuth
 * client — see docs/runbooks/firebase-auth-helper-selfhost.md.
 *
 * @param {string} hostedDomain - Firebase's `<project>.firebaseapp.com`.
 * @param {Window} [win] - injectable for tests.
 */
export function resolveAuthDomain(hostedDomain, win = typeof window !== 'undefined' ? window : undefined) {
    try {
        if (isPopupSignInBlocked(readSignInEnvironment(win))) {
            const host = win?.location?.host;
            if (host) return host;
        }
    } catch {
        /* no DOM at all — fall through to the hosted helper */
    }
    return hostedDomain;
}

/** Remember that a redirect sign-in is in flight. Never throws (storage may be unavailable). */
export function markRedirectPending() {
    try { sessionStorage.setItem(REDIRECT_PENDING_KEY, '1'); } catch { /* storage disabled */ }
}

/** Consume the in-flight marker; true when THIS load is the return leg of a redirect sign-in. */
export function takeRedirectPending() {
    try {
        const pending = sessionStorage.getItem(REDIRECT_PENDING_KEY) === '1';
        sessionStorage.removeItem(REDIRECT_PENDING_KEY);
        return pending;
    } catch {
        return false;
    }
}

/**
 * Park a coded sign-in failure so the Login page can show it AFTER a full page load. The redirect
 * handshake fails on a different document than the one that started it, so the usual
 * throw-and-catch cannot carry the reason across — without this the user is simply dropped back on
 * the login screen with no explanation at all.
 */
export function rememberLoginError(code) {
    try { sessionStorage.setItem(LOGIN_ERROR_KEY, code); } catch { /* storage disabled */ }
    // The redirect result resolves asynchronously, so Login may already be on screen by the time
    // the failure is known. Storage alone would only be read on the NEXT mount — i.e. never, for
    // the person staring at the login button right now.
    try { window.dispatchEvent(new CustomEvent(LOGIN_ERROR_EVENT, { detail: { code } })); } catch { /* no DOM */ }
}

/** Read and clear a parked sign-in failure code. */
export function takeLoginError() {
    try {
        const code = sessionStorage.getItem(LOGIN_ERROR_KEY);
        sessionStorage.removeItem(LOGIN_ERROR_KEY);
        return code || null;
    } catch {
        return null;
    }
}
