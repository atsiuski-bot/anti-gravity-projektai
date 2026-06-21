import React, { useState, useRef, useCallback } from 'react';
import { useActiveSessionStatus } from '../hooks/useActiveSessionStatus';
import { useTimerState } from '../hooks/useTimerState';
import { Zap, Square, Check, ShieldAlert } from 'lucide-react';
import { formatMinutesToTimeString, getLithuanianNow } from '../utils/timeUtils';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { SoundManager } from '../utils/soundUtils';
import { startSession, endSession } from '../utils/sessionActions';
import Button from './ui/Button';
import Modal from './ui/Modal';

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

    return (
        <Modal
            open
            onClose={onClose}
            title="Greito darbo pabaiga"
            size="md"
            initialFocusRef={textareaRef}
        >
            <form onSubmit={handleSubmit} className="flex flex-col">
                <p className="text-body text-ink-muted mb-4 flex items-center gap-2">
                    <Zap className="w-5 h-5 text-session-quickWork-accent fill-current shrink-0" aria-hidden="true" />
                    Įveskite atlikto darbo aprašymą
                </p>

                <div className="mb-5 bg-session-quickWork-surface rounded-card p-4 border border-red-200 flex items-center justify-between">
                    <span className="text-session-quickWork-accent font-semibold text-body-lg">Užfiksuotas laikas:</span>
                    <span className="text-4xl font-mono font-bold text-session-quickWork-accent">{totalDisplay}</span>
                </div>

                <div>
                    <label htmlFor="quickWorkTextarea" className="block text-caption font-bold text-ink mb-2 uppercase tracking-wide">
                        Ką nuveikėte?
                    </label>
                    <textarea
                        ref={textareaRef}
                        id="quickWorkTextarea"
                        name="taskDescription"
                        placeholder="Trumpai aprašykite atliktą darbą..."
                        rows={4}
                        className="border-2 border-line rounded-card bg-surface-card text-ink-strong"
                        style={{
                            width: '100%',
                            padding: '12px',
                            fontSize: '16px',
                            resize: 'none',
                            direction: 'ltr',
                            textAlign: 'left'
                        }}
                        required
                    />
                </div>

                <div className="mt-6 flex gap-3 justify-end">
                    <Button type="button" variant="secondary" onClick={onClose}>
                        Atšaukti
                    </Button>
                    <Button type="submit" variant="primary" loading={isSubmitting} icon={Check}>
                        {isSubmitting ? 'Saugoma...' : 'Išsaugoti darbą'}
                    </Button>
                </div>
            </form>
        </Modal>
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

                {/* Always-visible text label so color/icon is never the sole signal (WCAG 1.4.1) */}
                <span className="mt-1 text-caption font-medium text-ink-muted leading-none">Greitas</span>

                {error && (
                    <div className="mt-2 flex items-start gap-2 rounded-control border-l-4 border-feedback-danger bg-feedback-danger/10 p-2" role="alert">
                        <ShieldAlert className="h-4 w-4 shrink-0 text-feedback-danger" aria-hidden="true" />
                        <p className="text-caption text-feedback-danger">{error}</p>
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
                            : 'bg-surface-card border-line text-ink hover:bg-surface-sunken hover:border-line'
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
                        <span className="text-caption font-bold uppercase tracking-wider text-ink-muted">Greitas</span>
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
                <div className="mt-2 flex items-start gap-2 rounded-control border-l-4 border-feedback-danger bg-feedback-danger/10 p-3" role="alert">
                    <ShieldAlert className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-feedback-danger">{error}</p>
                </div>
            )}

            {renderModal}
        </>
    );
}
