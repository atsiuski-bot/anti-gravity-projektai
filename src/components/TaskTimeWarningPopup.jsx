import { createPortal } from 'react-dom';
import { useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useModalA11y } from '../hooks/useModalA11y';

/**
 * Heads-up shown to the worker when ~70% of the estimated time is used.
 * This is an FYI (amber) — the task keeps running; cf. TaskTimeLimitPopup which is the
 * hard red "time is up" stop. The two are deliberately distinct (title, color, icon).
 */
export default function TaskTimeWarningPopup({ task, remaining, onDismiss }) {
    const dialogRef = useRef(null);
    const okButtonRef = useRef(null);

    // Focus the action on open, restore on close, Escape dismisses, trap Tab (WCAG 2.4.3).
    useModalA11y(dialogRef, { open: !!task, onClose: onDismiss, dismissible: true, initialFocusRef: okButtonRef });

    if (!task) return null;

    return createPortal(
        <div className="fixed inset-0 z-top flex items-center justify-center bg-black bg-opacity-40 p-4">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="time-warning-title"
                tabIndex={-1}
                className="w-full max-w-md overflow-hidden rounded-modal bg-surface-card shadow-2xl animate-in fade-in zoom-in-95 focus:outline-none"
            >
                {/* Header — darkened so the white title/icon clear WCAG 1.4.3 (was amber-400/orange-400 ~1.8:1). */}
                <div className="flex items-center gap-3 bg-gradient-to-r from-amber-700 to-orange-700 px-6 py-4">
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
                        ref={okButtonRef}
                        onClick={onDismiss}
                        className="min-h-touch rounded-control bg-amber-700 px-6 text-body font-semibold text-white shadow-sm transition-colors hover:bg-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2"
                    >
                        Gerai
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
