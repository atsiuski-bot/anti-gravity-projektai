import { useState, useRef } from 'react';
import { XOctagon, PauseCircle, BellOff } from 'lucide-react';
import { SoundManager } from '../utils/soundUtils';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import Modal from './ui/Modal';

/**
 * Hard stop shown to the worker when 100% of the estimated time is reached. The task is
 * already auto-paused and a short repeating alarm is playing. Unlike the amber
 * TaskTimeWarningPopup (an FYI), this one is red, names the "time is up" state explicitly,
 * shows that work was stopped, and lets the worker silence the alarm immediately.
 *
 * Rendered through the canonical Modal (`bare`, `level="top"`, `dismissible={false}`) so it
 * shares the one scrim, focus-trap, z-ladder and centred-over-the-dimmed-screen presentation
 * with every other pop-up, while staying a forced-acknowledge alarm above any open modal.
 */
export default function TaskTimeLimitPopup({ task, estimatedTime, actualMinutes, onDismiss }) {
    const [muted, setMuted] = useState(false);
    const ackButtonRef = useRef(null);

    if (!task) return null;

    // The monitor auto-sends a time-extension request to the manager when one is set, so the
    // worker doesn't need to do anything manually — tell them that, instead of "go discuss it".
    const hasManager = !!(task.managerId || task.taskAuditor);

    const handleMute = () => {
        SoundManager.stopTimeLimitRepeat();
        setMuted(true);
    };

    const handleAcknowledge = () => {
        SoundManager.stopTimeLimitRepeat();
        onDismiss?.();
    };

    return (
        <Modal
            open
            // Forced-acknowledge alarm: no Escape / backdrop dismiss (the worker must explicitly
            // acknowledge). Focus the action on open and trap Tab. WCAG 2.4.3.
            dismissible={false}
            bare
            level="top"
            size="md"
            role="alertdialog"
            ariaLabelledby="time-limit-title"
            initialFocusRef={ackButtonRef}
            className="motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95"
        >
            {/* Header — darkened so the white title clears WCAG 1.4.3 (red-500 was ~3.99:1). */}
            <div className="flex flex-shrink-0 items-center gap-3 bg-gradient-to-r from-red-600 to-red-700 px-6 py-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm">
                    <XOctagon className="h-6 w-6 text-white" aria-hidden="true" />
                </div>
                <h2 id="time-limit-title" className="text-h3 font-bold text-white">Laikas baigėsi</h2>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
                <p className="text-body font-medium leading-relaxed text-ink-strong">
                    Laikas skirtas užduočiai „{task.title}“ atlikti baigėsi.
                </p>

                {/* Planned vs actual — the numbers the worker needs to judge the overrun. */}
                {(estimatedTime || Number.isFinite(actualMinutes)) && (
                    <div className="rounded-control bg-surface-sunken px-3 py-2 text-body">
                        <div className="flex items-center justify-between">
                            <span className="text-ink-muted">Planuota</span>
                            <span className="font-semibold text-ink-strong">{estimatedTime || '—'}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between">
                            <span className="text-ink-muted">Sugaišta</span>
                            <span className="font-semibold text-ink-strong">
                                {Number.isFinite(actualMinutes) ? formatMinutesToTimeString(actualMinutes) : '—'}
                            </span>
                        </div>
                    </div>
                )}

                <div className="flex items-center gap-2 rounded-control bg-feedback-danger/10 px-3 py-2 text-body font-semibold text-feedback-danger">
                    <PauseCircle className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
                    Darbas automatiškai sustabdytas.
                </div>

                <p className="text-body text-ink-muted">
                    {hasManager
                        ? 'Vadovui jau išsiųsta laiko pratęsimo užklausa. Palaukite jo sprendimo arba aptarkite tolesnę eigą.'
                        : 'Aptarkite tolesnę užduoties eigą su darbo vadovu.'}
                </p>
            </div>

            {/* Footer */}
            <div className="flex flex-shrink-0 justify-end gap-2 px-6 pb-5">
                <button
                    onClick={handleMute}
                    disabled={muted}
                    className="inline-flex min-h-touch items-center gap-2 rounded-control border border-line bg-surface-card px-4 text-body font-semibold text-ink shadow-sm transition-colors hover:bg-surface-sunken disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                >
                    <BellOff className="h-4 w-4" aria-hidden="true" />
                    {muted ? 'Nutildyta' : 'Nutildyti garsą'}
                </button>
                <button
                    ref={ackButtonRef}
                    onClick={handleAcknowledge}
                    className="min-h-touch rounded-control bg-red-600 px-6 text-body font-semibold text-white shadow-sm transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
                >
                    Supratau
                </button>
            </div>
        </Modal>
    );
}
