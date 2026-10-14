import { Share } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { isSamsungInternet } from '../utils/installBrowser';

function StepNumber({ children }) {
    return (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-soft text-caption font-semibold text-brand-hover">
            {children}
        </span>
    );
}

/**
 * InstallInstructions — the manual "add to home screen" steps, shown whenever no native install
 * prompt is available: iOS/iPadOS Safari always (the event does not exist there), and other
 * browsers once the prompt has already been consumed. Shared by the install banner and the
 * Profile install entry so the wording can never drift between the two surfaces.
 */
export default function InstallInstructions({ isIOS, onClose }) {
    // Samsung Internet's own install is flagged by Android 14+ ("built for an older version of
    // Android"), so there the only safe path is Chrome. Read here so the banner and the Profile entry
    // both get it without each passing a flag.
    if (isSamsungInternet(navigator.userAgent)) {
        return (
            <Modal open onClose={onClose} title="Įdiegti programėlę" size="sm">
                <div className="space-y-4">
                    <p className="text-body text-ink-muted">
                        Samsung Internet naršyklėje įdiegta programėlė naujesniuose „Android“ telefonuose
                        gali būti blokuojama. Įdiekite ją per Google Chrome.
                    </p>
                    <ol className="space-y-3 text-body font-medium text-ink-strong">
                        <li className="flex items-center gap-3">
                            <StepNumber>1</StepNumber>
                            <span>Atidarykite šį puslapį <strong>Google Chrome</strong> naršyklėje</span>
                        </li>
                        <li className="flex items-center gap-3">
                            <StepNumber>2</StepNumber>
                            <span>Spauskite Chrome meniu ikoną (trys taškai)</span>
                        </li>
                        <li className="flex items-center gap-3">
                            <StepNumber>3</StepNumber>
                            <span>Pasirinkite <strong>Įdiegti programą</strong> arba <strong>Pridėti prie pagrindinio ekrano</strong></span>
                        </li>
                    </ol>
                    <Button variant="primary" size="lg" fullWidth onClick={onClose}>
                        Supratau
                    </Button>
                </div>
            </Modal>
        );
    }

    return (
        <Modal open onClose={onClose} title="Įdiegti programėlę" size="sm">
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

                <Button variant="primary" size="lg" fullWidth onClick={onClose}>
                    Supratau
                </Button>
            </div>
        </Modal>
    );
}
