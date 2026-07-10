import { useState, useRef } from 'react';
import { doc, getDoc, getDocFromCache } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { useActiveSessionStatus, getInterruptionReason } from '../hooks/useActiveSessionStatus';
import { useTimerState } from '../hooks/useTimerState';
import { Coffee, Play, ShieldAlert } from 'lucide-react';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { SoundManager } from '../utils/soundUtils';
import { startSession, endSession } from '../utils/sessionActions';
import { useRevisionedTimerSession } from '../hooks/useRevisionedTimerSession';
import { issueTimerCommand } from '../utils/timerCommandEngine';
import {
    canonicalSessionState,
    planBreakEnd,
    planBreakStart,
} from '../utils/timerTransitionPlan';
import { logError } from '../utils/errorLog';
import SessionToggleButton from './ui/SessionToggleButton';

const idFor = (prefix) => {
    const random = globalThis.crypto?.randomUUID?.()
        || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${random}`;
};

async function loadTaskForTimer(taskId) {
    if (!taskId) return null;
    const ref = doc(db, 'tasks', taskId);
    try {
        const cached = await getDocFromCache(ref);
        if (cached.exists()) return { id: cached.id, ...cached.data() };
    } catch {
        // Fall through to the normal read; it may still use cache while offline.
    }
    const snapshot = await getDoc(ref);
    return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

export default function BreakTimer({ currentUser: _propUser, compact = false, hideLabel = false }) {
    const { currentUser, userData, setPendingSessionProjection, timerEngineEnabled } = useAuth();
    const revisionedSession = useRevisionedTimerSession(currentUser?.uid, timerEngineEnabled);
    const { isSecondarySessionActive, activeSessionType } = useActiveSessionStatus();
    const {
        isActive: isTakingBreak,
        currentSessionMinutes
    } = useTimerState(currentUser, 'breakState', 'isTakingBreak', null, null, 'break');

    const isDisabled = isSecondarySessionActive && !isTakingBreak && activeSessionType !== 'quickWork';

    const [error, setError] = useState('');
    // Guards the toggle while its Firestore round-trip is in flight, so a rapid double-tap on a slow
    // connection cannot fire startSession/endSession twice (a second start would nest a break inside
    // a break; a second end could close one session too many). Mirrors TaskTimerControls.
    const actionInFlightRef = useRef(false);

    const trackRevisionedBreak = async (plan) => {
        const issued = await issueTimerCommand(plan);
        issued.settlement.then((outcome) => {
            if (outcome.status === 'confirmed' || outcome.status === 'queued') return;
            setError(
                outcome.status === 'conflicted'
                    ? 'Sesija pakeista kitame įrenginyje. Parodyta naujausia būsena.'
                    : 'Nepavyko pakeisti pertraukos būsenos. Bandykite dar kartą.'
            );
            logError(outcome.error || new Error(`Break command ${outcome.status}`), {
                source: 'BreakTimer.revisionedSettlement',
                commandId: outcome.commandId,
                outcome: outcome.status,
            });
        }).catch((error) => {
            setError('Nepavyko pakeisti pertraukos būsenos. Bandykite dar kartą.');
            logError(error, {
                source: 'BreakTimer.revisionedSettlement',
                commandId: issued.commandId,
            });
        });
    };

    const tryRevisionedBreakToggle = async () => {
        if (!timerEngineEnabled) return false;
        if (!revisionedSession.loaded || revisionedSession.error) {
            setError('Laikmačio būsena dar nepasiekiama. Bandykite dar kartą.');
            return true;
        }

        const base = canonicalSessionState(revisionedSession.record, {
            ...userData,
            id: currentUser.uid,
        });
        const baseIsPersistedCanonical = Boolean(revisionedSession.record);

        if (!isTakingBreak) {
            if (base.status === 'active' && base.run?.type !== 'task') {
                if (baseIsPersistedCanonical) {
                    setError('Pirma užbaikite aktyvią veiklą kitame įrenginyje.');
                    return true;
                }
                return false;
            }

            const currentTask = base.status === 'active'
                ? await loadTaskForTimer(base.run?.taskId)
                : null;
            if (base.status === 'active' && !currentTask) {
                setError('Nepavyko įkelti aktyvios užduoties. Prisijunkite prie interneto ir bandykite dar kartą.');
                return true;
            }

            const now = new Date().toISOString();
            const plan = planBreakStart({
                userId: currentUser.uid,
                userData,
                activeRecord: revisionedSession.record,
                currentTask,
                commandId: idFor('timer_cmd'),
                runId: idFor('timer_run'),
                issuedAt: now,
            });
            await trackRevisionedBreak(plan);
            SoundManager.playBreakSound();
            return true;
        }

        if (base.status !== 'active' || base.run?.type !== 'break') {
            if (baseIsPersistedCanonical) {
                setError('Pertraukos būsena jau pakeista. Parodyta naujausia būsena.');
                return true;
            }
            return false;
        }

        const pausedSession = base.run?.pausedSession || userData?.activeSession?.pausedSession || null;
        if (pausedSession?.type && pausedSession.type !== 'task') {
            if (baseIsPersistedCanonical) {
                setError('Šiai pertraukos kombinacijai dar naudojamas senasis užbaigimo kelias.');
                return true;
            }
            return false;
        }

        let restoreTask = null;
        if (pausedSession?.taskId) {
            restoreTask = await loadTaskForTimer(pausedSession.taskId);
            if (!restoreTask) {
                restoreTask = {
                    id: pausedSession.taskId,
                    title: pausedSession.taskTitle || 'Užduotis',
                };
            }
        }

        const now = new Date().toISOString();
        const plan = planBreakEnd({
            userId: currentUser.uid,
            userData,
            activeRecord: revisionedSession.record,
            restoreTask,
            commandId: idFor('timer_cmd'),
            runId: restoreTask ? idFor('timer_run') : null,
            issuedAt: now,
        });
        await trackRevisionedBreak(plan);
        SoundManager.playBreakSound();
        return true;
    };

    const handleToggleBreak = async () => {
        if (!currentUser || isDisabled) return;
        if (actionInFlightRef.current) return;
        actionInFlightRef.current = true;

        setError('');
        try {
            if (await tryRevisionedBreakToggle()) return;

            if (!isTakingBreak) {
                // Optimistic UI Update: Instantly assume break started, clear all other sessions
                setPendingSessionProjection({
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

                setPendingSessionProjection(optimistic);

                // End Break Session
                await endSession(currentUser.uid);

                // Play Break sound when stopping
                SoundManager.playBreakSound();
            }
        } catch (err) {
            console.error("Error toggling break:", err);
            // Revert optimistic update on failure (it will naturally happen on next snapshot, but we can clear it immediately)
            setPendingSessionProjection(null);
            setError("Nepavyko pakeisti pertraukos būsenos. Bandykite dar kartą.");
        } finally {
            actionInFlightRef.current = false;
        }
    };

    const totalDisplay = formatMinutesToTimeString(currentSessionMinutes);

    if (compact) {
        return (
            <div className="flex flex-col items-center">
                {/* Live time is surfaced by ActiveSessionReadout above the bar, so the column
                    itself stays as short as button + label (no reserved readout row). */}
                <SessionToggleButton
                    session="break"
                    variant="compact"
                    active={isTakingBreak}
                    disabled={isDisabled}
                    onClick={handleToggleBreak}
                    aria-label={isTakingBreak ? "Tęsti veiklą" : (isDisabled ? getInterruptionReason(activeSessionType) : "Pertrauka")}
                    title={isTakingBreak ? "Tęsti veiklą" : (isDisabled ? getInterruptionReason(activeSessionType) : "Pertrauka")}
                >
                    {isTakingBreak ? (
                        <Play className="w-5 h-5 fill-current" aria-hidden="true" />
                    ) : (
                        <Coffee className="w-5 h-5" aria-hidden="true" />
                    )}
                </SessionToggleButton>

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
                <SessionToggleButton
                    session="break"
                    variant="labeled"
                    active={isTakingBreak}
                    disabled={isDisabled}
                    onClick={handleToggleBreak}
                    aria-label={isTakingBreak ? "Tęsti veiklą" : (isDisabled ? getInterruptionReason(activeSessionType) : "Pertrauka")}
                    title={isDisabled ? getInterruptionReason(activeSessionType) : ""}
                >
                    {isTakingBreak ? (
                        <>
                            <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                            Tęsti veiklą
                        </>
                    ) : (
                        <>
                            <Coffee className="w-4 h-4" aria-hidden="true" />
                            Pertrauka
                        </>
                    )}
                </SessionToggleButton>

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
