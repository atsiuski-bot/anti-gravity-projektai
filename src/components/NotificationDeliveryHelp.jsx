import { BatteryCharging, Settings, Share } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';

// Why this exists: a PWA cannot read — let alone change — the phone's deep power settings. Android's
// battery optimisation (and manufacturer "app killers" on Samsung/Xiaomi) silently freeze the
// service worker in the background, so a push that the server sent never surfaces. The web platform
// gives us no signal for this and no switch to flip. All we can do is TELL the user where the switch
// lives on their phone and let them flip it by hand — which is exactly what the OS requires anyway.
// This modal is that guide, branched by OS, shared between the Profile help entry and the nudge banner.

function StepNumber({ children }) {
    return (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-caption font-semibold text-brand-hover">
            {children}
        </span>
    );
}

function Step({ n, children }) {
    return (
        <li className="flex items-start gap-3">
            <StepNumber>{n}</StepNumber>
            <span className="text-body text-ink-strong">{children}</span>
        </li>
    );
}

/**
 * NotificationDeliveryHelp — plain-language steps for keeping push alive when the phone would
 * otherwise sleep the app. Android/other: lift battery optimisation off Gildija (plus the extra
 * manufacturer autostart/kill settings on Samsung & Xiaomi). iOS: push only works once the app is
 * installed to the home screen, and Low Power Mode delays it. `isIOS` picks the branch.
 */
export default function NotificationDeliveryHelp({ isIOS, onClose }) {
    return (
        <Modal open onClose={onClose} title="Negaunate pranešimų?" size="sm">
            <div className="space-y-4">
                <p className="text-body text-ink-muted">
                    Telefonas gali „užmigdyti“ programėlę fone, kad taupytų bateriją — tada pranešimai
                    apie užduotis ateina pavėluotai arba visai neateina. Tai pataisoma telefono
                    nustatymuose, štai kaip.
                </p>

                {isIOS ? (
                    <>
                        <p className="flex items-start gap-2 text-caption text-ink-muted">
                            <Share className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            „iPhone“ ir „iPad“ pranešimai veikia tik įdiegus programėlę į pradžios ekraną.
                        </p>
                        <ol className="space-y-3">
                            <Step n="1">
                                Įsitikinkite, kad programėlė <strong>įdiegta į pradžios ekraną</strong>
                                {' '}(Bendrinti → „Įtraukti į pradžios ekraną“) ir atveriate ją iš ten,
                                ne per naršyklę.
                            </Step>
                            <Step n="2">
                                Nustatymai → <strong>Baterija</strong> → išjunkite <strong>Energijos
                                taupymo režimą</strong> (jis atideda pranešimus).
                            </Step>
                            <Step n="3">
                                Nustatymai → <strong>Pranešimai</strong> → suraskite „Gildija“ ir leiskite
                                pranešimus.
                            </Step>
                        </ol>
                    </>
                ) : (
                    <>
                        <p className="flex items-start gap-2 text-caption text-ink-muted">
                            <BatteryCharging className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            Pavadinimai gali šiek tiek skirtis pagal telefono modelį, bet eiga tokia pati.
                        </p>
                        <ol className="space-y-3">
                            <Step n="1">
                                Nustatymai → <strong>Programėlės</strong> → suraskite <strong>Gildija</strong>.
                            </Step>
                            <Step n="2">
                                Atverkite <strong>Baterija</strong> ir pasirinkite <strong>„Neriboti“</strong>
                                {' '}(arba „Neoptimizuoti“ / „Leisti veikti fone“).
                            </Step>
                            <Step n="3">
                                <strong>Samsung:</strong> Nustatymai → Baterija → „Naudojimo apribojimai
                                fone“ → įtraukite Gildiją į <strong>„Niekada neužmigdomos“</strong>.
                            </Step>
                            <Step n="4">
                                <strong>Xiaomi / Redmi / POCO:</strong> laikykite programėlės ikoną → „i“
                                {' '}→ įjunkite <strong>„Automatinis paleidimas“</strong>, o baterijos
                                taupyme pasirinkite <strong>„Be apribojimų“</strong>.
                            </Step>
                        </ol>
                    </>
                )}

                <p className="flex items-start gap-2 rounded-control bg-surface-sunken p-3 text-caption text-ink-muted">
                    <Settings className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    Šių gilių telefono nustatymų programėlė pati pakeisti negali — juos leidžia keisti
                    tik telefono operacinė sistema, todėl žingsnius reikia atlikti ranka.
                </p>

                <Button variant="primary" size="lg" fullWidth onClick={onClose}>
                    Supratau
                </Button>
            </div>
        </Modal>
    );
}
