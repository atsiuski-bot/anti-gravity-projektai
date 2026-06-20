import React, { useState, useRef, useCallback } from 'react';
import { useActiveSessionStatus } from '../hooks/useActiveSessionStatus';
import { useTimerState } from '../hooks/useTimerState';
import ReactDOM from 'react-dom';
import { Zap, Square, X, Check, ShieldAlert } from 'lucide-react';
import { formatMinutesToTimeString, getLithuanianNow } from '../utils/timeUtils';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { SoundManager } from '../utils/soundUtils';
import { startSession, endSession } from '../utils/sessionActions';
import IconButton from './ui/IconButton';
import Button from './ui/Button';

// Separate memoized modal component to prevent re-renders from timer updates
const QuickWorkModalComponent = React.memo(({ onSubmit, onClose, currentSessionMinutes, isSubmitting }) => {
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
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-feedback-scrim p-4">
            <form
                onSubmit={handleSubmit}
                className="bg-white w-full max-w-md rounded-modal shadow-2xl flex flex-col overflow-hidden"
                style={{ maxHeight: '80vh' }}
            >
                {/* Header */}
                <div className="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
                    <div>
                        <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                            <Zap className="w-6 h-6 text-red-500 fill-current" />
                            Greito darbo pabaiga
                        </h3>
                        <p className="text-sm text-gray-500 mt-1">Įveskite atlikto darbo aprašymą</p>
                    </div>
                    <IconButton icon={X} label="Uždaryti" variant="ghost" onClick={onClose} />
                </div>

                {/* Content */}
                <div className="p-5 flex-1 overflow-y-auto">
                    <div className="mb-5 bg-red-50 rounded-2xl p-4 border border-red-200 flex items-center justify-between">
                        <span className="text-red-700 font-semibold text-base">Užfiksuotas laikas:</span>
                        <span className="text-4xl font-mono font-bold text-red-600">{totalDisplay}</span>
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-gray-700 mb-2 uppercase tracking-wide">
                            Ką nuveikėte?
                        </label>
                        <textarea
                            ref={textareaRef}
                            id="quickWorkTextarea"
                            name="taskDescription"
                            placeholder="Trumpai aprašykite atliktą darbą..."
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
                    <Button type="button" variant="secondary" onClick={onClose}>
                        Atšaukti
                    </Button>
                    <Button type="submit" variant="primary" loading={isSubmitting} icon={Check}>
                        {isSubmitting ? 'Saugoma...' : 'Išsaugoti darbą'}
                    </Button>
                </div>
            </form>
        </div>,
        document.body
    );
});
QuickWorkModalComponent.displayName = 'QuickWorkModalComponent';

