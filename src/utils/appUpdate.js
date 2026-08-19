import { lazy } from 'react';

const AUTO_RECOVERY_KEY = 'workz_stale_chunk_recovery_at';
const AUTO_RECOVERY_WINDOW_MS = 60 * 1000;
const CONTROLLER_CHANGE_TIMEOUT_MS = 3000;
const WORKER_INSTALL_TIMEOUT_MS = 2000;
const FRESHNESS_PROBE_TIMEOUT_MS = 4000;
// How long an accepted update may take to hand this document over to the new worker before we stop
// waiting and repair instead. A real handover is sub-second (the worker is already installed and
// waiting); anything past this is one of the stuck states applyPendingUpdate() exists to break.
const HANDOVER_TIMEOUT_MS = 3500;

const STALE_CHUNK_PATTERNS = [
    /failed to fetch dynamically imported module/i,
    /error loading dynamically imported module/i,
    /importing a module script failed/i,
    /chunkloaderror/i,
    /loading chunk .+ failed/i,
    /unable to preload css/i,
];

const errorMessage = (error) => {
    if (typeof error === 'string') return error;
    if (typeof error?.message === 'string') return error.message;
    if (typeof error?.reason?.message === 'string') return error.reason.message;
    return '';
};

export function isStaleChunkLoadError(error) {
    const message = errorMessage(error);
    return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(message));
}

const claimAutomaticRecovery = () => {
    if (typeof sessionStorage === 'undefined') return false;

    try {
        const now = Date.now();
        const previous = Number(sessionStorage.getItem(AUTO_RECOVERY_KEY));
        if (Number.isFinite(previous) && previous > 0 && Math.abs(now - previous) < AUTO_RECOVERY_WINDOW_MS) {
            return false;
        }
        sessionStorage.setItem(AUTO_RECOVERY_KEY, String(now));
        return true;
    } catch {
        // Without a durable marker an automatic reload could loop forever in storage-disabled
        // browsers. Leave recovery to the visible ErrorBoundary action instead.
        return false;
    }
};

const workerScriptUrls = (registration) => [
    registration.active?.scriptURL,
    registration.waiting?.scriptURL,
    registration.installing?.scriptURL,
].filter(Boolean);

const isAppShellRegistration = (registration) => {
    const urls = workerScriptUrls(registration);
    return urls.some((url) => /\/(?:sw|dev-sw)\.js(?:[?#]|$)/.test(url))
        && urls.every((url) => !url.includes('firebase-messaging-sw.js'));
};

const waitForWaitingWorker = async (registration) => {
    if (registration.waiting) return registration.waiting;
    const installing = registration.installing;
    if (!installing) return null;

    await new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            installing.removeEventListener('statechange', onStateChange);
            resolve();
        };
        const onStateChange = () => {
            if (installing.state === 'installed' || installing.state === 'activated' || installing.state === 'redundant') {
                finish();
            }
        };
        timer = setTimeout(finish, WORKER_INSTALL_TIMEOUT_MS);
        installing.addEventListener('statechange', onStateChange);
    });

    return registration.waiting;
};

const activateWaitingWorker = async (worker) => {
    if (!worker || typeof navigator === 'undefined' || !navigator.serviceWorker) return false;

    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = (activated) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
            resolve(activated);
        };
        const onControllerChange = () => finish(true);

        timer = setTimeout(() => finish(false), CONTROLLER_CHANGE_TIMEOUT_MS);
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
        try {
            worker.postMessage({ type: 'SKIP_WAITING' });
        } catch {
            finish(false);
        }
    });
};

/**
 * Positively prove a fresh build is reachable before the installed shell may be destroyed.
 *
 * `navigator.onLine` only reports that a network INTERFACE exists. Behind a captive portal, a dead
 * mobile route or a DNS black hole it stays TRUE while nothing is actually fetchable — and the
 * previous gate trusted it. A failed update in that state therefore unregistered the app worker and
 * deleted the Workbox precache, leaving a field worker with NO app at all — unable to see or stop a
 * running timer — until real connectivity returned. Removing a WORKING offline shell is only ever
 * safe once we have positively fetched the current build from our own origin.
 *
 * The probe requests the app's own service-worker script uncached and demands three things a
 * captive portal cannot fake at once: a 2xx, a same-origin non-redirected final URL, and a
 * JavaScript content type (a portal answers any request with its own HTML login page). Any doubt —
 * a throw, a timeout, an HTML body — resolves FALSE, so the shell is KEPT. Failing closed here
 * costs at most one stale reload; failing open costs the worker the whole app.
 */
const isFreshBuildReachable = async () => {
    if (typeof fetch !== 'function' || typeof window === 'undefined') return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), FRESHNESS_PROBE_TIMEOUT_MS);
    try {
        const response = await fetch(`${window.location.origin}/sw.js?freshness=${Date.now()}`, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
            redirect: 'follow',
            signal: controller?.signal,
        });
        if (!response.ok || response.redirected) return false;
        if (new URL(response.url, window.location.origin).origin !== window.location.origin) return false;
        return /javascript|ecmascript/i.test(response.headers.get('content-type') || '');
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
};

const clearStaleAppShell = async (registrations) => {
    if (!(await isFreshBuildReachable())) return;

    await Promise.all(registrations.map((registration) => (
        registration.unregister().catch(() => false)
    )));

    if (typeof caches === 'undefined') return;
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
        .filter((name) => name.startsWith('workbox-precache'))
        .map((name) => caches.delete(name).catch(() => false)));
};

