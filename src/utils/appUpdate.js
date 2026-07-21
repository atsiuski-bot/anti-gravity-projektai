// Forced app update — the manual escape hatch from a stale installed PWA.
//
// A PWA that is already installed keeps serving the service worker's cached build until that worker
// is replaced. The automatic path (PwaUpdatePrompt) only offers an update once the browser happens
// to notice a new worker, so a phone that never gets that far can run a months-old build for weeks
// — and the app looks fine while behaving by old rules. There is no way to tell from the outside,
// which makes "reinstall the app" the only advice anyone can give. This is that advice as a button.
//
// Deliberately built on the raw ServiceWorker API rather than vite-plugin-pwa's `useRegisterSW`
// hook: that hook REGISTERS a worker as a side effect, and it is already called once in
// PwaUpdatePrompt. Calling it a second time would mean two registrations for one app.
//
// Firestore's offline data (including writes still queued for the server) lives in IndexedDB, which
// none of this touches — a forced update never discards unsent work.

// How long to wait for the new worker to take control before reloading anyway. The reload is what
// the user asked for; the handover is only an optimisation, so it must never block indefinitely.
const CONTROLLER_CHANGE_TIMEOUT_MS = 3000;

/**
 * Check for a newer build, activate it if one is waiting, then reload.
 * Always reloads — even with no service worker, no update, or a failed check — because the user
 * asked for a fresh start and must never be left looking at an unchanged screen wondering.
 */
export async function forceAppUpdate() {
    try {
        if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();

            // Ask each worker to re-fetch its script. This is the step the hourly background check
            // performs; doing it on demand is what makes the button useful on a device whose
            // check never fired.
            await Promise.all(registrations.map((r) => r.update().catch(() => undefined)));

            // A build downloaded earlier can sit in `waiting` indefinitely: by spec a new worker
            // will not take over while the old one still controls a tab. Telling it to skip that
            // wait is what turns "downloaded" into "running".
            const waiting = registrations.map((r) => r.waiting).find(Boolean);
            if (waiting) {
                await new Promise((resolve) => {
                    const done = () => resolve();
                    navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
                    waiting.postMessage({ type: 'SKIP_WAITING' });
                    setTimeout(done, CONTROLLER_CHANGE_TIMEOUT_MS);
                });
            }
        }
    } catch {
        // Any failure here (blocked worker, private mode, unsupported browser) still leaves the
        // reload below worth doing, so it is swallowed rather than surfaced.
    }

    window.location.reload();
}