export default function QuickWorkTimer({ compact = false }) {
    const { currentUser, userData, setOptimisticUserData } = useAuth();
    const { isSecondarySessionActive } = useActiveSessionStatus();
    // useTimerState now handles generic 'quickWork' type
    const {
        isActive: isQuickWorking,
        currentSessionMinutes,
        startTime
    } = useTimerState(currentUser, 'quickWorkState', 'isQuickWorking', null, null, 'quickWork');

    const isDisabled = isSecondarySessionActive && !isQuickWorking;

    const [showTitleModal, setShowTitleModal] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');

    // Listen for external stop requests is still good,
    // but session actions handle this via endSession usually. 
    // However, for the MODAL, we need local state.
    // If the session is stopped remotely (e.g. by starting a task), isQuickWorking becomes false.
    // The previous logic used an event listener 'stop-quick-work'.
    // We should maintain that if we want to prompt for title.
    // BUT if the user starts a task elsewhere, we might just auto-save or discard.
    // Let's keep it simple: if session ends remotely, we might miss the title prompt.
    // That's acceptable for now (auto-save generic title).

    const handleStartQuickWork = async () => {
        if (!currentUser || isDisabled) return;
        setError('');
        try {
            // Optimistic UI Update: Instantly assume Quick Work started, clear other sessions
            setOptimisticUserData({
                ...userData,
                activeSession: { type: 'quickWork', startTime: new Date().toISOString() },
                quickWorkState: { ...userData?.quickWorkState, isQuickWorking: true, lastStartedAt: new Date().toISOString() },
                breakState: { ...userData?.breakState, isTakingBreak: false },
                callState: { ...userData?.callState, isCalling: false },
                workStatus: { ...userData?.workStatus, isWorking: false, status: 'paused' }
            });

            await startSession(currentUser.uid, 'quickWork');
            SoundManager.playQuickTaskSound();
        } catch (err) {
            console.error("Error starting quick work:", err);
            setOptimisticUserData(null); // Revert on error
            setError("Nepavyko pradėti greito darbo. Bandykite dar kartą.");
        }
    };

    const handleStopQuickWork = async () => {
        // Here we just check duration and decide whether to show modal or stop immediately
        const now = getLithuanianNow();
        let sessionDuration = 0;
        if (startTime) {
            sessionDuration = (now - startTime) / (1000 * 60);
        }

        // 10 second threshold
        if (sessionDuration <= (10 / 60)) {
            await endSession(currentUser.uid); // Auto discard/stop
            return;
        }

        SoundManager.playQuickTaskSound();
        setShowTitleModal(true);
    };

    const handleCompleteQuickWork = useCallback(async (taskTitle) => {
        if (!taskTitle || !taskTitle.trim()) return;

        setIsSubmitting(true);
        setError('');
        try {
            // Determine if a task will be resumed
            const resumableTasks = userData?.quickWorkState?.resumableTaskIds || [];
            const activeTaskId = resumableTasks.length > 0 ? resumableTasks[0] : null;

            // Optimistic UI Update: Instantly assume Quick Work ended and task resumed
            setOptimisticUserData({
                ...userData,
                activeSession: activeTaskId ? { type: 'task', startTime: new Date().toISOString(), taskId: activeTaskId } : null,
                quickWorkState: { ...userData?.quickWorkState, isQuickWorking: false },
                workStatus: activeTaskId ? {
                    isWorking: true,
                    status: 'running',
                    activeTaskId: activeTaskId,
                } : userData?.workStatus
            });

            // End session with custom title overrides
            await endSession(currentUser.uid, null, { customTitle: taskTitle });
            setShowTitleModal(false);
        } catch (err) {
            console.error("Error completing quick work:", err);
            setOptimisticUserData(null); // Revert on error
            setError("Nepavyko išsaugoti greito darbo. Bandykite dar kartą.");
        } finally {
            setIsSubmitting(false);
        }
    }, [currentUser, userData, setOptimisticUserData]);

    // Render modal if showing
    const renderModal = showTitleModal && (
        <QuickWorkModalComponent
            onSubmit={handleCompleteQuickWork}
            onClose={() => setShowTitleModal(false)}
            currentSessionMinutes={currentSessionMinutes}
            isSubmitting={isSubmitting}
        />
    );

    // Render Compact (Mobile)
    if (compact) {
        return (
            <div className="flex flex-col items-center">
                {/* Timer Display — paired label + live readout (color is never the sole signal) */}
                {isQuickWorking ? (
                    <span
                        className="text-body-lg font-bold text-session-quickWork-accent font-mono mb-1 leading-6 animate-pulse"
                        aria-live="polite"
                    >
                        {formatMinutesToTimeString(currentSessionMinutes)}
                    </span>
                ) : (
                    // Invisible placeholder to keep alignment (decorative spacer)
                    <span className="text-body-lg font-bold text-transparent font-mono mb-1 leading-6 select-none" aria-hidden="true">
                        00:00
                    </span>
                )}

                <button
                    onClick={isQuickWorking ? handleStopQuickWork : handleStartQuickWork}
                    disabled={isDisabled}
                    aria-label={isQuickWorking ? "Baigti greitą darbą" : (isDisabled ? "Kitas veiksmas jau aktyvus" : "Greitas darbas")}
                    className={clsx(
                        "inline-flex items-center justify-center min-h-touch min-w-touch rounded-control transition-all active:scale-95",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                        isDisabled
                            ? "opacity-50 cursor-not-allowed bg-surface-sunken text-ink-muted"
                            : isQuickWorking
                                ? 'bg-session-quickWork-shell text-white ring-2 ring-red-200 shadow-lg shadow-red-500/20'
                                : 'text-ink hover:bg-surface-sunken'
                    )}
                    title={isQuickWorking ? "Baigti greitą darbą" : (isDisabled ? "Kitas veiksmas jau aktyvus" : "Greitas darbas")}
                >
                    {isQuickWorking ? (
                        <Square className="w-5 h-5 fill-current" aria-hidden="true" />
                    ) : (
                        <Zap className="w-5 h-5 fill-current" aria-hidden="true" />
                    )}
                </button>

                {error && (
                    <div className="mt-2 flex items-start gap-2 rounded-control border-l-4 border-feedback-danger bg-red-50 p-2" role="alert">
                        <ShieldAlert className="h-4 w-4 shrink-0 text-feedback-danger" aria-hidden="true" />
                        <p className="text-caption text-red-700">{error}</p>
                    </div>
                )}

                {renderModal}
            </div>
        );
    }

    // Render Desktop (Wide)
    return (
        <>
            <button
                onClick={isQuickWorking ? handleStopQuickWork : handleStartQuickWork}
                disabled={isDisabled}
                aria-label={isQuickWorking ? "Baigti greitą darbą" : (isDisabled ? "Kitas veiksmas jau aktyvus" : "Pradėti greitą darbą")}
                className={clsx(
                    "flex-1 flex items-center justify-between min-h-touch px-4 py-3 rounded-card transition-all shadow-sm active:scale-95 border min-w-[140px]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                    isDisabled ? "bg-surface-sunken text-ink-muted cursor-not-allowed border-line" :
                        isQuickWorking
                            ? 'bg-session-quickWork-surface border-red-200 text-red-900 ring-1 ring-red-200'
                            : 'bg-surface-card border-line text-ink hover:bg-surface-sunken hover:border-gray-300'
                )}
                title={isDisabled ? "Kitas veiksmas jau aktyvus" : ""}
            >
                <div className="flex items-center gap-3">
                    <div className={clsx("rounded-control", isQuickWorking ? "text-session-quickWork-accent" : "text-ink-muted")}>
                        {isQuickWorking ? (
                            <Square className="w-5 h-5 fill-current" aria-hidden="true" />
                        ) : (
                            <Zap className="w-5 h-5 fill-current" aria-hidden="true" />
                        )}
                    </div>
                    <div className="flex flex-col items-start leading-tight">
                        <span className="text-xs font-bold uppercase tracking-wider opacity-70">Greitas</span>
                        {isQuickWorking && <span className="text-caption font-semibold text-session-quickWork-accent">Vyksta...</span>}
                    </div>
                </div>
                <span className={clsx(
                    "text-lg font-mono font-bold ml-2",
                    isQuickWorking ? "text-session-quickWork-accent" : "text-ink-muted"
                )}>
                    {formatMinutesToTimeString(currentSessionMinutes)}
                </span>
            </button>

            {error && (
                <div className="mt-2 flex items-start gap-2 rounded-control border-l-4 border-feedback-danger bg-red-50 p-3" role="alert">
                    <ShieldAlert className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-red-700">{error}</p>
                </div>
            )}

            {renderModal}
        </>
    );
}