/**
 * Refresh the installed app without touching Firestore IndexedDB (including queued writes).
 * A waiting app worker is activated when possible. If the active precache is already incomplete,
 * the stale app-shell worker/cache is removed so the reload must fetch the current build.
 */
export async function forceAppUpdate() {
    let appRegistrations = [];
    let activatedWaitingWorker = false;

    try {
        if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            appRegistrations = registrations.filter(isAppShellRegistration);

            await Promise.all(appRegistrations.map((registration) => (
                registration.update().catch(() => undefined)
            )));

            for (const registration of appRegistrations) {
                const waiting = await waitForWaitingWorker(registration);
                if (waiting) {
                    activatedWaitingWorker = await activateWaitingWorker(waiting);
                    break;
                }
            }
        }
    } catch {
        // The network-fresh fallback below is the recovery path when the update check itself fails.
    }

    if (!activatedWaitingWorker) {
        try {
            await clearStaleAppShell(appRegistrations);
        } catch {
            // A reload is still useful even when private mode blocks worker/cache access.
        }
    }

    if (typeof window !== 'undefined') {
        window.location.reload();
    }
}

/**
 * Apply a downloaded update and GUARANTEE this document ends up on the new build.
 *
 * With `registerType: 'prompt'` the reload after the user accepts is done by vite-plugin-pwa, which
 * arms a single `controlling` listener and reloads only when `event.isUpdate` is true. That flag is
 * latched ONCE by workbox-window, at registration, from `navigator.serviceWorker.controller`. Two
 * states seen routinely on an installed phone defeat it, and both end with the accepted update never
 * being applied:
 *
 *  - **The document registered without a controller.** True on a first install, and on every load
 *    that follows a repair — the boot watchdog's "Atkurti programą" and `forceAppUpdate` above both
 *    unregister the worker, so the page they reload into starts uncontrolled. `isUpdate` is then
 *    false for the LIFE of that document, and an installed PWA is resumed rather than reloaded for
 *    days. The SKIP_WAITING message still activates the new worker, whose activation prunes the
 *    previous build's precache entries — while the running page is still the OLD bundle. Every lazy
 *    chunk it had not loaded yet is now missing from the cache AND (after a deploy) from the origin,
 *    so the installed app rots view by view while the same site in the browser is fine.
 *  - **Nothing is waiting anymore when the prompt is tapped.** The prompt lives in React state, so it
 *    survives every background/resume cycle; meanwhile the worker may have activated on its own (all
 *    clients went away) or gone redundant. `messageSkipWaiting()` is a documented no-op with no
 *    waiting worker, so no controller change is ever emitted.
 *
 * Neither case reloaded and neither cleared the prompt: the button kept spinning and, because it also
 * disabled "Vėliau", the notice could not even be dismissed. In standalone there is no address bar to
 * refresh, which is why the reported escape hatch was "open it in the browser instead".
 *
 * So the handover is owned here rather than delegated: reload the instant control changes, and if it
 * has not changed by `timeoutMs`, fall through to the full repair — which re-checks for a worker,
 * activates it, and reloads in every branch. The exit is always a reload, never a stuck prompt.
 */
export function applyPendingUpdate(requestSkipWaiting, {
    timeoutMs = HANDOVER_TIMEOUT_MS,
    repair = forceAppUpdate,
} = {}) {
    const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    const reloadNow = () => {
        if (typeof window !== 'undefined') window.location.reload();
    };

    return new Promise((resolve) => {
        let settled = false;
        let timer;

        const finish = (action) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            container?.removeEventListener?.('controllerchange', onControllerChange);
            // A failing repair must still land the user on a fresh document — a reload of a stale
            // build is recoverable, a prompt that never resolves is not.
            resolve(Promise.resolve().then(action).catch(reloadNow));
        };

        function onControllerChange() {
            finish(reloadNow);
        }

        container?.addEventListener?.('controllerchange', onControllerChange);
        timer = setTimeout(() => finish(repair), timeoutMs);

        Promise.resolve()
            .then(requestSkipWaiting)
            .catch(() => finish(repair));
    });
}

/**
 * Claim and start one automatic recovery attempt for a stale hashed asset.
 *
 * DECISION 2026-07-24: a broken installed build may reload itself once, but never loop.
 * A repeat failure within one minute falls through to the visible ErrorBoundary action.
 */
export function tryRecoverFromStaleChunk(error, refresh = forceAppUpdate) {
    if (!isStaleChunkLoadError(error)) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (!claimAutomaticRecovery()) return false;

    try {
        Promise.resolve(refresh()).catch(() => {
            if (typeof window !== 'undefined') window.location.reload();
        });
    } catch {
        if (typeof window !== 'undefined') window.location.reload();
    }
    return true;
}

/**
 * React.lazy wrapper that turns a stale deploy hash into a single controlled app refresh.
 * The unresolved promise keeps the current Suspense fallback mounted until navigation reloads.
 */
export function lazyWithRecovery(importer) {
    return lazy(() => Promise.resolve()
        .then(importer)
        .catch((error) => {
            if (tryRecoverFromStaleChunk(error)) {
                return new Promise(() => {});
            }
            throw error;
        }));
}

let preloadRecoveryInstalled = false;

export function installStaleChunkRecovery() {
    if (preloadRecoveryInstalled || typeof window === 'undefined') return;
    preloadRecoveryInstalled = true;

    window.addEventListener('vite:preloadError', (event) => {
        if (tryRecoverFromStaleChunk(event.payload)) {
            event.preventDefault();
        }
    });
}
