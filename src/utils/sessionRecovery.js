// Recovery from a sign-in the database has not caught up with yet — the small, pure decisions
// behind it, extracted so they can be unit-tested without the Firebase machinery.
//
// Background: Firestore runs with multi-tab persistence (firebase.js), so when the app is open in
// more than one window/tab on a device, only ONE of them (the "primary") talks to the server, and
// it does so with ITS OWN view of who is signed in. Firebase Auth syncs that view between windows
// by polling, so a window that has just signed in can have its requests sent by a primary that
// still thinks nobody is signed in — or, if that window is throttled or frozen in the background,
// keeps thinking so for much longer. The server then rejects them as permission-denied, even the
// read of the user's OWN document, which firestore.rules grants to any signed-in user
// unconditionally. That rule is why such a denial can only mean "the database did not see the
// sign-in" and is safe to retry: it is never a real lack of access.

/** Back-off ladder (ms) between server reads while waiting for the database to recognise a user. */
const RECOGNITION_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/**
 * How long the LOGIN flow waits for recognition before telling the person what to do. Long enough
 * for a background window to catch up, short enough not to leave them staring at a spinner.
 */
export const LOGIN_RECOGNITION_WAIT_MS = 15 * 1000;

/**
 * How long an already-open session keeps checking in the background. The usual way out of a
 * window that never catches up is the person closing it or switching to it, which can take a
 * while; a probe every 8 s for a few minutes costs a few dozen tiny reads, once.
 */
export const LISTENER_RECOGNITION_WAIT_MS = 3 * 60 * 1000;

/**
 * Pause before the given (0-based) recognition attempt: a short ladder, then a steady 8 s.
 *
 * @param {number} attempt
 * @returns {number} milliseconds
 */
export function recognitionDelayMs(attempt) {
    const index = Math.min(Math.max(0, attempt), RECOGNITION_DELAYS_MS.length - 1);
    return RECOGNITION_DELAYS_MS[index];
}

/** sessionStorage key holding when this tab last reloaded to recover a session. */
export const SESSION_RECOVERY_RELOAD_KEY = 'workz_session_recovery_reload_at';

/** Minimum gap between two recovery reloads of the same tab — the guard against a reload loop. */
export const SESSION_RECOVERY_RELOAD_COOLDOWN_MS = 60 * 1000;

/**
 * Whether this tab may reload now to rebuild listeners that the database rejected before it
 * recognised the sign-in. A reload is the only way to revive them all (a rejected Firestore
 * listener never re-subscribes), but it must never loop.
 *
 * @param {string|null} lastReloadAt - the stored timestamp (ms, as a string), or null if none.
 * @param {number} now - Date.now().
 * @returns {boolean}
 */
export function shouldReloadForSessionRecovery(lastReloadAt, now) {
    const last = Number(lastReloadAt);
    // Missing, unparseable, or in the future (the device clock moved back) — no usable record.
    if (!Number.isFinite(last) || last <= 0 || last > now) return true;
    return now - last >= SESSION_RECOVERY_RELOAD_COOLDOWN_MS;
}
