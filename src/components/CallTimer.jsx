import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTimerState } from '../hooks/useTimerState';
import { Phone, Square, PhoneOff, X, Check } from 'lucide-react';
import ReactDOM from 'react-dom';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { SoundManager } from '../utils/soundUtils';
import { startSession, endSession } from '../utils/sessionActions';

// Separate memoized modal component to prevent re-renders from timer updates
const CallModalComponent = React.memo(({ onSubmit, onClose, currentSessionMinutes, isSubmitting }) => {
    const textareaRef = useRef(null);
    const totalDisplay = formatMinutesToTimeString(currentSessionMinutes);

    const handleSubmit = (e) => {
        e.preventDefault();
        const titleFromTextarea = textareaRef.current?.value || '';
        if (titleFromTextarea.trim()) {
            onSubmit(titleFromTextarea);
        }
    };

    return ReactDOM.createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4">
            <form
                onSubmit={handleSubmit}
                className="bg-white w-full max-w-md rounded-3xl shadow-2xl flex flex-col overflow-hidden"
                style={{ maxHeight: '80vh' }}
            >
                {/* Header */}
                <div className="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
                    <div>
                        <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                            <Phone className="w-6 h-6 text-sky-500" />
                            Skambučio pabaiga
                        </h3>
                        <p className="text-sm text-gray-500 mt-1">Įveskite skambučio aprašymą</p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 p-3 hover:bg-gray-100 rounded-full transition-colors"
                    >
                        <X className="w-7 h-7" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-5 flex-1 overflow-y-auto">
                    <div className="mb-5 bg-sky-50 rounded-2xl p-4 border border-sky-200 flex items-center justify-between">
                        <span className="text-sky-700 font-semibold text-base">Užfiksuotas laikas:</span>
                        <span className="text-4xl font-mono font-bold text-sky-600">{totalDisplay}</span>
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-gray-700 mb-2 uppercase tracking-wide">
                            Skambučio aprašymas
                        </label>
                        <textarea
                            ref={textareaRef}
                            id="callTextarea"
                            name="callDescription"
                            placeholder="Trumpai aprašykite skambutį..."
                            autoFocus
                            lang="en"
                            dir="ltr"
                            rows={4}
                            style={{
                                width: '100%',
                                padding: '12px',
                                fontSize: '16px',
                                border: '2px solid #e5e7eb',
                                borderRadius: '12px',
                                resize: 'none',
                                background: 'white',
                                color: '#000',
                                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                                direction: 'ltr',
                                textAlign: 'left'
                            }}
                            required
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-200 bg-gray-50 flex gap-3 justify-end">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-6 py-3 text-sm text-gray-600 bg-white border-2 border-gray-300 hover:bg-gray-50 rounded-xl font-semibold transition-all shadow-sm">
                        Atšaukti
                    </button>
                    <button
                        type="submit"
                        disabled={isSubmitting}
                        className="px-8 py-3 text-sm bg-sky-600 hover:bg-sky-700 text-white rounded-xl font-bold shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {isSubmitting ? 'Saugoma...' : (
                            <>
                                <Check className="w-5 h-5" />
                                Išsaugoti skambutį
                            </>
                        )}
                    </button>
                </div>
            </form>
        </div>,
        document.body
    );
});

