import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';

/**
 * Popup shown to the worker when 70% of estimated time is used.
 */
export default function TaskTimeWarningPopup({ task, remaining, onDismiss }) {
    if (!task) return null;

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black bg-opacity-40 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-300">
                {/* Header */}
                <div className="bg-gradient-to-r from-amber-400 to-orange-400 px-6 py-4 flex items-center gap-3">
                    <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm">
                        <AlertTriangle className="w-6 h-6 text-white" />
                    </div>
                    <h2 className="text-lg font-bold text-white">Dėmesio!</h2>
                </div>

                {/* Body */}
                <div className="px-6 py-5 space-y-3">
                    <p className="text-gray-900 text-sm leading-relaxed font-medium">
                        Užduočiai „{task.title}“ atlikti liko {remaining} min.
                    </p>
                </div>

                {/* Footer */}
                <div className="px-6 pb-5 flex justify-end">
                    <button
                        onClick={onDismiss}
                        className="px-6 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors font-semibold text-sm shadow-sm"
                    >
                        Gerai
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
