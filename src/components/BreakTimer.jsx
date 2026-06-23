import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useActiveSessionStatus, getInterruptionReason } from '../hooks/useActiveSessionStatus';
import { useTimerState } from '../hooks/useTimerState';
import { Coffee, Play, ShieldAlert } from 'lucide-react';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import clsx from 'clsx';
import { SoundManager } from '../utils/soundUtils';
import { startSession, endSession } from '../utils/sessionActions';

export default function BreakTimer({ currentUser: _propUser, compact = false, hideLabel = false }) {
    const { currentUser, userData, setOptimisticUserData } = useAuth();
    const { isSecondarySessionActive, activeSessionType } = useActiveSessionStatus();
    const {
        isActive: isTakingBreak,
        currentSessionMinutes
    } = useTimerState(currentUser, 'breakState', 'isTakingBreak', null, null, 'break');

    const isDisabled = isSecondarySessionActive && !isTakingBreak && activeSessionType !== 'quickWork';

    const [error, setError] = useState('');

    const handleToggleBreak = async () => {
        if (!currentUser || isDisabled) return;

        setError('');
        try {
            if (!isTakingBreak) {
                // Optimistic UI Update: Instantly assume break started, clear all other sessions
                setOptimisticUserData({
                    ...userData,
                    activeSession: { type: 'break', startTime: new Date().toISOString() },
                    breakState: { ...userData?.breakState, isTakingBreak: true, lastStartedAt: new Date().toISOString() },
                    // Clear other session flags so Layout shows break color
                    callState: { ...userData?.callState, isCalling: false },
                    quickWorkState: { ...userData?.quickWorkState, isQuickWorking: false },
                    workStatus: { ...userData?.workStatus, isWorking: false, status: 'paused' }
                });

                // Start Break Session
                await startSession(currentUser.uid, 'break');

                // Play Break sound
                SoundManager.playBreakSound();

            } else {
                // Determine what session was paused by this break
                const pausedSession = userData?.activeSession?.pausedSession;
                const pausedType = pausedSession?.type;

                // Build the optimistic state based on what will be restored
                const optimistic = {
                    ...userData,
                    breakState: { ...userData?.breakState, isTakingBreak: false },
                };

                if (pausedType === 'quickWork') {
                    // Quick Work will be restored
                    optimistic.activeSession = pausedSession;
                    optimistic.quickWorkState = { ...userData?.quickWorkState, isQuickWorking: true };
                    optimistic.workStatus = { ...userData?.workStatus, isWorking: false, status: 'idle' };
                } else if (pausedType === 'call') {
                    // Call will be restored
                    optimistic.activeSession = pausedSession;
                    optimistic.callState = { ...userData?.callState, isCalling: true };
                    optimistic.workStatus = { ...userData?.workStatus, isWorking: false, status: 'idle' };
                } else if (pausedType === 'task' && pausedSession?.taskId) {
                    // Task will be restored
                    optimistic.activeSession = pausedSession;
                    optimistic.workStatus = { isWorking: true, status: 'running', activeTaskId: pausedSession.taskId };
                } else {
                    // Check resumable tasks as fallback
                    const resumableTasks = userData?.breakState?.resumableTaskIds || [];
                    const activeTaskId = resumableTasks.length > 0 ? resumableTasks[0] : null;
                    optimistic.activeSession = activeTaskId ? { type: 'task', startTime: new Date().toISOString(), taskId: activeTaskId } : null;
                    optimistic.workStatus = activeTaskId ? { isWorking: true, status: 'running', activeTaskId } : userData?.workStatus;
                }

                setOptimisticUserData(optimistic);

                // End Break Session
                await endSession(currentUser.uid);

                // Play Break sound when stopping
                SoundManager.playBreakSound();
            }
        } catch (err) {
            console.error("Error toggling break:", err);
            // Revert optimistic update on failure (it will naturally happen on next snapshot, but we can clear it immediately)
            setOptimisticUserData(null);
            setError("Nepavyko pakeisti pertraukos būsenos. Bandykite dar kartą.");
        }
    };

    const totalDisplay = formatMinutesToTimeString(currentSessionMinutes);

    if (compact) {
        return (
            <div className="flex flex-col items-center">
                {/* Live time is surfaced by ActiveSessionReadout above the bar, so the column
                    itself stays as short as button + label (no reserved readout row). */}
                <button
                    onClick={handleToggleBreak}
                    disabled={isDisabled}
                    aria-label={isTakingBreak ? "Tęsti darbą" : (isDisabled ? getInterruptionReason(activeSessionType) : "Pertrauka")}
                    className={clsx(
                        "inline-flex items-center justify-center min-h-touch min-w-touch rounded-control transition-all active:scale-95",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                        isDisabled
                            ? "opacity-50 cursor-not-allowed bg-surface-sunken text-ink-muted"
                            : isTakingBreak
                                ? 'bg-session-break-accent text-white ring-2 ring-session-break-shell'
                                : 'bg-surface-sunken text-ink hover:bg-line'
                    )}
                    title={isTakingBreak ? "Tęsti darbą" : (isDisabled ? getInterruptionReason(activeSessionType) : "Pertrauka")}
                >
                    {isTakingBreak ? (
                        <Play className="w-5 h-5 fill-current" aria-hidden="true" />
                    ) : (
                        <Coffee className="w-5 h-5" aria-hidden="true" />
                    )}
                </button>

                {/* Always-visible text label so color/icon is never the sole signal (WCAG 1.4.1).
                    Suppressed only in the collapsed side rail (`hideLabel`), where the icon SHAPE
                    differs by state and the button keeps its aria-label + title tooltip. */}
                {!hideLabel && (
                    <span className="mt-1 text-caption font-medium text-ink-muted leading-none">Pertrauka</span>
                )}

                {error && (
                    <div className="mt-2 flex items-start gap-2 rounded-control border-l-4 border-feedback-danger bg-feedback-danger/10 p-2" role="alert">
                        <ShieldAlert className="h-4 w-4 shrink-0 text-feedback-danger" aria-hidden="true" />
                        <p className="text-caption text-feedback-danger">{error}</p>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="flex items-center gap-3">
            {isTakingBreak && (
                <div className="flex flex-col items-end mr-2">
                    <span className="text-body-lg font-bold text-session-break-accent font-mono">
                        {totalDisplay}
                    </span>
                </div>
            )}

            <div className="flex flex-col items-stretch">
                <button
                    onClick={handleToggleBreak}
                    disabled={isDisabled}
                    aria-label={isTakingBreak ? "Tęsti darbą" : (isDisabled ? getInterruptionReason(activeSessionType) : "Pertrauka")}
                    className={clsx(
                        "inline-flex items-center justify-center gap-2 min-h-touch px-4 py-2.5 rounded-control text-body font-medium transition-colors shadow-sm",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
                        isDisabled ? "bg-surface-sunken text-ink-muted cursor-not-allowed border border-line" :
                            isTakingBreak
                                ? 'bg-session-break-surface text-session-break-accent hover:bg-session-break-shell border border-session-break-soft'
                                : 'bg-surface-card text-ink hover:bg-surface-sunken border border-line'
                    )}
                    title={isDisabled ? getInterruptionReason(activeSessionType) : ""}
                >
                    {isTakingBreak ? (
                        <>
                            <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                            Tęsti darbą
                        </>
                    ) : (
                        <>
                            <Coffee className="w-4 h-4" aria-hidden="true" />
                            Pertrauka
                        </>
                    )}
                </button>

                {error && (
                    <div className="mt-2 flex items-start gap-2 rounded-control border-l-4 border-feedback-danger bg-feedback-danger/10 p-2" role="alert">
                        <ShieldAlert className="h-4 w-4 shrink-0 text-feedback-danger" aria-hidden="true" />
                        <p className="text-caption text-feedback-danger">{error}</p>
                    </div>
                )}
            </div>
        </div>
    );
}
