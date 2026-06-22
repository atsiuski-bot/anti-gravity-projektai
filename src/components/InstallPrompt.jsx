import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import IconButton from './ui/IconButton';

// Once the user dismisses the banner we remember it so it never nags again. A reinstall
// signal (a fresh beforeinstallprompt after clearing storage) re-enables it naturally.
const DISMISS_KEY = 'workz.installBannerDismissed';

// In-memory fallback so dismissal also sticks within a session when localStorage is
// unavailable (private browsing), instead of re-nagging on every reload.
let sessionDismissed = false;

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
 * desktop Chrome), or iOS Safari where install is manual. Hidden when already installed or
 * once dismissed. Rendered once near the top of the app shell, not in the header.
 */
export default function InstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState(null);
    const [isIOS, setIsIOS] = useState(false);
    const [isStandalone, setIsStandalone] = useState(false);
    const [showInstructions, setShowInstructions] = useState(false);
    const [dismissed, setDismissed] = useState(() => {
        if (sessionDismissed) return true;
        try {
            return localStorage.getItem(DISMISS_KEY) === '1';
        } catch {
            return false;
        }
    });

    useEffect(() => {
        const handleBeforeInstallPrompt = (e) => {
            // Prevent the mini-infobar from appearing on mobile; stash for later.
            e.preventDefault();
            setDeferredPrompt(e);
        };

        window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

        const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        setIsIOS(isIOSDevice);

        const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches ||
            window.navigator.standalone ||
            document.referrer.includes('android-app://');
        setIsStandalone(isInStandaloneMode);

        return () => {
            window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        };
    }, []);

    const dismiss = () => {
        sessionDismissed = true;
        setDismissed(true);
        try {
            localStorage.setItem(DISMISS_KEY, '1');
        } catch {
            // localStorage unavailable (private mode) — the in-memory flag covers this session.
        }
    };

    const handleInstallClick = async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            await deferredPrompt.userChoice;
            setDeferredPrompt(null);
            dismiss();
        } else {
            // No native prompt available (iOS, or already consumed) — show manual steps.
            setShowInstructions(true);
        }
    };

    // Show only when installing is actually possible and the user hasn't opted out.
    const canShow = !isStandalone && !dismissed && (deferredPrompt || isIOS);

    return (
        <>
            {canShow && (
                <div className="flex items-center gap-3 border-b border-line bg-brand-soft px-4 py-2">
                    <Download className="h-5 w-5 shrink-0 text-brand-hover" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="text-caption font-semibold text-brand-hover">Įdiegti WORKZ</p>
                        <p className="truncate text-caption text-ink">
                            Greitesnė prieiga iš pradžios ekrano
                        </p>
                    </div>
                    <Button
                        variant="primary"
                        size="md"
                        onClick={handleInstallClick}
                        className="shrink-0 px-3 py-1.5"
                    >
                        {deferredPrompt ? 'Įdiegti' : 'Kaip įdiegti'}
                    </Button>
                    <IconButton icon={X} label="Atmesti" onClick={dismiss} />
                </div>
            )}

            {showInstructions && (
                <Modal open onClose={() => setShowInstructions(false)} title="Įdiegti programėlę" size="sm">
                    <div className="space-y-4">
                        <p className="text-body text-ink-muted">
                            Kad naudotumėtės programėle patogiau, pridėkite ją prie pagrindinio ekrano.
                        </p>

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
