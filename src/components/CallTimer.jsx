import React, { useState, useRef, useCallback } from 'react';
import { useActiveSessionStatus, getInterruptionReason } from '../hooks/useActiveSessionStatus';
import { useTimerState } from '../hooks/useTimerState';
import { useSpeechDictation } from '../hooks/useSpeechDictation';
import { Phone, Square, Check, ShieldAlert, Mic } from 'lucide-react';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { SoundManager } from '../utils/soundUtils';
import { startSession, endSession } from '../utils/sessionActions';
import { getSessionColors } from '../utils/sessionColors';
import { CALL_CONTACT_TYPES } from '../utils/callContacts';
import Modal from './ui/Modal';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import SessionToggleButton from './ui/SessionToggleButton';

// Separate memoized modal component to prevent re-renders from timer updates
const CallModalComponent = React.memo(function CallModalComponent({ onSubmit, onClose, onDiscard, currentSessionMinutes, isSubmitting, isDiscarding }) {
    const textareaRef = useRef(null);
    // Who was on the call — required (single-select). The call cannot be saved until one is
    // chosen, so reports can always group calls by audience. Notes are free-text and optional.
    const [contactType, setContactType] = useState(null);
    // Annul ("Anuliuoti") throws the whole call away — its time is logged nowhere — so it is
    // guarded by one explicit inline confirm (kept INSIDE this modal, never a second stacked
    // dialog) rather than firing on the first tap.
    const [confirmingDiscard, setConfirmingDiscard] = useState(false);
    const busy = isSubmitting || isDiscarding;
    const totalDisplay = formatMinutesToTimeString(currentSessionMinutes);
    const { supported: dictationSupported, isListening, toggle: toggleDictation } = useSpeechDictation(textareaRef);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!contactType) return;
        onSubmit({ contactType, notes: textareaRef.current?.value || '' });
    };

    return (
        <Modal
            open
            onClose={onClose}
            title="Skambučio pabaiga"
            size="md"
        >
            <form onSubmit={handleSubmit} className="flex flex-col">
                <div className="mb-5 bg-session-call-surface rounded-card p-4 border border-session-call-soft flex items-center justify-between">
                    <span className="text-body-lg font-semibold text-session-call-accent">Užfiksuotas laikas:</span>
                    <span className="text-4xl font-mono font-bold text-session-call-accent">{totalDisplay}</span>
                </div>

                {/* Required: who was on the call. Color is never the sole signal — the chosen chip
                    also carries a check icon and an accessible pressed state (WCAG 1.4.1). */}
                <fieldset className="mb-5">
                    <legend className="block text-caption font-bold text-ink-strong mb-2 uppercase tracking-wide">
                        Su kuo kalbėjote?
                    </legend>
                    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Su kuo kalbėjote">
                        {CALL_CONTACT_TYPES.map(({ id, chip, Icon }) => {
                            const selected = contactType === id;
                            return (
                                <button
                                    key={id}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    onClick={() => setContactType(id)}
                                    className={clsx(
                                        'inline-flex items-center gap-2 min-h-touch px-3 py-2 rounded-control border-2 text-left transition-all active:scale-95',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                                        selected
                                            ? 'bg-session-call-surface border-session-call-accent text-session-call-accent font-semibold'
                                            : 'bg-surface-card border-line text-ink hover:bg-surface-sunken'
                                    )}
                                >
                                    {selected
                                        ? <Check className="w-5 h-5 shrink-0" aria-hidden="true" />
                                        : <Icon className="w-5 h-5 shrink-0 text-ink-muted" aria-hidden="true" />}
                                    <span className="text-body">{chip}</span>
                                </button>
                            );
                        })}
                    </div>
                </fieldset>

                <div>
                    <label htmlFor="callTextarea" className="block text-caption font-bold text-ink-strong mb-2 uppercase tracking-wide">
                        Pastabos
                    </label>
                    <div className="relative">
                        <textarea
                            ref={textareaRef}
                            id="callTextarea"
                            name="callNotes"
                            placeholder="Trumpos pastabos apie skambutį (neprivaloma)..."
                            rows={4}
                            className="border-2 border-line rounded-card bg-surface-card text-ink-strong"
                            style={{
                                width: '100%',
                                // Reserve room at the bottom-right so dictated text never slides under the mic.
                                padding: dictationSupported ? '12px 12px 52px 12px' : '12px',
                                fontSize: '16px',
                                resize: 'none',
                                direction: 'ltr',
                                textAlign: 'left'
                            }}
                        />
                        {/* Voice dictation — feature-detected; hidden where the Web Speech API is
                            absent. Listening state is signalled by color AND a label change AND the
                            filled/outline mic glyph, so color is never the sole cue (§5). */}
                        {dictationSupported && (
                            <IconButton
                                icon={Mic}
                                label={isListening ? 'Stabdyti diktavimą' : 'Diktuoti balsu'}
                                variant={isListening ? 'danger-solid' : 'default'}
                                aria-pressed={isListening}
                                onClick={toggleDictation}
                                className={clsx(
                                    'absolute bottom-2 right-2',
                                    isListening && 'wz-pulse-soft'
                                )}
                            />
                        )}
                    </div>
                    {isListening && (
                        <p className="mt-2 text-caption text-feedback-danger" role="status">
                            Klausomasi… kalbėkite, tekstas atsiras laukelyje.
                        </p>
                    )}
                </div>

                {/* Footer. Three intents: Anuliuoti throws the call away (no log anywhere),
                    Atšaukti just closes this prompt and leaves the call running, Išsaugoti logs it.
                    "Anuliuoti" swaps the footer for an inline confirm so the irreversible time loss
                    is always a deliberate two-step. */}
                {confirmingDiscard ? (
                    <div className="mt-6 rounded-card border border-feedback-danger-soft bg-feedback-danger-soft p-4">
                        <p className="text-body text-feedback-danger-text mb-3">
                            Anuliuoti šį skambutį? Užfiksuotas laikas ({totalDisplay}) nebus niekur išsaugotas.
                        </p>
                        <div className="flex gap-3 justify-end">
                            <Button type="button" variant="secondary" onClick={() => setConfirmingDiscard(false)} disabled={busy}>
                                Grįžti
                            </Button>
                            <Button type="button" variant="danger" loading={isDiscarding} onClick={onDiscard}>
                                Taip, anuliuoti
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                        <Button type="button" variant="ghost" className="text-feedback-danger hover:text-feedback-danger" onClick={() => setConfirmingDiscard(true)} disabled={busy}>
                            Anuliuoti skambutį
                        </Button>
                        <div className="flex gap-3 justify-end">
                            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
                                Atšaukti
                            </Button>
                            <Button type="submit" variant="primary" loading={isSubmitting} icon={Check} disabled={!contactType || busy}>
                                {isSubmitting ? 'Saugoma...' : 'Išsaugoti skambutį'}
                            </Button>
                        </div>
                    </div>
                )}
            </form>
        </Modal>
    );
});

