import { useCallback, useEffect, useState } from 'react';

// PWA install state, centralized so every surface (the slim banner and the Profile entry) reads
// ONE source of truth and behaves identically.
//
// The hard part is timing. Chrome fires `beforeinstallprompt` very early — typically BEFORE this
// React tree (heavily code-split, Firebase-laden) has mounted. A component that only starts
// listening inside a useEffect therefore misses the event and can never offer install. The fix
// lives in index.html: a tiny inline script captures the event synchronously, stashes it on
// `window.__deferredInstallPrompt`, and re-emits `pwa-install-available`. This hook seeds from that
// global on mount (covers an early fire) AND subscribes to the re-emitted event (covers a later
// fire), so the prompt is never lost to a race.

const INSTALL_AVAILABLE_EVENT = 'pwa-install-available';
const APP_INSTALLED_EVENT = 'pwa-app-installed';

function detectIOS() {
    const ua = navigator.userAgent || '';
    // iPadOS 13+ masquerades as desktop Safari ("Macintosh"); a touch-capable Mac is really an
    // iPad. Catch both so the manual "Add to Home Screen" path still reaches tablets.
    return (
        (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) ||
        (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
    );
}

function detectStandalone() {
    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true ||
        document.referrer.includes('android-app://')
    );
}

/**
 * useInstallPrompt — read PWA installability and trigger the native install dialog.
 *
 * Returns:
 *  - `canPromptNative` — a captured `beforeinstallprompt` is available (Android/desktop Chrome);
 *    `promptInstall()` will show the OS dialog.
 *  - `isIOS` — iOS/iPadOS Safari, where install is manual (no native prompt event exists).
 *  - `isStandalone` — already launched as an installed app; install affordances should hide.
 *  - `promptInstall()` — fire the native dialog; resolves to 'accepted' | 'dismissed' |
 *    'unavailable' (no native prompt — caller should show manual steps instead).
 */
export function useInstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState(() => window.__deferredInstallPrompt || null);
    const [isIOS] = useState(detectIOS);
    const [isStandalone, setIsStandalone] = useState(detectStandalone);

    useEffect(() => {
        // Re-seed in case the event landed between the initial render and this effect attaching.
        if (window.__deferredInstallPrompt) setDeferredPrompt(window.__deferredInstallPrompt);

        const onAvailable = () => setDeferredPrompt(window.__deferredInstallPrompt || null);
        const onInstalled = () => {
            window.__deferredInstallPrompt = null;
            setDeferredPrompt(null);
            setIsStandalone(true);
        };
        // Defensive: if the inline capture in index.html were ever stripped, still catch the event
        // here (only for fires after mount) and keep the global in sync so promptInstall finds it.
        const onBeforeInstallPrompt = (e) => {
            e.preventDefault();
            window.__deferredInstallPrompt = e;
            setDeferredPrompt(e);
        };

        window.addEventListener(INSTALL_AVAILABLE_EVENT, onAvailable);
        window.addEventListener(APP_INSTALLED_EVENT, onInstalled);
        window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
        window.addEventListener('appinstalled', onInstalled);

        return () => {
            window.removeEventListener(INSTALL_AVAILABLE_EVENT, onAvailable);
            window.removeEventListener(APP_INSTALLED_EVENT, onInstalled);
            window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
            window.removeEventListener('appinstalled', onInstalled);
        };
    }, []);

    const promptInstall = useCallback(async () => {
        const evt = deferredPrompt || window.__deferredInstallPrompt;
        if (!evt) return 'unavailable';
        evt.prompt();
        const { outcome } = await evt.userChoice;
        // A beforeinstallprompt event can be used only once — drop it everywhere.
        window.__deferredInstallPrompt = null;
        setDeferredPrompt(null);
        return outcome;
    }, [deferredPrompt]);

    return {
        canPromptNative: !!deferredPrompt,
        isIOS,
        isStandalone,
        promptInstall,
    };
}
