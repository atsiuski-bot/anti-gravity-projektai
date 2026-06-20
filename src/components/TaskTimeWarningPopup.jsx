import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';

/**
 * Heads-up shown to the worker when ~70% of the estimated time is used.
 * This is an FYI (amber) — the task keeps running; cf. TaskTimeLimitPopup which is the
 * hard red "time is up" stop. The two are deliberately distinct (title, color, icon).
 */
export default function TaskTimeWarningPopup({ task, remaining, onDismiss }) {
    if (!task) return null;

    return createPortal(
        <div className="fixed inset-0 z-top flex items-center justify-center bg-black bg-opacity-40 p-4">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="time-warning-title"
                className="w-full max-w-md overflow-hidden rounded-modal bg-white shadow-2xl animate-in fade-in zoom-in-95 duration-300"
            >
                {/* Header */}
                <div className="flex items-center gap-3 bg-gradient-to-r from-amber-400 to-orange-400 px-6 py-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm">
                        <AlertTriangle className="h-6 w-6 text-white" aria-hidden="true" />
                    </div>
                    <h2 id="time-warning-title" className="text-h3 font-bold text-white">Liko mažai laiko</h2>
                </div>

                {/* Body */}
                <div className="space-y-3 px-6 py-5">
                    <p className="text-body font-medium leading-relaxed text-ink-strong">
                        Užduočiai „{task.title}“ atlikti liko {remaining} min. Suplanuotas laikas baigiasi.
                    </p>
                </div>

                {/* Footer */}
                <div className="flex justify-end px-6 pb-5">
                    <button
                        onClick={onDismiss}
                        className="min-h-touch rounded-control bg-amber-500 px-6 text-body font-semibold text-white shadow-sm transition-colors hover:bg-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2"
                    >
                        Gerai
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
