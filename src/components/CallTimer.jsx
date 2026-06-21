import React, { useState, useRef, useCallback } from 'react';
import { useActiveSessionStatus } from '../hooks/useActiveSessionStatus';
import { useTimerState } from '../hooks/useTimerState';
import { Phone, Square, Check, ShieldAlert } from 'lucide-react';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { SoundManager } from '../utils/soundUtils';
import { startSession, endSession } from '../utils/sessionActions';
import { getSessionColors } from '../utils/sessionColors';
import Modal from './ui/Modal';
import Button from './ui/Button';

// Separate memoized modal component to prevent re-renders from timer updates
const CallModalComponent = React.memo(function CallModalComponent({ onSubmit, onClose, currentSessionMinutes, isSubmitting }) {
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
            title="Skambučio pabaiga"
            size="md"
            initialFocusRef={textareaRef}
        >
            <form onSubmit={handleSubmit} className="flex flex-col">
                {/* Content */}
                <p className="text-body text-ink-muted mb-4">Įveskite skambučio aprašymą</p>

                <div className="mb-5 bg-session-call-surface rounded-card p-4 border border-blue-200 flex items-center justify-between">
                    <span className="text-body-lg font-semibold text-session-call-accent">Užfiksuotas laikas:</span>
                    <span className="text-4xl font-mono font-bold text-session-call-accent">{totalDisplay}</span>
                </div>

                <div>
                    <label htmlFor="callTextarea" className="block text-caption font-bold text-ink-strong mb-2 uppercase tracking-wide">
                        Skambučio aprašymas
                    </label>
                    <textarea
                        ref={textareaRef}
                        id="callTextarea"
                        name="callDescription"
                        placeholder="Trumpai aprašykite skambutį..."
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

                {/* Footer */}
                <div className="mt-6 flex gap-3 justify-end">
                    <Button type="button" variant="secondary" onClick={onClose}>
                        Atšaukti
                    </Button>
                    <Button type="submit" variant="primary" loading={isSubmitting} icon={Check}>
                        {isSubmitting ? 'Saugoma...' : 'Išsaugoti skambutį'}
                    </Button>
                </div>
            </form>
        </Modal>
    );
});

