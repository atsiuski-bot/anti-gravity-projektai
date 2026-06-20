import { createPortal } from 'react-dom';
import { XOctagon } from 'lucide-react';

/**
 * Popup shown to the worker when 100% of estimated time is reached.
 * Task is already auto-paused. Repeating alarm is playing.
 */
export default function TaskTimeLimitPopup({ task, onDismiss }) {
    if (!task) return null;

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black bg-opacity-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-300">
                {/* Header */}
                <div className="bg-gradient-to-r from-red-500 to-red-600 px-6 py-4 flex items-center gap-3">
                    <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm">
                        <XOctagon className="w-6 h-6 text-white" />
                    </div>
                    <h2 className="text-lg font-bold text-white">Dėmesio!</h2>
                </div>

                {/* Body */}
                <div className="px-6 py-5 space-y-4">
                    <p className="text-gray-900 text-sm leading-relaxed font-medium">
                        Laikas skirtas užduočiai „{task.title}“ atlikti baigėsi. Aptarkite tolesnę užduoties eigą su darbo vadovu.
                    </p>
                </div>

                {/* Footer */}
                <div className="px-6 pb-5 flex justify-end">
                    <button
                        onClick={onDismiss}
                        className="px-6 py-2.5 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors font-semibold text-sm shadow-sm"
                    >
                        Supratau
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}

