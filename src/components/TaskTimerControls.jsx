import { useState, useEffect, useRef } from 'react';
import { Play, Pause, Square, Clock, CheckCircle2, RefreshCw, AlertTriangle, WifiOff } from 'lucide-react';
import { doc, updateDoc, setDoc, getDoc, getDocFromCache } from 'firebase/firestore';
import { db } from '../firebase';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString, parseTimeStringToMinutes, getLithuanianNow, getLithuanianDateString, clampSessionMinutes } from '../utils/timeUtils';
import { startTask, pauseTask, resumeTask, taskSessionDocId } from '../utils/taskActions';
import { resolveCompletionStatus } from '../utils/formatters';
import { hasPayRate } from '../utils/payRate';
import { logError } from '../utils/errorLog';
import { notify } from '../utils/notify';
import { reopenTask, humanActor, MODES } from '../domain';
import { SoundManager } from '../utils/soundUtils';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useActiveSessionStatus, getInterruptionReason } from '../hooks/useActiveSessionStatus';
import { useRevisionedTimerSession } from '../hooks/useRevisionedTimerSession';
import { issueTimerCommand } from '../utils/timerCommandEngine';
import {
    canonicalSessionState,
    planTaskEnd,
    planTaskPause,
    planTaskStart,
} from '../utils/timerTransitionPlan';
import {
    COMMIT_CONFIRM_TIMEOUT_MS,
    FINISH_UNDO_WINDOW_MS,
    classifyCommit,
    commitNeedsRevert,
    checklistFinishWarning,
    canUndoOwnFinish,
} from './taskTimerSafety';
import Button from './ui/Button';
import ConfirmDialog from './ui/ConfirmDialog';

// stopBreak/stopCall no longer needed — startTask/resumeTask handle session cleanup

