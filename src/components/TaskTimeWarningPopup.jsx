import { useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';

/**
 * Heads-up shown to the worker when ~70% of the estimated time is used.
 * This is an FYI (amber) — the task keeps running; cf. TaskTimeLimitPopup which is the
 * hard red "time is up" stop. The two are deliberately distinct (title, color, icon).
 *
 * Rendered through the canonical Modal (`bare`, `level="top"`) so it shares the one scrim,
 * focus-trap, z-ladder and centred-over-the-dimmed-screen presentation with every other
 * pop-up — the coloured header/body/footer below are the only thing this component still owns.
 */
export default function TaskTimeWarningPopup({ task, remaining, onDismiss }) {
    const okButtonRef = useRef(null);

    if (!task) return null;

    return (
        <Modal
            open
            onClose={onDismiss}
            dismissible
            bare
            level="top"
            size="md"
            ariaLabelledby="time-warning-title"
            initialFocusRef={okButtonRef}
        >
            {/* Header — darkened so the white title/icon clear WCAG 1.4.3 (was amber-400/orange-400 ~1.8:1). */}
            <div className="flex flex-shrink-0 items-center gap-3 bg-gradient-to-r from-amber-700 to-orange-700 px-6 py-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm">
                    <AlertTriangle className="h-6 w-6 text-white" aria-hidden="true" />
                </div>
                <h2 id="time-warning-title" className="text-h3 font-bold text-white">Liko mažai laiko</h2>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
                <p className="text-body font-medium leading-relaxed text-ink-strong">
                    Užduočiai „{task.title}“ atlikti liko {remaining} min. Suplanuotas laikas baigiasi.
                </p>
            </div>

            {/* Footer — canonical Button (the lone dismiss is the dominant action → `primary`).
                There is no `warning` variant: a solid amber-500/600 fill fails WCAG with white text,
                which is why the design system omits it; the loud amber stays in the header only,
                exactly as the red twin (TaskTimeLimitPopup) confines its danger red to its header. */}
            <div className="flex flex-shrink-0 justify-end px-6 pb-5">
                <Button ref={okButtonRef} variant="primary" onClick={onDismiss}>
                    Gerai
                </Button>
            </div>
        </Modal>
    );
}
