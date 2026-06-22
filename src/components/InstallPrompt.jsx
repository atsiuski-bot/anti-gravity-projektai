import { useEffect, useState, useCallback } from 'react';
import { Download, Share, X } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import IconButton from './ui/IconButton';

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

function StepNumber({ children }) {
    return (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-soft text-caption font-semibold text-brand-hover">
            {children}
        </span>
    );
}

/**
 * InstallPrompt — a slim, dismissible install banner (DESIGN_SYSTEM: calm canvas). It surfaces
 * only when installation is actually possible: a captured `beforeinstallprompt` (Android/
 * desktop Chrome), or iOS/iPadOS Safari where install is manual. Hidden when already installed
 * or while snoozed. Rendered once near the top of the app shell, not in the header.
 *
 * Dismissal is a time-boxed snooze, never a permanent kill: declining the banner (or the OS
 * install dialog) only quiets it for `SNOOZE_DAYS`; an actual install marks it done for good.
 */
export default function InstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState(null);
    const [isIOS, setIsIOS] = useState(false);
    const [isStandalone, setIsStandalone] = useState(false);
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

    useEffect(() => {
        const handleBeforeInstallPrompt = (e) => {
            // Prevent the mini-infobar from appearing on mobile; stash for later.
            e.preventDefault();
            setDeferredPrompt(e);
        };

        // Fired after a successful install (native prompt OR manual "Add to Home Screen").
        // Stop offering install for good and drop the now-spent deferred event.
        const handleAppInstalled = () => {
            setDeferredPrompt(null);
            snooze(INSTALLED_DAYS);
        };

        window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        window.addEventListener('appinstalled', handleAppInstalled);

        const ua = navigator.userAgent;
        // iPadOS 13+ reports as desktop "Macintosh" Safari, so the classic UA test misses iPads;
        // a touch-capable Mac is really an iPad. Catch both so manual steps still reach tablets.
        const isIOSDevice =
            (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) ||
            (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
        setIsIOS(isIOSDevice);

        const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches ||
            window.navigator.standalone ||
            document.referrer.includes('android-app://');
        setIsStandalone(isInStandaloneMode);

        return () => {
            window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
            window.removeEventListener('appinstalled', handleAppInstalled);
        };
    }, [snooze]);

    const handleInstallClick = async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            setDeferredPrompt(null); // a beforeinstallprompt event can only be used once
            if (outcome === 'accepted') {
                snooze(INSTALLED_DAYS); // installing — appinstalled will also confirm
            } else {
                snooze(SNOOZE_DAYS); // declined the OS dialog — quiet briefly, don't kill forever
            }
        } else {
            // No native prompt available (iOS, or already consumed) — show manual steps.
            setShowInstructions(true);
        }
    };

    // Show only when installing is actually possible and the user hasn't snoozed it.
    const canShow = !isStandalone && !snoozed && (deferredPrompt || isIOS);

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
                        {deferredPrompt ? 'Įdiegti' : 'Kaip įdiegti'}
                    </Button>
                    <IconButton icon={X} label="Atmesti" onClick={() => snooze(SNOOZE_DAYS)} className="shrink-0" />
                </div>
            )}

            {showInstructions && (
                <Modal open onClose={() => setShowInstructions(false)} title="Įdiegti programėlę" size="sm">
                    <div className="space-y-4">
                        <p className="text-body text-ink-muted">
                            Kad naudotumėtės programėle patogiau, pridėkite ją prie pagrindinio ekrano.
                        </p>

                        {isIOS && (
                            <p className="text-caption text-ink-muted">
                                „iPhone“ ir „iPad“ pranešimai apie naujus prašymus bei laiko priminimus
                                veikia tik įdiegus programėlę į pradžios ekraną.
                            </p>
                        )}

                        {isIOS ? (
                            <ol className="space-y-3 text-body font-medium text-ink-strong">
                                <li className="flex items-center gap-3">
                                    <StepNumber>1</StepNumber>
                                    <span className="inline-flex items-center gap-1">
                                        Spauskite <strong>Bendrinti</strong>
                                        <Share className="inline h-4 w-4" aria-hidden="true" /> ikoną
                                    </span>
                                </li>
                                <li className="flex items-center gap-3">
                                    <StepNumber>2</StepNumber>
                                    <span>Pasirinkite <strong>Įtraukti į pradžios ekraną</strong></span>
                                </li>
                                <li className="flex items-center gap-3">
                                    <StepNumber>3</StepNumber>
                                    <span>Spauskite <strong>Įtraukti</strong> viršutiniame kampe</span>
                                </li>
                            </ol>
                        ) : (
                            <ol className="space-y-3 text-body font-medium text-ink-strong">
                                <li className="flex items-center gap-3">
                                    <StepNumber>1</StepNumber>
                                    <span>Spauskite naršyklės meniu ikoną (trys taškai)</span>
                                </li>
                                <li className="flex items-center gap-3">
                                    <StepNumber>2</StepNumber>
                                    <span>Pasirinkite <strong>Įdiegti programėlę</strong> arba <strong>Įtraukti į pradžios ekraną</strong></span>
                                </li>
                            </ol>
                        )}

                        <Button variant="primary" size="lg" fullWidth onClick={() => setShowInstructions(false)}>
                            Supratau
                        </Button>
                    </div>
                </Modal>
            )}
        </>
    );
}