// `role` is the SURFACE's effective role, still passed by every list that renders this component.
// It no longer gates the controls (assignment does — see below), so it is accepted and ignored.
export default function TaskTimerControls({ task, onShowModal: _onShowModal, role: _role }) {
    const {
        currentUser,
        userRole,
        userData,
        setPendingSessionProjection,
        timerEngineEnabled,
    } = useAuth();
    const { showToast } = useToast();
    const { isSecondarySessionActive, activeSessionType } = useActiveSessionStatus();
    const revisionedSession = useRevisionedTimerSession(currentUser?.uid, timerEngineEnabled);
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
    const [commandOutcome, setCommandOutcome] = useState(null);

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

    // Only the person the task is ASSIGNED to may control its timer. That single check already
    // covers the team view: a manager browsing someone else's task fails isAssignedToMe and gets
    // no controls. The old extra `isManagerRole(role)` clause was therefore redundant for other
    // people's tasks and actively wrong for the manager's OWN — a manager who self-assigns work
    // saw no "Pradėti" on the surface where they just created it (every ManagerView list passes
    // role="manager"), so their timer was startable only after switching to "Mano darbai". That
    // silently cost real worked time, so the gate is now assignment-only.
    if (!isAssignedToMe) return null;

    /**
     * Issue a legacy timer write without keeping the action guard locked until Firestore receives
     * remote acknowledgement. The promise settles later; offline and slow-link actions return as
     * queued so the worker can immediately issue the matching stop action.
     *
     * @param {() => Promise<void>} attempt          fires the optimistic flip + the awaited write
     * @param {string} offlineMessage                success copy shown when the write is offline-queued
     * @param {string} failureMessage                alert copy shown when the write fails / can't be confirmed
     */
    const runConfirmedTimerWrite = async (attempt, offlineMessage, failureMessage) => {
        const wasOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
        let errored = false;
        let drained = false;
        let settlement;
        try {
            settlement = Promise.resolve(attempt());
        } catch (err) {
            errored = true;
            console.error('Timer write failed:', err);
        }

        if (!errored && wasOffline) {
            settlement.catch((err) => {
                console.error('Queued timer write failed:', err);
                setPendingSessionProjection(null);
                setActionError(failureMessage);
            });
        } else if (!errored) {
            await Promise.race([
                settlement.then(
                    () => { drained = true; },
                    (err) => {
                        errored = true;
                        console.error('Timer write failed:', err);
                    }
                ),
                new Promise((resolve) => setTimeout(resolve, COMMIT_CONFIRM_TIMEOUT_MS)),
            ]);

            if (!drained && !errored) {
                settlement.catch((err) => {
                    console.error('Queued timer write failed:', err);
                    setPendingSessionProjection(null);
                    setActionError(failureMessage);
                });
            }
        }

        const outcome = classifyCommit({ errored, wasOffline, drained });

        if (commitNeedsRevert(outcome)) {
            // Roll the optimistic profile back to the real (server) state and warn — no longer
            // silently swallowed when we merely think we are online.
            setPendingSessionProjection(null);
            setActionError(failureMessage);
            return false;
        }

        if (outcome === 'queued') {
            showToast(offlineMessage, { tone: 'info', duration: 4000 });
        }
        return true;
    };

    const idFor = (prefix) => {
        const random = globalThis.crypto?.randomUUID?.()
            || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        return `${prefix}_${random}`;
    };

    const trackRevisionedOutcome = async (plan, offlineMessage) => {
        const issued = await issueTimerCommand(plan);
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        setCommandOutcome({
            status: 'queued',
            message: offline ? offlineMessage : 'Sinchronizuojama…',
        });
        if (offline) {
            showToast(offlineMessage, { tone: 'info', duration: 4000 });
        }

        issued.settlement.then((outcome) => {
            if (outcome.status === 'confirmed') {
                setCommandOutcome({
                    status: 'confirmed',
                    message: 'Sinchronizuota.',
                });
                setTimeout(() => {
                    setCommandOutcome((current) => (
                        current?.status === 'confirmed' ? null : current
                    ));
                }, 2500);
            } else if (outcome.status === 'conflicted') {
                setCommandOutcome({
                    status: 'conflicted',
                    message: 'Būsena pakeista kitame įrenginyje. Parodyta naujausia sesija.',
                });
            } else if (outcome.status === 'rejected') {
                setCommandOutcome({
                    status: 'rejected',
                    message: 'Veiksmas nepriimtas. Bandykite dar kartą.',
                });
            }
        });
        return issued;
    };

    const previousTaskFor = async (base) => {
        if (base.status !== 'active' || base.run?.type !== 'task' || base.run.taskId === task.id) {
            return null;
        }
        const ref = doc(db, 'tasks', base.run.taskId);
        let snapshot;
        try {
            snapshot = await getDocFromCache(ref);
        } catch {
            snapshot = await getDoc(ref);
        }
        if (!snapshot.exists()) {
            throw new Error('The active task is unavailable');
        }
        return { id: snapshot.id, ...snapshot.data() };
    };

    const runRevisionedStart = async () => {
        if (!revisionedSession.loaded || revisionedSession.error) {
            setActionError('Laikmačio būsena dar nepasiekiama. Bandykite dar kartą.');
            return false;
        }
        const base = canonicalSessionState(revisionedSession.record, {
            ...userData,
            id: currentUser.uid,
        });
        const previousTask = await previousTaskFor(base);
        const plan = planTaskStart({
            task,
            userId: currentUser.uid,
            userData,
            activeRecord: revisionedSession.record,
            previousTask,
            commandId: idFor('timer_cmd'),
            runId: idFor('timer_run'),
            issuedAt: new Date().toISOString(),
        });
        return trackRevisionedOutcome(
            plan,
            task.timerStatus === 'paused'
                ? 'Tęsiama. Išsaugota šiame telefone.'
                : 'Pradėta. Išsaugota šiame telefone.'
        );
    };

    const runRevisionedPause = async () => {
        if (!revisionedSession.loaded || revisionedSession.error) {
            setActionError('Laikmačio būsena dar nepasiekiama. Bandykite dar kartą.');
            return false;
        }
        const plan = planTaskPause({
            task,
            userId: currentUser.uid,
            userData,
            activeRecord: revisionedSession.record,
            commandId: idFor('timer_cmd'),
            issuedAt: new Date().toISOString(),
        });
        return trackRevisionedOutcome(plan, 'Sustabdyta. Išsaugota šiame telefone.');
    };

    const reportRevisionedError = (error, source) => {
        logError(error, { source, taskId: task.id, code: error?.code });
        if (error?.code === 'timer/conflict' || error?.code === 'timer/already-running') {
            setActionError('Sesija jau pakeista. Parodyta naujausia būsena.');
        } else if (error?.code === 'timer/missing-active-task') {
            setActionError('Nepavyko įkelti aktyvios užduoties. Prisijunkite prie interneto ir bandykite dar kartą.');
        } else if (error?.message === 'Persistent timer storage is unavailable') {
            setActionError('Šiame telefone nepavyko saugiai išsaugoti veiksmo. Atlaisvinkite naršyklės saugyklą.');
        } else {
            setActionError('Nepavyko pakeisti laikmačio būsenos. Bandykite dar kartą.');
        }
    };

    const handleStart = async (e) => {
        e.stopPropagation();
        if (isSecondarySessionActive) return;
        if (actionInFlightRef.current) return;
        actionInFlightRef.current = true;
        setActionError('');
        try {
            if (!currentUser) return;
            if (timerEngineEnabled) {
                await runRevisionedStart();
                return;
            }
            // A genuinely-active quick work already disables this control (isSecondarySessionActive,
            // checked above). If only the LEGACY quickWorkState.isQuickWorking flag lingers (stale,
            // with activeSession not representing quick work), we must NOT block the start: startTask
            // clears that flag itself, so proceeding HEALS the corrupted state. The old code instead
            // dispatched a 'stop-quick-work' event that nothing listens for and returned early,
            // silently no-opping the tap — a dead trap. Removed.

            await runConfirmedTimerWrite(
                async () => {
                    // Optimistic UI Update: Instantly assume task started and clear other sessions
                    setPendingSessionProjection({
                        activeSession: { type: 'task', startTime: new Date().toISOString(), taskId: task.id },
                        workStatus: { isWorking: true, status: 'running', activeTaskId: task.id },
                        breakState: { ...userData?.breakState, isTakingBreak: false },
                        callState: { ...userData?.callState, isCalling: false },
                        quickWorkState: { ...userData?.quickWorkState, isQuickWorking: false }
                    });
                    // Start task directly — startTask handles pausing other tasks
                    // and updating the activeSession. No need to stop break/call separately.
                    await startTask(task, currentUser.uid);
                },
                'Pradėta. Išsaugota telefone — sinchronizuosime, kai bus ryšys.',
                'Nepavyko pradėti laikmačio. Bandykite dar kartą.'
            );
        } catch (error) {
            if (timerEngineEnabled) {
                reportRevisionedError(error, 'TaskTimerControls.revisionedStart');
            } else {
                throw error;
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
            if (timerEngineEnabled) {
                await runRevisionedPause();
                return;
            }
            await runConfirmedTimerWrite(
                async () => {
                    // Optimistic UI: instantly show paused state
                    setPendingSessionProjection({
                        activeSession: null,
                        workStatus: { isWorking: false, status: 'paused', activeTaskId: task.id }
                    });
                    await pauseTask(task);
                },
                'Sustabdyta. Išsaugota telefone — sinchronizuosime, kai bus ryšys.',
                'Nepavyko sustabdyti laikmačio. Bandykite dar kartą.'
            );
        } catch (error) {
            if (timerEngineEnabled) {
                reportRevisionedError(error, 'TaskTimerControls.revisionedPause');
            } else {
                throw error;
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
            if (!currentUser) return;
            if (timerEngineEnabled) {
                await runRevisionedStart();
                return;
            }
            // See handleStart: a stale legacy quickWorkState.isQuickWorking flag must not block the
            // resume. resumeTask clears it, so proceeding heals the corrupted state; the old
            // dead-event dispatch (no listener) only no-opped the tap. Removed.

            await runConfirmedTimerWrite(
                async () => {
                    // Optimistic UI Update: Instantly assume task resumed and clear other sessions
                    setPendingSessionProjection({
                        activeSession: { type: 'task', startTime: new Date().toISOString(), taskId: task.id },
                        workStatus: { isWorking: true, status: 'running', activeTaskId: task.id },
                        breakState: { ...userData?.breakState, isTakingBreak: false },
                        callState: { ...userData?.callState, isCalling: false }
                    });
                    // Resume task directly — resumeTask handles pausing other tasks
                    // and updating the activeSession. No need to stop break/call separately.
                    await resumeTask(task, currentUser.uid);
                },
                'Tęsiama. Išsaugota telefone — sinchronizuosime, kai bus ryšys.',
                'Nepavyko atnaujinti laikmačio. Bandykite dar kartą.'
            );
        } catch (error) {
            if (timerEngineEnabled) {
                reportRevisionedError(error, 'TaskTimerControls.revisionedResume');
            } else {
                throw error;
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

    /**
     * Undo a just-finished task within the grace window: re-arm it to 'paused', clear every
     * completion field (via the audited reopenTask command — one decision_log entry), and VOID the
     * segment this finish logged so the time is not double-counted. We snapshot exactly what the
     * finish wrote — the segment minutes and the work_sessions doc reference — and reverse only that:
     *   - the task's timerMinutes are rolled back to their pre-finish value,
     *   - the logged work_sessions row is soft-deleted (isDeleted:true), which every aggregator drops.
     * No new collection is introduced. Worker-own-task only.
     */
    const undoFinish = async ({ preFinishTimerMinutes, sessionDocRef }) => {
        if (!canUndoOwnFinish(task, currentUser?.uid)) return;
        try {
            // Reopen with the segment removed: reopenTask re-arms timerStatus to 'paused' when
            // minutes remain (else null). We pass a task carrying the rolled-back minutes so the
            // re-armed task does NOT include the voided segment.
            await reopenTask(
                { task: { ...task, timerMinutes: preFinishTimerMinutes, manualMinutes: task.manualMinutes || 0 } },
                { actor: humanActor(currentUser), mode: MODES.COMMIT, reason: 'undo finish within grace window' }
            );

            // Persist the rolled-back minutes on the task (reopenTask resets lifecycle fields but
            // does not touch timer minutes), and void the logged segment so totals stay honest.
            const writes = [
                updateDoc(doc(db, 'tasks', task.id), {
                    timerMinutes: preFinishTimerMinutes,
                    timerStartedAt: null,
                    actualTime: formatMinutesToTimeString(preFinishTimerMinutes + (task.manualMinutes || 0)),
                    updatedAt: new Date().toISOString()
                })
            ];
            if (sessionDocRef) {
                writes.push(
                    updateDoc(sessionDocRef, { isDeleted: true, deletedAt: new Date().toISOString() })
                        .catch(voidErr => logError(voidErr, { source: 'writeFail:undoFinish.voidSession' }))
                );
            }
            await Promise.all(writes);

            showToast('Užbaigimas atšauktas. Užduotis vėl aktyvi.', { tone: 'info', duration: 5000 });
        } catch (err) {
            console.error('Error undoing finish:', err);
            logError(err, { source: 'undoFinish' });
            showToast('Nepavyko atšaukti užbaigimo. Bandykite dar kartą.', { tone: 'warning', duration: 6000 });
        }
    };

    const performRevisionedFinish = async () => {
        if (!revisionedSession.loaded || revisionedSession.error) {
            throw Object.assign(new Error('Timer state is unavailable'), {
                code: 'timer/unavailable',
            });
        }

        const now = getLithuanianNow();
        // A worker-owned finish always lands in the manager approval queue. Admins may self-confirm;
        // other manager roles can own tasks they do not oversee, so optimistic auto-confirm would
        // make the entire atomic batch fail its approval-field rule.
        const finishStatus = userRole === 'admin' ? 'confirmed' : 'completed';
        const plan = planTaskEnd({
            task,
            userId: currentUser.uid,
            userData,
            activeRecord: revisionedSession.record,
            commandId: idFor('timer_cmd'),
            issuedAt: now.toISOString(),
            completionStatus: finishStatus,
            confirmedBy: finishStatus === 'confirmed' ? currentUser.uid : null,
        });
        const preFinishTimerMinutes = Number(task.timerMinutes || 0);
        const sessionDocRef = plan.closedSessionId
            ? doc(db, 'work_sessions', plan.closedSessionId)
            : null;
        const issued = await trackRevisionedOutcome(
            plan,
            'Užbaigta. Išsaugota šiame telefone.'
        );

        setConfirmFinish(false);
        issued.settlement.then(async (outcome) => {
            if (outcome.status !== 'confirmed') return;

            if (finishStatus !== 'confirmed') {
                try {
                    let recipientId = task.managerId || null;
                    if (!recipientId || recipientId === currentUser.uid) {
                        recipientId = userData?.defaultManager || null;
                    }
                    if (recipientId && recipientId !== currentUser.uid) {
                        await notify({
                            recipientId,
                            type: 'task_completion',
                            taskId: task.id,
                            taskTitle: task.title || 'Užduotis',
                            actualTime: formatMinutesToTimeString(plan.totalMinutes),
                            actualMinutes: plan.totalMinutes,
                            userName: currentUser.displayName || currentUser.email || 'Meistras',
                            userId: currentUser.uid,
                            completedAt: now.toISOString(),
                        });
                    }
                } catch (notifErr) {
                    console.error('Failed to send task completion notification:', notifErr);
                }
            }

            showToast('Užduotis užbaigta. Galite atšaukti.', {
                title: 'Puiki veikla!',
                tone: 'success',
                duration: FINISH_UNDO_WINDOW_MS,
                onClick: () => undoFinish({ preFinishTimerMinutes, sessionDocRef }),
            });
            try { SoundManager.playQuickTaskSound(); } catch { /* audio is best-effort */ }
            window.dispatchEvent(new CustomEvent('request-completion-photo', {
                detail: {
                    task,
                    totalMinutes: plan.totalMinutes,
                    showEarnings: hasPayRate(userData?.payRate),
                },
            }));
        });
    };

    const performFinish = async () => {
        setFinishing(true);
        try {
            if (timerEngineEnabled) {
                await performRevisionedFinish();
                return;
            }
            let finalTimerMinutes = task.timerMinutes || 0;
            // The task's pre-finish credited minutes — the rollback target if the worker undoes.
            const preFinishTimerMinutes = task.timerMinutes || 0;
            let currentManualMinutes = task.manualMinutes || 0;
            const start = task.timerStartedAt ? new Date(task.timerStartedAt) : null;
            const now = getLithuanianNow();

            // 1. If running, calculate elapsed (clamped like the pause path, so finishing
            // a task whose timer was orphaned across a crash cannot credit ghost hours).
            if (isRunning && start) {
                finalTimerMinutes += clampSessionMinutes((now - start) / (1000 * 60));
            }

            // 2. Prepare task data for completion.
            // Auto-confirm follows the actor's manager ROLE only — the same shared rule the audited
            // completeTask command uses (resolveCompletionStatus), so the two finish doors never
            // drift. A worker — even one named as the task's managerId — cannot self-confirm under
            // firestore.rules (changesApprovalFields), so their finish lands 'completed' and waits for
            // a real manager's priėmimas; writing 'confirmed' here only produced a silent
            // permission-denied that failed the whole finish.
            let finishStatus = resolveCompletionStatus(userRole);
            let isConfirmed = finishStatus === 'confirmed';
            const totalMinutes = finalTimerMinutes + currentManualMinutes;
            const formattedTime = formatMinutesToTimeString(totalMinutes);

            // Write ONLY the completion fields as a targeted merge — never spread the whole task
            // snapshot back. The worker's local copy can be stale: a manager may have edited the
            // estimate / checklist / description, or the admin-SDK re-stamp trigger may have changed
            // the denormalized teamManagerIds, while this worker was offline. Re-writing `...task`
            // silently reverted those server-side edits (audit: legacy-finish clobber) and — once
            // teamManagerIds is pinned immutable on the /tasks update rule — would get the finish
            // rejected outright for carrying a stale value. updateDoc merges, so every field we do
            // NOT list keeps its current server value.
            const taskData = {
                timerStatus: 'paused',
                timerStartedAt: null,
                timerMinutes: finalTimerMinutes,
                manualMinutes: currentManualMinutes,
                actualTime: formattedTime,
                status: finishStatus,
                completed: true,
                completedAt: now.toISOString(),
                confirmedBy: isConfirmed ? currentUser.uid : null,
                confirmedAt: isConfirmed ? now.toISOString() : null,
                updatedAt: now.toISOString()
            };

            // Holds the work_sessions doc this finish logs, so an undo can void exactly that row.
            let sessionDocRef = null;

            // 3. Run task update + user status update in PARALLEL, work session log fire-and-forget
            if (isRunning && start) {
                const elapsedMinutes = clampSessionMinutes((now - start) / (1000 * 60));
                if (elapsedMinutes > 0.1) {
                    // Fire and forget work session log
                    // Attribute to the end date (now), consistent with the other
                    // work_sessions writers - start-based mis-bucketed midnight-spanning work.
                    const sessionDate = getLithuanianDateString(now);
                    // Deterministic id — the SAME key pauseTask mints for this running stretch, so
                    // a finish racing the time-limit monitor's (or recovery's) pause of the same
                    // run converges on one row instead of logging the interval twice. The ref is
                    // known synchronously, so an undo can void the row even mid-flight.
                    sessionDocRef = doc(db, 'work_sessions', taskSessionDocId(task.id, start.getTime()));
                    setDoc(sessionDocRef, {
                        taskId: task.id,
                        taskTitle: task.title || 'Nežinoma užduotis',
                        userId: task.assignedUserId,
                        userName: currentUser.displayName || currentUser.email,
                        startTime: start.toISOString(),
                        endTime: now.toISOString(),
                        durationMinutes: elapsedMinutes,
                        date: sessionDate,
                        createdAt: new Date().toISOString()
                    }, { merge: true })
                      .catch(logErr => logError(logErr, { source: 'writeFail:finishTask.workSession' }));
                }
            }

            // Write the task completion first. A manager-ROLE finish auto-confirms (status
            // 'confirmed'), but the deployed rules only let a manager flip the approval fields on a
            // task they actually OVERSEE (a whole-team viewer, the task's named vadovas/auditor, or a
            // scoped manager acting within their own team). A scoped/senior manager finishing their
            // OWN task that SOMEONE ELSE oversees therefore had its 'confirmed' write denied — and the
            // whole finish failed with "Nepavyko užbaigti". When that exact denial happens we fall
            // back to 'completed' (a write the assignee is always permitted): the task is still
            // finished, and simply waits for its proper overseer's priėmimas instead of breaking.
            try {
                await updateDoc(doc(db, 'tasks', task.id), taskData);
            } catch (writeErr) {
                if (isConfirmed && writeErr?.code === 'permission-denied') {
                    isConfirmed = false;
                    finishStatus = 'completed';
                    Object.assign(taskData, { status: 'completed', confirmedBy: null, confirmedAt: null });
                    await updateDoc(doc(db, 'tasks', task.id), taskData);
                } else {
                    throw writeErr;
                }
            }

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
                    await updateDoc(doc(db, 'users', currentUser.uid), {
                        workStatus: {
                            isWorking: false,
                            status: 'idle',
                            activeTaskId: null,
                            lastUpdated: new Date().toISOString()
                        },
                        activeSession: null
                    });
                }
            }

            // Send task_completion notification to manager (only when the task lands 'completed' and
            // still needs a real manager's priėmimas — a role-manager's own finish auto-confirms).
            if (!isConfirmed) {
                try {
                    // Determine recipient: task manager, fallback to user's defaultManager
                    let recipientId = task.managerId || null;
                    if (!recipientId || recipientId === currentUser.uid) {
                        recipientId = userData?.defaultManager || null;
                    }
                    if (recipientId && recipientId !== currentUser.uid) {
                        // Worker-authored (userId = caller); notify() stamps provenance + registry category.
                        await notify({
                            recipientId,
                            type: 'task_completion',
                            taskId: task.id,
                            taskTitle: task.title || 'Užduotis',
                            actualTime: formattedTime,
                            actualMinutes: totalMinutes,
                            userName: currentUser.displayName || currentUser.email || 'Meistras',
                            userId: currentUser.uid,
                            completedAt: now.toISOString(),
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
                // Offer a grace-window UNDO: the finish is deliberate (it passed the confirm dialog),
                // but a fat-finger / wrong-task tap deserves a quiet way back. Tapping "Atšaukti"
                // re-arms the task to paused, clears completion, and voids this finish's segment.
                showToast('Užduotis užbaigta. Galite atšaukti.', {
                    title: 'Puiki veikla!',
                    tone: 'success',
                    duration: FINISH_UNDO_WINDOW_MS,
                    onClick: () => undoFinish({ preFinishTimerMinutes, sessionDocRef })
                });
                try { SoundManager.playQuickTaskSound(); } catch { /* audio is best-effort */ }
                // Post-finish, invite a work-end proof photo (skippable) for the worker's OWN task.
                // WorkerView renders CompletionPhotoModal. The earnings popup (gross/net), shown only
                // when a pay rate is set, is CHAINED after that modal closes so the two never stack —
                // we hand the showEarnings flag + minutes along rather than firing 'task-earnings' here.
                window.dispatchEvent(new CustomEvent('request-completion-photo', {
                    detail: { task, totalMinutes, showEarnings: hasPayRate(userData?.payRate) }
                }));
            } else {
                showToast('Užduotis užbaigta.', { tone: 'success' });
            }
        } catch (err) {
            console.error("Error finishing task:", err);
            // Capture server-side so a recurring finish failure is diagnosable (the dialog only ever
            // showed a generic Lithuanian message, leaving no trace of the real Firestore error code).
            logError(err, { source: 'finishTask', taskId: task.id, code: err?.code });
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

    // Soft, non-blocking nudge for finishing with unticked checklist items. Composed UNDER the
    // existing irreversibility warning so finishing stays the deliberate, guarded action.
    const checklistWarning = checklistFinishWarning(task.checklist);
    const finishWarning = finishError
        || [checklistWarning, 'Šio veiksmo nebus galima atšaukti.'].filter(Boolean).join(' ');

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

            {commandOutcome && (
                <div
                    role={commandOutcome.status === 'rejected' || commandOutcome.status === 'conflicted'
                        ? 'alert'
                        : 'status'}
                    aria-live={commandOutcome.status === 'rejected' || commandOutcome.status === 'conflicted'
                        ? 'assertive'
                        : 'polite'}
                    className={[
                        'mt-2 flex min-h-touch items-center gap-2 rounded-control border px-3 py-2 text-caption font-medium',
                        commandOutcome.status === 'confirmed'
                            ? 'border-feedback-success-border bg-feedback-success-soft text-feedback-success-text'
                            : commandOutcome.status === 'rejected' || commandOutcome.status === 'conflicted'
                                ? 'border-feedback-danger-border bg-feedback-danger-soft text-feedback-danger-text'
                                : 'border-line bg-surface-sunken text-ink',
                    ].join(' ')}
                >
                    {commandOutcome.status === 'confirmed' ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                    ) : commandOutcome.status === 'conflicted' || commandOutcome.status === 'rejected' ? (
                        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                    ) : typeof navigator !== 'undefined' && navigator.onLine === false ? (
                        <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
                    ) : (
                        <RefreshCw className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                    )}
                    <span>{commandOutcome.message}</span>
                </div>
            )}

            {confirmFinish && (
                <ConfirmDialog
                    open
                    title="Užbaigti užduotį?"
                    message="Užduotis bus pažymėta kaip užbaigta ir bus užfiksuotas sugaištas laikas."
                    warning={finishWarning}
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
