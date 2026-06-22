import { useEffect, useState } from 'react';
import { Download, Share } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';

function StepNumber({ children }) {
    return (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-soft text-caption font-semibold text-brand-hover">
            {children}
        </span>
    );
}

export default function InstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState(null);
    const [isIOS, setIsIOS] = useState(false);
    const [isStandalone, setIsStandalone] = useState(false);
    const [showInstructions, setShowInstructions] = useState(false);

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

    const handleInstallClick = async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            await deferredPrompt.userChoice;
            setDeferredPrompt(null);
        } else {
            // No native prompt available (iOS, or already dismissed) — show manual steps.
            setShowInstructions(true);
        }
    };

    if (isStandalone) return null;

    return (
        <>
            <button
                onClick={handleInstallClick}
                aria-label="Įdiegti programėlę"
                className="inline-flex items-center gap-1 min-h-touch rounded-control border border-brand-soft bg-brand-soft px-3 py-1 text-caption font-medium text-brand-hover transition-colors hover:bg-brand-soft/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
            >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="uppercase tracking-wide">Įdiegti</span>
            </button>

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