export default function CallTimer({ compact = false, hideLabel = false }) {
    const { currentUser, userData, setOptimisticUserData } = useAuth();
    const { isSecondarySessionActive, activeSessionType } = useActiveSessionStatus();

    const {
        isActive: isCalling,
        currentSessionMinutes
    } = useTimerState(currentUser, 'callState', 'isCalling', null, null, 'call');

    const isDisabled = isSecondarySessionActive && !isCalling && activeSessionType !== 'break' && activeSessionType !== 'quickWork';

    const [showTitleModal, setShowTitleModal] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isDiscarding, setIsDiscarding] = useState(false);
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
        // The end-of-call modal is the deliberate gate for classifying the call (who was on it +
        // optional notes), so it ALWAYS opens when a call is stopped — even a very short one. The
        // worker then chooses to classify, defer ("Vėliau aprašysiu"), or cancel (resume the call).
        // This intentionally drops the old sub-minute auto-discard, which silently swallowed brief
        // calls without ever asking; a real but short call must not vanish. Accidental mis-taps are
        // handled at the modal (Atšaukti resumes the call), not by suppressing the prompt.
        SoundManager.playCallSound();
        setShowTitleModal(true);
    };

    // Shared end-of-call flow. On the classify-now path it carries the chosen counterpart type
    // and optional notes; the defer path passes neither, so endSession logs a plain "Skambutis"
    // (contactType null) and the worker isn't blocked at the stop screen. Either way the same
    // paused-session restore logic runs.
    const finishCall = useCallback(async ({ contactType = null, notes = '', discard = false } = {}) => {
        // The two end paths share ALL the paused-session restore logic below; they differ only in
        // what reaches endSession — a real classification vs. a `discard` flag that suppresses every
        // log. Separate busy flags so each button shows its own spinner without disabling the other.
        const setBusy = discard ? setIsDiscarding : setIsSubmitting;
        setBusy(true);
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

            // End session. On the SAVE path the logger (handleLegacyLogging) derives the call title
            // from contactType ("Skambutis – Klientas", or plain "Skambutis" when null on the defer
            // path) and folds the optional notes into the description. On the DISCARD path the
            // `discard` flag makes endSession skip every log, so the call is recorded nowhere.
            await endSession(currentUser.uid, null, discard ? { discard: true } : { contactType, callNotes: (notes || '').trim() });
            setShowTitleModal(false);
        } catch (err) {
            console.error(discard ? "Error discarding call:" : "Error completing call:", err);
            setOptimisticUserData(null); // Revert
            setError(discard
                ? "Nepavyko anuliuoti skambučio. Bandykite dar kartą."
                : "Nepavyko išsaugoti skambučio. Bandykite dar kartą.");
        } finally {
            setBusy(false);
        }
    }, [currentUser, userData, setOptimisticUserData]);

    // Classify-now: the modal hands over the required contactType + optional notes. This is the
    // ONLY save path — every logged call must name who was on it, so reports can always group by
    // audience. (Cancelling just resumes the call.)
    const handleCompleteCall = useCallback(({ contactType, notes }) => {
        if (!contactType) return;
        return finishCall({ contactType, notes });
    }, [finishCall]);

    // Annul: end the call but log it nowhere — its whole duration is thrown away. The modal's
    // inline confirm already gated this, so it fires straight through.
    const handleDiscardCall = useCallback(() => finishCall({ discard: true }), [finishCall]);

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
            onDiscard={handleDiscardCall}
            currentSessionMinutes={currentSessionMinutes}
            isSubmitting={isSubmitting}
            isDiscarding={isDiscarding}
        />
    );

    // Render Compact (Mobile)
    if (compact) {
        return (
            <div className="flex flex-col items-center">
                {/* Live time is surfaced by ActiveSessionReadout above the bar, so the column
                    itself stays as short as button + label (no reserved readout row). */}
                <SessionToggleButton
                    session="call"
                    variant="compact"
                    active={isCalling}
                    disabled={isDisabled}
                    onClick={handleToggleCall}
                    aria-label={isCalling ? "Baigti skambutį" : (isDisabled ? getInterruptionReason(activeSessionType) : "Pradėti skambutį")}
                    title={isCalling ? "Baigti skambutį" : (isDisabled ? getInterruptionReason(activeSessionType) : "Pradėti skambutį")}
                >
                    {isCalling ? (
                        <Square className="w-5 h-5 fill-current" aria-hidden="true" />
                    ) : (
                        <Phone className="w-5 h-5" aria-hidden="true" />
                    )}
                </SessionToggleButton>

                {/* Always-visible text label so color/icon is never the sole signal (WCAG 1.4.1).
                    Suppressed only in the collapsed side rail (`hideLabel`), where the icon SHAPE
                    differs by state and the button keeps its aria-label + title tooltip. */}
                {!hideLabel && (
                    <span className="mt-1 text-caption font-medium text-ink-muted leading-none">Skambutis</span>
                )}

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
                aria-label={isCalling ? "Baigti skambutį" : (isDisabled ? getInterruptionReason(activeSessionType) : "Pradėti skambutį")}
                className={clsx(
                    "flex-1 flex items-center justify-between min-h-touch px-4 py-3 rounded-card transition-all shadow-sm active:scale-95 border min-w-[140px]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                    isDisabled ? "bg-surface-sunken text-ink-muted cursor-not-allowed border-line" :
                        isCalling
                            ? clsx('bg-session-call-surface border-line ring-1 ring-line', getSessionColors('call').accent)
                            : 'bg-surface-card border-line text-ink hover:bg-surface-sunken hover:border-line'
                )}
                title={isDisabled ? getInterruptionReason(activeSessionType) : ""}
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
