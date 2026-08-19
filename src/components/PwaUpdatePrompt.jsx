import { useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, CheckCircle2, X } from 'lucide-react';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import { applyPendingUpdate } from '../utils/appUpdate';

// A field worker keeps the app open all day, so the browser's load-time check never fires and a
// new deploy would go unseen. Re-ask the browser to look for a fresh service worker on this
// cadence (skipping when offline or mid-install) so the update prompt below can actually appear.
const UPDATE_CHECK_MS = 60 * 60 * 1000; // hourly

// The installed app is RESUMED, not reloaded: its document survives days of pocket/unlock cycles, so
// the load-time check runs about as often as the phone reboots. The interval above cannot cover that
// either — iOS suspends timers the moment the app is backgrounded, so a phone opened in short bursts
// (unlock, start a timer, pocket) can go a whole day without one hourly tick ever firing. Meanwhile a
// deploy has already replaced the hashed assets that document still points at. So also check when the
// app returns to the foreground, throttled to this floor so a quick app-switch costs nothing.
const RESUME_CHECK_MS = 15 * 60 * 1000;

// The first-install "ready offline" confirmation is a calm, one-off reassurance, not an action.
// It dismisses itself so it never lingers over the work surface.
const OFFLINE_READY_MS = 6000;

/**
 * PwaUpdatePrompt — the accessible, in-app surface for the PWA service-worker lifecycle,
 * replacing the banned `window.confirm` update prompt (DESIGN_SYSTEM §8).
 *
 * Two transient, bottom-docked states (driven by vite-plugin-pwa's `prompt` registerType):
 *  - `needRefresh` — a new service worker is waiting. Offer a *controlled* reload so a worker is
 *    never silently reloaded mid-task; they choose when to apply it.
 *  - `offlineReady` — first install finished caching. A self-dismissing confirmation that the
 *    app now works without a connection.
 */
export default function PwaUpdatePrompt() {
    const [reloading, setReloading] = useState(false);
    // Held so the hourly poll can be stopped when this component goes away — an interval closed
    // over a stale registration would otherwise keep firing for the life of the document.
    const updateCheckRef = useRef(null);
    // The live registration + when it was last asked for a new worker, shared by the hourly tick and
    // the resume check so the two throttle each other instead of double-fetching the worker script.
    const registrationRef = useRef(null);
    const lastCheckRef = useRef(0);

    // One shared check for both triggers. Best-effort, exactly like appUpdate.js: update() REJECTS
    // when the worker-script fetch fails, which is routine on the half-open / captive-portal links
    // these phones sit on all day (navigator.onLine is still true there). Unhandled, that rejection
    // reaches the global 'unhandledrejection' hook in main.jsx and writes a bogus error_logs row
    // every hour — burying the real timer failures an admin reads that log to find. A missed check
    // just means the update prompt appears later.
    // Stable identity (it only touches refs), so the interval installed at registration and the
    // resume listener below both call the very same function.
    const checkForUpdate = useCallback(() => {
        const registration = registrationRef.current;
        if (!registration || registration.installing || !navigator.onLine) return;
        lastCheckRef.current = Date.now();
        registration.update().catch(() => { /* offline / flaky link — retry next trigger */ });
    }, []);

    const {
        needRefresh: [needRefresh, setNeedRefresh],
        offlineReady: [offlineReady, setOfflineReady],
        updateServiceWorker,
    } = useRegisterSW({
        onRegisteredSW(_swUrl, registration) {
            if (!registration) return;
            registrationRef.current = registration;
            lastCheckRef.current = Date.now(); // registering just fetched the worker script
            if (updateCheckRef.current) clearInterval(updateCheckRef.current);
            updateCheckRef.current = setInterval(checkForUpdate, UPDATE_CHECK_MS);
        },
    });

    // Stop the hourly poll on unmount.
    useEffect(() => () => {
        if (updateCheckRef.current) clearInterval(updateCheckRef.current);
    }, []);

    // Ask for a newer worker when the app is brought back to the foreground. One conditional request
    // for the worker script, and it is the ONLY trigger a resumed installed app reliably gets — so it
    // is what makes the update prompt appear on a phone at all.
    useEffect(() => {
        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            if (Date.now() - lastCheckRef.current < RESUME_CHECK_MS) return;
            checkForUpdate();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    }, [checkForUpdate]);

    // Auto-dismiss the offline-ready confirmation — it's reassurance, not a task.
    useEffect(() => {
        if (!offlineReady) return undefined;
        const timer = setTimeout(() => setOfflineReady(false), OFFLINE_READY_MS);
        return () => clearTimeout(timer);
    }, [offlineReady, setOfflineReady]);

    if (!needRefresh && !offlineReady) return null;

    const applyUpdate = () => {
        setReloading(true);
        // Do NOT rely on vite-plugin-pwa's own post-activation reload: it is armed only when this
        // document happened to be service-worker-controlled at registration time, and sending
        // skip-waiting is a no-op when nothing is waiting by the time this gets tapped. Both leave the
        // accepted update unapplied and this button spinning forever — terminal in an installed app,
        // which has no address bar to refresh with. applyPendingUpdate owns the handover instead and
        // always ends in a reload.
        applyPendingUpdate(() => updateServiceWorker(true))
            // Reachable only if the reload itself could not happen; give the buttons back rather than
            // leave a permanently disabled prompt over the work surface.
            .finally(() => setReloading(false));
    };

    return (
        // Lifted clear of the bottom navigation + floating work pill (mirrors the `pb-navclear`
        // 8rem clearance) so a worker mid-task never has their running-timer pill covered.
        <div
            className="fixed inset-x-0 bottom-0 z-toast flex justify-center px-4"
            style={{ paddingBottom: 'calc(8rem + env(safe-area-inset-bottom))' }}
        >
            {needRefresh ? (
                <div
                    role="status"
                    aria-label="Programos atnaujinimas"
                    className="flex w-full max-w-md items-start gap-3 rounded-modal border border-line bg-surface-card p-4 shadow-xl"
                >
                    <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="text-body font-semibold text-ink-strong">
                            Atnaujinta versija
                        </p>
                        <p className="text-caption text-ink-muted">
                            Paruošta naujesnė versija — atnaujinkite, kad gautumėte naujausius pakeitimus.
                        </p>
                        <div className="mt-3 flex gap-2">
                            <Button size="md" loading={reloading} onClick={applyUpdate}>
                                Atnaujinti
                            </Button>
                            <Button
                                variant="secondary"
                                size="md"
                                disabled={reloading}
                                onClick={() => setNeedRefresh(false)}
                            >
                                Vėliau
                            </Button>
                        </div>
                    </div>
                </div>
            ) : (
                <div
                    role="status"
                    aria-label="Programa paruošta neprisijungus"
                    className="flex w-full max-w-md items-start gap-3 rounded-modal border border-line bg-surface-card p-4 shadow-xl"
                >
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-feedback-success" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="text-body font-semibold text-ink-strong">
                            Paruošta neprisijungus
                        </p>
                        <p className="text-caption text-ink-muted">
                            Programa veiks ir be interneto ryšio.
                        </p>
                    </div>
                    <IconButton
                        icon={X}
                        label="Užverti"
                        onClick={() => setOfflineReady(false)}
                        className="-mr-1 -mt-1 shrink-0"
                    />
                </div>
            )}
        </div>
    );
}
