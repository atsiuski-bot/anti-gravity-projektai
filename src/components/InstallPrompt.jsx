import { useEffect, useState, useCallback } from 'react';
import { Download, X } from 'lucide-react';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import InstallInstructions from './InstallInstructions';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { useMediaQuery } from '../hooks/useMediaQuery';

// We remember dismissal as a *snooze deadline* (epoch ms), not a permanent flag: one stray tap
// must not silence the single most valuable nudge forever — installing is what unlocks push
// notifications (see the iOS copy below). The banner returns by itself after the snooze window.
const SNOOZE_KEY = 'workz.installPromptSnoozeUntil';
const DAY_MS = 24 * 60 * 60 * 1000;
const SNOOZE_DAYS = 14; // manual dismiss / declined OS dialog — back off, then ask again
const INSTALLED_DAYS = 3650; // accepted/installed — effectively never ask again on this device

// In-memory fallback so a snooze also sticks within a session when localStorage is unavailable
// (private browsing), instead of re-nagging on every reload.
let sessionSnoozed = false;

/**
 * InstallPrompt — a slim, dismissible install banner (DESIGN_SYSTEM: calm canvas). It surfaces
 * only when installation is actually possible: a captured `beforeinstallprompt` (Android/desktop
 * Chrome), or iOS/iPadOS Safari where install is manual. Hidden when already installed or while
 * snoozed. Rendered once near the top of the app shell, not in the header.
 *
 * All install detection is delegated to `useInstallPrompt`, which seeds from the early-capture in
 * index.html so the banner reliably appears even when `beforeinstallprompt` fires before mount.
 * Dismissal is a time-boxed snooze, never a permanent kill: declining the banner (or the OS dialog)
 * only quiets it for `SNOOZE_DAYS`; an actual install marks it done for good.
 *
 * Desktop (lg+) is deliberately excluded: the install nudge targets phone users (the worker loop
 * lives on mobile, where install unlocks push). On a desktop workspace the banner is noise, so it
 * is suppressed there — managers who still want to install can do it from the browser's own UI.
 */
export default function InstallPrompt() {
    const { canPromptNative, isIOS, isStandalone, promptInstall } = useInstallPrompt();
    // Mirror the app-wide desktop breakpoint (Layout's SideRail gate) so "desktop view" means the
    // same thing everywhere.
    const isDesktop = useMediaQuery('(min-width: 1024px)');
    const [showInstructions, setShowInstructions] = useState(false);
    const [snoozed, setSnoozed] = useState(() => {
        if (sessionSnoozed) return true;
        try {
            return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now();
        } catch {
            return false;
        }
    });

    // Quiet the banner for `days`, surviving reloads where storage is available and the session
    // otherwise. Used for manual dismissal, a declined OS dialog, and (long) a real install.
    const snooze = useCallback((days) => {
        sessionSnoozed = true;
        setSnoozed(true);
        try {
            localStorage.setItem(SNOOZE_KEY, String(Date.now() + days * DAY_MS));
        } catch {
            // localStorage unavailable (private mode) — the in-memory flag covers this session.
        }
    }, []);

    // A real install (native dialog OR manual add-to-home-screen) fires `appinstalled`, re-emitted
    // by the early-capture script as `pwa-app-installed`. Stop offering install for good on this
    // device — it matters most on iOS, where reopening in a Safari tab would otherwise re-nag.
    useEffect(() => {
        const onInstalled = () => snooze(INSTALLED_DAYS);
        window.addEventListener('pwa-app-installed', onInstalled);
        window.addEventListener('appinstalled', onInstalled);
        return () => {
            window.removeEventListener('pwa-app-installed', onInstalled);
            window.removeEventListener('appinstalled', onInstalled);
        };
    }, [snooze]);

    const handleInstallClick = async () => {
        if (canPromptNative) {
            const outcome = await promptInstall();
            if (outcome === 'accepted') {
                snooze(INSTALLED_DAYS); // installing — appinstalled will also confirm
            } else if (outcome === 'dismissed') {
                snooze(SNOOZE_DAYS); // declined the OS dialog — quiet briefly, don't kill forever
            } else {
                setShowInstructions(true); // 'unavailable' — fall back to manual steps
            }
        } else {
            // No native prompt available (iOS, or already consumed) — show manual steps.
            setShowInstructions(true);
        }
    };

    // Show only when installing is actually possible, the user hasn't snoozed it, and we're not on
    // a desktop viewport (the nudge is mobile-only).
    const canShow = !isDesktop && !isStandalone && !snoozed && (canPromptNative || isIOS);

    return (
        <>
            {canShow && (
                <div
                    role="region"
                    aria-label="Programėlės įdiegimas"
                    className="flex items-center gap-3 border-b border-line bg-brand-soft px-4 py-2"
                >
                    <Download className="h-5 w-5 shrink-0 text-brand-hover" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-caption font-semibold text-brand-hover">Įdiegti WORKZ</p>
                        <p className="truncate text-caption text-ink">
                            Spartesnė prieiga ir pranešimai apie naujus prašymus
                        </p>
                    </div>
                    <Button
                        variant="primary"
                        size="md"
                        onClick={handleInstallClick}
                        className="shrink-0"
                    >
                        {canPromptNative ? 'Įdiegti' : 'Kaip įdiegti'}
                    </Button>
                    <IconButton icon={X} label="Atmesti" onClick={() => snooze(SNOOZE_DAYS)} className="shrink-0" />
                </div>
            )}

            {showInstructions && (
                <InstallInstructions isIOS={isIOS} onClose={() => setShowInstructions(false)} />
            )}
        </>
    );
}
