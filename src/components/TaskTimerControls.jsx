import { useState, useEffect, useRef } from 'react';
import { Play, Pause, Square, Clock } from 'lucide-react';
import { doc, updateDoc, collection, addDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString, parseTimeStringToMinutes, getLithuanianNow, getLithuanianDateString, clampSessionMinutes } from '../utils/timeUtils';
import { startTask, pauseTask, resumeTask } from '../utils/taskActions';
import { isManagerRole } from '../utils/formatters';
import { logError } from '../utils/errorLog';
import { SoundManager } from '../utils/soundUtils';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useActiveSessionStatus, getInterruptionReason } from '../hooks/useActiveSessionStatus';
import Button from './ui/Button';
import ConfirmDialog from './ui/ConfirmDialog';

// stopBreak/stopCall no longer needed — startTask/resumeTask handle session cleanup

export default function TaskTimerControls({ task, onShowModal: _onShowModal, role }) {
    const { currentUser, userRole, userData, setOptimisticUserData } = useAuth();
    const { showToast } = useToast();
    const { isSecondarySessionActive, activeSessionType } = useActiveSessionStatus();
    const isAssignedToMe = currentUser?.uid === task.assignedUserId;

    // Strict UI logic: The task document (timerStatus) is the ULTIMATE source of truth for the timer.
    // We only display as running if BOTH the task and user profile agree.
    let isRunning = false;
    let isPaused = false;

    if (isAssignedToMe) {
        if (task.timerStatus === 'running') {
            isRunning = true;
        }

        // If it's not running right now, but timerStatus is explicitly 'paused', it must be paused
        if (!isRunning && task.timerStatus === 'paused') {
            isPaused = true;
        }
    } else {
         isRunning = task.timerStatus === 'running';
         isPaused = task.timerStatus === 'paused';
    }

    const [elapsedString, setElapsedString] = useState('');
    const [confirmFinish, setConfirmFinish] = useState(false);
    const [finishing, setFinishing] = useState(false);
    const [finishError, setFinishError] = useState('');
    // Inline accessible error for the start/pause/resume controls (replaces window.alert).
    const [actionError, setActionError] = useState('');

    // Live task reference so the 1s ticker reads fresh data without being torn down and
    // recreated on every Firestore snapshot (which hands us a brand-new `task` object).
    const taskRef = useRef(task);
    taskRef.current = task;
    // Guards a start/pause/resume action while its Firestore round-trip is in flight, so a
    // rapid double-tap on a slow connection cannot fire the handler twice and double-count
    // (a second pause would recompute elapsed from the same timerStartedAt and add it again).
    const actionInFlightRef = useRef(false);

    useEffect(() => {
        const updateTime = () => {
            const totalMinutes = calculateCurrentTotalMinutes(taskRef.current);
            const h = Math.floor(totalMinutes / 60);
            const m = Math.floor(totalMinutes % 60);
            setElapsedString(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
        };

        updateTime();

        let interval;
        if (isRunning) {
            interval = setInterval(updateTime, 1000);
        }
        return () => clearInterval(interval);
        // Stable primitive deps: refresh the static display when the relevant fields change,
        // and (re)start the ticker only on run-state change — never on bare object identity.
    }, [isRunning, task.id, task.timerStatus, task.timerStartedAt, task.timerMinutes, task.manualMinutes]);

    // Only allow the assigned worker to control the task
    // And restrict managers from controlling tasks in the Team View (where role === 'manager')
    if (!isAssignedToMe || isManagerRole(role)) return null;

    const handleStart = async (e) => {
        e.stopPropagation();
        if (isSecondarySessionActive) return;
        if (actionInFlightRef.current) return;
        actionInFlightRef.current = true;
        setActionError('');
        try {
            if (currentUser) {
                // Check if Quick Work is running - if so, prompt to stop it first
                if (userData?.quickWorkState?.isQuickWorking) {
                    window.dispatchEvent(new CustomEvent('stop-quick-work'));
                    return;
                }

                // Optimistic UI Update: Instantly assume task started and clear other sessions
                setOptimisticUserData({
                    ...userData,
                    activeSession: { type: 'task', startTime: new Date().toISOString(), taskId: task.id },
                    workStatus: { isWorking: true, status: 'running', activeTaskId: task.id },
                    breakState: { ...userData?.breakState, isTakingBreak: false },
                    callState: { ...userData?.callState, isCalling: false },
                    quickWorkState: { ...userData?.quickWorkState, isQuickWorking: false }
                });

                // Start task directly — startTask handles pausing other tasks
                // and updating the activeSession. No need to stop break/call separately.
                await startTask(task, currentUser.uid);
            }
        } catch (err) {
            console.error("Error starting timer:", err);
            setOptimisticUserData(null); // Revert on error
            // Only surface if we think it's a critical failure and we are online
            if (navigator.onLine) {
                setActionError('Nepavyko pradėti laikmačio. Bandykite dar kartą.');
            }
        } finally {
            actionInFlightRef.current = false;
        }
    };

    const handlePause = async (e) => {
        e.stopPropagation();
        if (!task.timerStartedAt) return;
        if (actionInFlightRef.current) return;
        actionInFlightRef.current = true;
        setActionError('');

        try {
            // Optimistic UI: instantly show paused state
            setOptimisticUserData({
                ...userData,
                activeSession: null,
                workStatus: { isWorking: false, status: 'paused', activeTaskId: task.id }
            });

            await pauseTask(task);
        } catch (err) {
            console.error("Error pausing timer:", err);
            setOptimisticUserData(null);
            if (navigator.onLine) {
                setActionError('Nepavyko sustabdyti laikmačio. Bandykite dar kartą.');
            }
        } finally {
            actionInFlightRef.current = false;
        }
    };

    const handleResume = async (e) => {
        e.stopPropagation();
        if (isSecondarySessionActive) return;
        if (actionInFlightRef.current) return;
        actionInFlightRef.current = true;
        setActionError('');
        try {
            if (currentUser) {
                // Check if Quick Work is running
                if (userData?.quickWorkState?.isQuickWorking) {
                    window.dispatchEvent(new CustomEvent('stop-quick-work'));
                    return;
                }

                // Optimistic UI Update: Instantly assume task resumed and clear other sessions
                setOptimisticUserData({
                    ...userData,
                    activeSession: { type: 'task', startTime: new Date().toISOString(), taskId: task.id },
                    workStatus: { isWorking: true, status: 'running', activeTaskId: task.id },
                    breakState: { ...userData?.breakState, isTakingBreak: false },
                    callState: { ...userData?.callState, isCalling: false }
                });

                // Resume task directly — resumeTask handles pausing other tasks
                // and updating the activeSession. No need to stop break/call separately.
                await resumeTask(task, currentUser.uid);
            }
        } catch (err) {
            console.error("Error resuming timer:", err);
            setOptimisticUserData(null); // Revert
            if (navigator.onLine) {
                setActionError('Nepavyko atnaujinti laikmačio. Bandykite dar kartą.');
            }
        } finally {
            actionInFlightRef.current = false;
        }
    };

    // Open the confirm dialog (stop propagation so the tap doesn't also hit the card).
    const openFinish = (e) => {
        e.stopPropagation();
        setFinishError('');
        setConfirmFinish(true);
    };

    const performFinish = async () => {
        setFinishing(true);
        try {
            let finalTimerMinutes = task.timerMinutes || 0;
            let currentManualMinutes = task.manualMinutes || 0;
            const start = task.timerStartedAt ? new Date(task.timerStartedAt) : null;
            const now = getLithuanianNow();

            // 1. If running, calculate elapsed (clamped like the pause path, so finishing
            // a task whose timer was orphaned across a crash cannot credit ghost hours).
            if (isRunning && start) {
                finalTimerMinutes += clampSessionMinutes((now - start) / (1000 * 60));
            }

            // 2. Prepare task data for completion
            const isManagerOrAdmin = isManagerRole(userRole) || currentUser?.uid === task.managerId;
            const totalMinutes = finalTimerMinutes + currentManualMinutes;
            const formattedTime = formatMinutesToTimeString(totalMinutes);

            // Destructure to strip denormalized display fields from the task before
            // writing it back to Firestore; the named siblings are intentionally unused.
            // eslint-disable-next-line no-unused-vars
            const { assignedUserName, assignedWorkerColor, creatorName, ...cleanTask } = task;

            const taskData = {
                ...cleanTask,
                timerStatus: 'paused',
                timerStartedAt: null,
                timerMinutes: finalTimerMinutes,
                manualMinutes: currentManualMinutes,
                actualTime: formattedTime,
                status: isManagerOrAdmin ? 'confirmed' : 'completed',
                completed: true,
                completedAt: now.toISOString(),
                confirmedBy: isManagerOrAdmin ? currentUser.uid : null,
                confirmedAt: isManagerOrAdmin ? now.toISOString() : null,
                updatedAt: now.toISOString()
            };

            // 3. Run task update + user status update in PARALLEL, work session log fire-and-forget
            if (isRunning && start) {
                const elapsedMinutes = clampSessionMinutes((now - start) / (1000 * 60));
                if (elapsedMinutes > 0.1) {
                    // Fire and forget work session log
                    // Attribute to the end date (now), consistent with the other
                    // work_sessions writers - start-based mis-bucketed midnight-spanning work.
                    const sessionDate = getLithuanianDateString(now);
                    addDoc(collection(db, 'work_sessions'), {
                        taskId: task.id,
                        taskTitle: task.title || 'Unknown Task',
                        userId: task.assignedUserId,
                        userName: currentUser.displayName || currentUser.email,
                        startTime: start.toISOString(),
                        endTime: now.toISOString(),
                        durationMinutes: elapsedMinutes,
                        date: sessionDate,
                        createdAt: new Date().toISOString()
                    }).catch(logErr => logError(logErr, { source: 'writeFail:finishTask.workSession' }));
                }
            }

            const promises = [updateDoc(doc(db, 'tasks', task.id), taskData)];

            if (task.assignedUserId === currentUser.uid) {
                // Determine if this task was the user's active one based on stale closure
                const wasRunning = isRunning && start;
                const wasActiveSession = userData?.activeSession?.taskId === task.id;
                const wasWorkStatusActive = userData?.workStatus?.activeTaskId === task.id;

                let shouldClearUserSession = false;

                if (wasRunning || wasActiveSession || wasWorkStatusActive) {
                    // Fetch real-time user doc to prevent race condition 
                    // where user actively started another task before finish completed
                    try {
                        const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
                        if (userSnap.exists()) {
                            const uData = userSnap.data();
                            const currentActiveTaskId = uData?.activeSession?.taskId || uData?.workStatus?.activeTaskId;
                            // Only clear if no task is active, or the currently active task is THIS task
                            if (!currentActiveTaskId || currentActiveTaskId === task.id) {
                                shouldClearUserSession = true;
                            }
                        } else {
                            shouldClearUserSession = true;
                        }
                    } catch (fetchErr) {
                        console.warn("Failed to fetch user doc to validate finish:", fetchErr);
                        shouldClearUserSession = true; // Fallback
                    }
                }

                if (shouldClearUserSession) {
                    promises.push(
                        updateDoc(doc(db, 'users', currentUser.uid), {
                            workStatus: {
                                isWorking: false,
                                status: 'idle',
                                activeTaskId: null,
                                lastUpdated: new Date().toISOString()
                            },
                            activeSession: null
                        })
                    );
                }
            }

            await Promise.all(promises);

            // Send task_completion notification to manager (workers only)
            if (!isManagerOrAdmin) {
                try {
                    // Determine recipient: task manager, fallback to user's defaultManager
                    let recipientId = task.managerId || null;
                    if (!recipientId || recipientId === currentUser.uid) {
                        recipientId = userData?.defaultManager || null;
                    }
                    if (recipientId && recipientId !== currentUser.uid) {
                        await addDoc(collection(db, 'request_notifications'), {
                            recipientId,
                            type: 'task_completion',
                            taskId: task.id,
                            taskTitle: task.title || 'Užduotis',
                            actualTime: formattedTime,
                            actualMinutes: totalMinutes,
                            userName: currentUser.displayName || currentUser.email || 'Vykdytojas',
                            userId: currentUser.uid,
                            completedAt: now.toISOString(),
                            isRead: false,
                            createdAt: new Date().toISOString()
                        });
                    }
                } catch (notifErr) {
                    console.error('Failed to send task completion notification:', notifErr);
                }
            }

            console.log(`Task ${task.id} finished and archived`);
            setConfirmFinish(false);

            // C1 — celebrate the completion moment. Until now finishing produced only a silent
            // card flash; the prime recognition beat deserves a warm, brief confirmation. The
            // chime self-guards on user activation (the Finish tap satisfies it). Fanfare is
            // reserved for the worker's OWN accomplishment; a manager closing someone else's
            // task gets a plain confirmation, no celebration.
            if (task.assignedUserId === currentUser.uid) {
                showToast('Užduotis užbaigta.', { title: 'Puikus darbas!', tone: 'success' });
                try { SoundManager.playQuickTaskSound(); } catch { /* audio is best-effort */ }
            } else {
                showToast('Užduotis užbaigta.', { tone: 'success' });
            }
        } catch (err) {
            console.error("Error finishing task:", err);
            // Surface the failure inside the dialog (never raw err.message, never window.alert).
            setFinishError('Nepavyko užbaigti užduoties. Bandykite dar kartą.');
        } finally {
            setFinishing(false);
        }
    };

    // If task is completed/confirmed, show the final total time instead of hiding
    if (task.status === 'completed' || task.status === 'confirmed' || task.status === 'unapproved') {
        const totalMinutes = calculateCurrentTotalMinutes(task);
        return (
            <div className="mt-3 border-t pt-2 flex items-center justify-between">
                <span className="text-caption font-semibold text-ink-muted">Praleistas laikas:</span>
                <span className="text-body font-bold text-ink-strong flex items-center gap-1">
                    <Clock className="w-4 h-4" />
                    {formatMinutesToTimeString(totalMinutes)}
                </span>
            </div>
        );
    }

    const currentTotalMinutes = calculateCurrentTotalMinutes(task);
    const estMinutes = parseTimeStringToMinutes(task.estimatedTime || '0');
    // If estimated time is > 0 and we've reached it, the limit is exceeded.
    // This perfectly encapsulates normal limits, time extensions, and time deductions.
    const isLimitExceeded = estMinutes > 0 && currentTotalMinutes >= estMinutes;

    return (
        <>
            <div className="mt-3 flex items-center gap-2 border-t pt-3">
                {/* Primary control: Pradėti / Tęsti / Pauzė — always the dominant action (2x width). */}
                {isRunning ? (
                    <Button
                        variant="secondary"
                        icon={Pause}
                        onClick={handlePause}
                        disabled={isSecondarySessionActive}
                        className="flex-[2] whitespace-nowrap"
                    >
                        Pauzė {elapsedString}
                    </Button>
                ) : isLimitExceeded ? (
                    /* Start removed once the time limit is exceeded (occupies the primary slot). */
                    <div
                        role="status"
                        className="flex min-h-touch flex-[2] items-center justify-center gap-1.5 rounded-control border border-feedback-danger/20 bg-feedback-danger/10 px-2 text-body font-semibold text-feedback-danger"
                    >
                        <Clock className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                        Laikas išnaudotas
                    </div>
                ) : (
                    <Button
                        variant="primary"
                        icon={Play}
                        onClick={isPaused ? handleResume : handleStart}
                        disabled={isSecondarySessionActive}
                        title={isSecondarySessionActive ? getInterruptionReason(activeSessionType) : undefined}
                        className="flex-[2] whitespace-nowrap"
                    >
                        {isPaused ? 'Tęsti' : 'Pradėti'} {elapsedString !== '00:00' ? elapsedString : ''}
                    </Button>
                )}

                {/* Užbaigti — the irreversible action: deliberately quieter and narrower than the
                    primary control, and gated by a confirm dialog (DESIGN_SYSTEM §8). */}
                <Button
                    variant="secondary"
                    icon={Square}
                    onClick={openFinish}
                    disabled={isSecondarySessionActive}
                    title={isSecondarySessionActive ? getInterruptionReason(activeSessionType) : undefined}
                    className="flex-1 whitespace-nowrap text-ink-muted"
                >
                    Užbaigti
                </Button>
            </div>

            {actionError && (
                <div
                    role="alert"
                    aria-live="assertive"
                    className="mt-2 text-caption font-medium text-feedback-danger wz-shake"
                >
                    {actionError}
                </div>
            )}

            {confirmFinish && (
                <ConfirmDialog
                    open
                    title="Užbaigti užduotį?"
                    message="Užduotis bus pažymėta kaip užbaigta ir bus užfiksuotas sugaištas laikas."
                    warning={finishError || 'Šio veiksmo nebus galima atšaukti.'}
                    confirmLabel="Užbaigti"
                    cancelLabel="Atšaukti"
                    variant="danger"
                    loading={finishing}
                    onConfirm={performFinish}
                    onCancel={() => setConfirmFinish(false)}
                />
            )}
        </>
    );
}
