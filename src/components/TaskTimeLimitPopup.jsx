import { useState } from 'react';
import { createPortal } from 'react-dom';
import { XOctagon, PauseCircle, BellOff } from 'lucide-react';
import { SoundManager } from '../utils/soundUtils';
import { formatMinutesToTimeString } from '../utils/timeUtils';

/**
 * Hard stop shown to the worker when 100% of the estimated time is reached. The task is
 * already auto-paused and a short repeating alarm is playing. Unlike the amber
 * TaskTimeWarningPopup (an FYI), this one is red, names the "time is up" state explicitly,
 * shows that work was stopped, and lets the worker silence the alarm immediately.
 */
export default function TaskTimeLimitPopup({ task, estimatedTime, actualMinutes, onDismiss }) {
    const [muted, setMuted] = useState(false);

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

    return createPortal(
        <div className="fixed inset-0 z-top flex items-center justify-center bg-black bg-opacity-50 p-4">
            <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="time-limit-title"
                className="w-full max-w-md overflow-hidden rounded-modal bg-white shadow-2xl animate-in fade-in zoom-in-95 duration-300"
            >
                {/* Header */}
                <div className="flex items-center gap-3 bg-gradient-to-r from-red-500 to-red-600 px-6 py-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm">
                        <XOctagon className="h-6 w-6 text-white" aria-hidden="true" />
                    </div>
                    <h2 id="time-limit-title" className="text-h3 font-bold text-white">Laikas baigėsi</h2>
                </div>

                {/* Body */}
                <div className="space-y-4 px-6 py-5">
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

                    <div className="flex items-center gap-2 rounded-control bg-red-50 px-3 py-2 text-body font-semibold text-red-700">
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
                <div className="flex justify-end gap-2 px-6 pb-5">
                    <button
                        onClick={handleMute}
                        disabled={muted}
                        className="inline-flex min-h-touch items-center gap-2 rounded-control border border-line bg-white px-4 text-body font-semibold text-ink shadow-sm transition-colors hover:bg-surface-sunken disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                    >
                        <BellOff className="h-4 w-4" aria-hidden="true" />
                        {muted ? 'Nutildyta' : 'Nutildyti garsą'}
                    </button>
                    <button
                        onClick={handleAcknowledge}
                        className="min-h-touch rounded-control bg-red-600 px-6 text-body font-semibold text-white shadow-sm transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
                    >
                        Supratau
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