export default function CallTimer({ compact = false }) {
    const { currentUser, userData, setOptimisticUserData } = useAuth();
    const { isSecondarySessionActive, activeSessionType } = useActiveSessionStatus();

    const {
        isActive: isCalling,
        currentSessionMinutes,
        startTime
    } = useTimerState(currentUser, 'callState', 'isCalling', null, null, 'call');

    const isDisabled = isSecondarySessionActive && !isCalling && activeSessionType !== 'break' && activeSessionType !== 'quickWork';

    const [showTitleModal, setShowTitleModal] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');

    const handleStartCall = async () => {
        if (!currentUser || isDisabled) return;
        setError('');
        try {
            // Optimistic UI Update: Instantly assume call started, clear other sessions
            setOptimisticUserData({
                ...userData,
                activeSession: {
                    type: 'call',
                    startTime: new Date().toISOString(),
                    pausedSession: userData?.activeSession || null
                },
                callState: { ...userData?.callState, isCalling: true, lastStartedAt: new Date().toISOString() },
                breakState: { ...userData?.breakState, isTakingBreak: false },
                quickWorkState: { ...userData?.quickWorkState, isQuickWorking: false },
                workStatus: { ...userData?.workStatus, isWorking: false, status: 'paused' }
            });

            await startSession(currentUser.uid, 'call');
            SoundManager.playCallSound();
        } catch (err) {
            console.error("Error starting call:", err);
            setOptimisticUserData(null); // Revert
            setError("Nepavyko pradėti skambučio. Bandykite dar kartą.");
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
        setError('');
        try {
            // Determine what will be restored from pausedSession
            const pausedSession = userData?.activeSession?.pausedSession;
            const pausedType = pausedSession?.type;
            const optimistic = { ...userData, callState: { ...userData?.callState, isCalling: false } };

            if (pausedType === 'break') {
                optimistic.activeSession = pausedSession;
                optimistic.breakState = { ...userData?.breakState, isTakingBreak: true };
            } else if (pausedType === 'quickWork') {
                optimistic.activeSession = pausedSession;
                optimistic.quickWorkState = { ...userData?.quickWorkState, isQuickWorking: true };
            } else if (pausedType === 'task' && pausedSession?.taskId) {
                optimistic.activeSession = pausedSession;
                optimistic.workStatus = { isWorking: true, status: 'running', activeTaskId: pausedSession.taskId };
            } else {
                // Fallback: check resumableTaskIds
                const resumableTasks = userData?.callState?.resumableTaskIds || [];
                const activeTaskId = resumableTasks.length > 0 ? resumableTasks[0] : null;
                optimistic.activeSession = activeTaskId ? { type: 'task', startTime: new Date().toISOString(), taskId: activeTaskId } : null;
                optimistic.workStatus = activeTaskId ? { isWorking: true, status: 'running', activeTaskId } : userData?.workStatus;
            }

            // Optimistic UI Update: Instantly assume call ended and paused session restored
            setOptimisticUserData(optimistic);

            // End session with custom title overrides
            await endSession(currentUser.uid, null, { customTitle: taskTitle });
            setShowTitleModal(false);
        } catch (err) {
            console.error("Error completing call:", err);
            setOptimisticUserData(null); // Revert
            setError("Nepavyko išsaugoti skambučio. Bandykite dar kartą.");
        } finally {
            setIsSubmitting(false);
        }
    }, [currentUser, userData, setOptimisticUserData]);

    const handleToggleCall = async () => {
        if (!currentUser || isDisabled) return;

        setError('');
        try {
            if (!isCalling) {
                await handleStartCall();
            } else {
                await handleStopCall();
            }
        } catch (err) {
            console.error("Error toggling call:", err);
            setError("Nepavyko pakeisti skambučio būsenos. Bandykite dar kartą.");
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
                {/* Timer Display — live readout (color is never the sole signal) */}
                {isCalling ? (
                    <span
                        className="text-body-lg font-bold text-session-call-accent font-mono mb-1 leading-6 animate-pulse"
                        aria-live="polite"
                    >
                        {totalDisplay}
                    </span>
                ) : (
                    <span className="text-body-lg font-bold text-transparent font-mono mb-1 leading-6 select-none" aria-hidden="true">
                        00:00
                    </span>
                )}

                <button
                    onClick={handleToggleCall}
                    disabled={isDisabled}
                    aria-label={isCalling ? "Baigti skambutį" : (isDisabled ? "Kitas veiksmas jau aktyvus" : "Pradėti skambutį")}
                    className={clsx(
                        "inline-flex items-center justify-center min-h-touch min-w-touch rounded-control transition-all active:scale-95",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                        isDisabled
                            ? "opacity-50 cursor-not-allowed bg-surface-sunken text-ink-muted"
                            : isCalling
                                ? 'bg-session-call-accent text-white ring-2 ring-blue-100'
                                : 'text-ink hover:bg-surface-sunken'
                    )}
                    title={isCalling ? "Baigti skambutį" : (isDisabled ? "Kitas veiksmas jau aktyvus" : "Pradėti skambutį")}
                >
                    {isCalling ? (
                        <Square className="w-5 h-5 fill-current" aria-hidden="true" />
                    ) : (
                        <Phone className="w-5 h-5" aria-hidden="true" />
                    )}
                </button>

                {/* Always-visible text label so color/icon is never the sole signal (WCAG 1.4.1) */}
                <span className="mt-1 text-caption font-medium text-ink-muted leading-none">Skambutis</span>

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
                onClick={handleToggleCall}
                disabled={isDisabled}
                aria-label={isCalling ? "Baigti skambutį" : (isDisabled ? "Kitas veiksmas jau aktyvus" : "Pradėti skambutį")}
                className={clsx(
                    "flex-1 flex items-center justify-between min-h-touch px-4 py-3 rounded-card transition-all shadow-sm active:scale-95 border min-w-[140px]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                    isDisabled ? "bg-surface-sunken text-ink-muted cursor-not-allowed border-line" :
                        isCalling
                            ? clsx('bg-session-call-surface border-line ring-1 ring-line', getSessionColors('call').accent)
                            : 'bg-surface-card border-line text-ink hover:bg-surface-sunken hover:border-line'
                )}
                title={isDisabled ? "Kitas veiksmas jau aktyvus" : ""}
            >
                <div className="flex items-center gap-3">
                    <div className={clsx("rounded-control", isCalling ? "text-session-call-accent" : "text-ink-muted")}>
                        {isCalling ? (
                            <Square className="w-5 h-5 fill-current" aria-hidden="true" />
                        ) : (
                            <Phone className="w-5 h-5" aria-hidden="true" />
                        )}
                    </div>
                    <div className="flex flex-col items-start leading-tight">
                        <span className="text-caption font-bold uppercase tracking-wider text-ink-muted">Skambutis</span>
                        {isCalling && <span className="text-caption font-semibold text-session-call-accent">Skambinama...</span>}
                    </div>
                </div>

                <span className={clsx(
                    "text-lg font-mono font-bold ml-2",
                    isCalling ? "text-session-call-accent" : "text-ink-muted"
                )}>
                    {totalDisplay}
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
