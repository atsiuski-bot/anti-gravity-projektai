import { lazy } from 'react';

const AUTO_RECOVERY_KEY = 'workz_stale_chunk_recovery_at';
const AUTO_RECOVERY_WINDOW_MS = 60 * 1000;
const CONTROLLER_CHANGE_TIMEOUT_MS = 3000;
const WORKER_INSTALL_TIMEOUT_MS = 2000;

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

const clearStaleAppShell = async (registrations) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

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