export default function CallTimer({ compact = false }) {
    const { currentUser, userData } = useAuth();

    const {
        isActive: isCalling,
        currentSessionMinutes,
        startTime
    } = useTimerState(currentUser, 'callState', 'isCalling', null, null, 'call');

    const [showTitleModal, setShowTitleModal] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleStartCall = async () => {
        if (!currentUser) return;
        try {
            await startSession(currentUser.uid, 'call');
            SoundManager.playCallSound();
        } catch (err) {
            console.error("Error starting call:", err);
            alert("Klaida pradedant skambutį.");
        }
    };

    const handleStopCall = async () => {
        // Check duration and decide whether to show modal or stop immediately
        const now = new Date();
        let sessionDuration = 0;
        if (startTime) {
            sessionDuration = (now - startTime) / (1000 * 60);
        }

        // 10 second threshold
        if (sessionDuration <= (10 / 60)) {
            await endSession(currentUser.uid); // Auto discard/stop
            return;
        }

        SoundManager.playCallSound();
        setShowTitleModal(true);
    };

    const handleCompleteCall = useCallback(async (taskTitle) => {
        if (!taskTitle || !taskTitle.trim()) return;

        setIsSubmitting(true);
        try {
            // End session with custom title overrides
            await endSession(currentUser.uid, null, { customTitle: taskTitle });
            setShowTitleModal(false);
        } catch (err) {
            console.error("Error completing call:", err);
            alert("Klaida išsaugant skambutį.");
        } finally {
            setIsSubmitting(false);
        }
    }, [currentUser]);

    const handleToggleCall = async () => {
        if (!currentUser) return;

        try {
            if (!isCalling) {
                await handleStartCall();
            } else {
                await handleStopCall();
            }
        } catch (err) {
            console.error("Error toggling call:", err);
            alert("Klaida keičiant skambučio būseną.");
        }
    };

    const totalDisplay = formatMinutesToTimeString(currentSessionMinutes);

    // Render modal if showing
    const renderModal = showTitleModal && (
        <CallModalComponent
            onSubmit={handleCompleteCall}
            onClose={() => setShowTitleModal(false)}
            currentSessionMinutes={currentSessionMinutes}
            isSubmitting={isSubmitting}
        />
    );

    // Render Compact (Mobile)
    if (compact) {
        return (
            <div className="flex flex-col items-center">
                {/* Timer Display */}
                {isCalling && (
                    <span className="text-[10px] font-bold text-blue-600 font-mono mb-1 leading-none animate-pulse">
                        {totalDisplay}
                    </span>
                )}
                {!isCalling && (
                    <span className="text-[10px] font-bold text-transparent font-mono mb-1 leading-none select-none">
                        00:00
                    </span>
                )}

                <button
                    onClick={handleToggleCall}
                    className={clsx(
                        "p-2 rounded-lg transition-all active:scale-95 flex items-center justify-center",
                        isCalling
                            ? 'bg-sky-400 text-white ring-2 ring-sky-100'
                            : 'text-gray-600 hover:bg-gray-100'
                    )}
                    title={isCalling ? "Baigti skambutį" : "Pradėti skambutį"}
                >
                    {isCalling ? (
                        <Square className="w-5 h-5 fill-current" />
                    ) : (
                        <Phone className="w-5 h-5" />
                    )}
                </button>

                {renderModal}
            </div>
        );
    }

    // Render Desktop (Wide)
    return (
        <>
            <button
                onClick={handleToggleCall}
                className={clsx(
                    "flex-1 flex items-center justify-between px-4 py-3 rounded-xl transition-all shadow-sm active:scale-95 border min-w-[140px]",
                    isCalling
                        ? 'bg-sky-50 border-sky-200 text-sky-900 ring-1 ring-sky-200'
                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-gray-300'
                )}
            >
                <div className="flex items-center gap-3">
                    <div className={clsx("p-1.5 rounded-lg", isCalling ? "bg-sky-200 text-sky-700" : "bg-gray-100 text-gray-500")}>
                        {isCalling ? (
                            <Square className="w-5 h-5 fill-current" />
                        ) : (
                            <Phone className="w-5 h-5" />
                        )}
                    </div>
                    <div className="flex flex-col items-start leading-none">
                        <span className="text-xs font-bold uppercase tracking-wider opacity-70">Skambutis</span>
                        {isCalling && <span className="text-[10px] font-semibold text-sky-600">Skambinama...</span>}
                    </div>
                </div>

                <span className={clsx(
                    "text-lg font-mono font-bold ml-2",
                    isCalling ? "text-sky-600" : "text-gray-400"
                )}>
                    {totalDisplay}
                </span>
            </button>

            {renderModal}
        </>
    );
}
