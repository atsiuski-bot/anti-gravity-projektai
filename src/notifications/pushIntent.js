/**
 * PUSH INTENT — the app side of a tapped background notification (ADR 0024).
 *
 * A decision button on an OS notification does NOT decide anything. The service worker
 * (public/firebase-messaging-sw.js) has no auth and no Firestore, and none of the in-app card's
 * guards — the "another manager already decided" re-read, the deleted-task self-heal, the undo
 * window, the localized error banner. So the button's whole job is to hand the app an INTENT:
 * "the user pressed `approve` on notification X". The app then runs the SAME handler the in-app
 * card's button runs, and every guarantee is identical whether the tap landed on a lockscreen or
 * in the bell.
 *
 * An intent reaches us on one of two paths, chosen by the worker:
 *   1. postMessage — the app was already running. The normal case, no reload.
 *   2. the query string — the app was closed, so the worker cold-started it with the intent in the
 *      URL. Read ONCE here at module load and immediately stripped, so a later reload or a shared
 *      link can never replay a decision.
 *
 * Shape: { action, notifId, notifType, link, seq }. `action` is '' for a plain tap on the body
 * (route only, decide nothing). `seq` is a monotonic id that lets a consumer prove it has already
 * handled this exact intent — React StrictMode double-invokes effects in dev, and re-running a
 * decision because of that would be a real double write.
 */

// MIRROR of the same four constants in public/firebase-messaging-sw.js — rename one, rename both.
export const PUSH_INTENT_MESSAGE = 'workz-notification-intent';
const PARAM_ACTION = 'na';
const PARAM_NOTIF = 'nid';
const PARAM_TYPE = 'nt';

let seq = 0;
const nextSeq = () => { seq += 1; return seq; };

/**
 * The cold-start intent, captured at MODULE LOAD.
 *
 * The timing is deliberate: this module is imported (via NotificationsContext → App) before
 * ReactDOM renders, so the strip below happens before react-router ever reads window.location.
 * Doing it later would fight the router — NavigationContext mirrors the active tab back into the
 * URL from its own copy of the search params, which would resurrect the intent params we removed.
 */
const urlIntent = (() => {
    if (typeof window === 'undefined' || !window.location) return null;
    let url;
    try {
        url = new URL(window.location.href);
    } catch {
        return null;
    }
    const action = url.searchParams.get(PARAM_ACTION);
    if (!action) return null;

    const intent = {
        action,
        notifId: url.searchParams.get(PARAM_NOTIF) || '',
        notifType: url.searchParams.get(PARAM_TYPE) || '',
        // The tab to land on is whatever is left of the URL once the intent params are gone.
        link: '',
        seq: nextSeq(),
    };

    [PARAM_ACTION, PARAM_NOTIF, PARAM_TYPE].forEach((p) => url.searchParams.delete(p));
    intent.link = `${url.pathname}${url.search}`;
    try {
        window.history.replaceState(window.history.state, '', intent.link);
    } catch {
        /* replaceState can throw in exotic embeddings — the intent is still valid, just re-playable
           on a manual reload. Not worth failing the boot over. */
    }
    return intent;
})();

let urlIntentTaken = false;

/**
 * The cold-start intent, exactly once. Every later call returns null, so two consumers can both
 * ask without the second one re-running a decision.
 */
export function takeUrlPushIntent() {
    if (urlIntentTaken) return null;
    urlIntentTaken = true;
    return urlIntent;
}

/**
 * Subscribe to intents posted by the service worker while the app is running.
 *
 * The FCM worker lives at its own scope and does NOT control this page, but `Client.postMessage`
 * reaches an uncontrolled window all the same — the message surfaces on `navigator.serviceWorker`
 * with the sending worker as its source. Returns an unsubscribe function.
 */
export function subscribePushIntent(handler) {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
    const onMessage = (event) => {
        const d = event.data;
        if (!d || d.type !== PUSH_INTENT_MESSAGE) return;
        handler({
            action: typeof d.action === 'string' ? d.action : '',
            notifId: typeof d.notifId === 'string' ? d.notifId : '',
            notifType: typeof d.notifType === 'string' ? d.notifType : '',
            link: typeof d.link === 'string' ? d.link : '/',
            seq: nextSeq(),
        });
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

/**
 * The app tab a notification link points at ('/?tab=tasks' → 'tasks'). Returns null when the link
 * names no tab, so the caller can leave the current tab alone rather than guessing a default.
 */
export function tabFromLink(link) {
    if (!link) return null;
    try {
        return new URL(link, window.location.origin).searchParams.get('tab');
    } catch {
        return null;
    }
}
