import { useState, useEffect, useRef, useCallback } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import {
    calculateCurrentTotalMinutes,
    formatMinutesToTimeString,
    parseTimeStringToMinutes,
} from '../utils/timeUtils';
import { pauseTask, requestTimeExtension, completeTaskAtLimit } from '../utils/taskActions';
import { SoundManager } from '../utils/soundUtils';
import { useAuth } from '../context/AuthContext';
import { APP_LOAD_TIME } from './useOrphanedTaskRecovery';
import { useRevisionedTimerSession } from './useRevisionedTimerSession';
import { issueTimerCommand } from '../utils/timerCommandEngine';
import { canonicalSessionState, planTaskEnd, planTaskPause } from '../utils/timerTransitionPlan';
import { logError } from '../utils/errorLog';
import { notify } from '../utils/notify';

const idFor = (prefix) => {
    const random = globalThis.crypto?.randomUUID?.()
        || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${random}`;
};

export function latestTaskForLimitAction(tasks, popupTask) {
    if (!popupTask?.id) return popupTask || null;
    return tasks?.find((task) => task.id === popupTask.id) || popupTask;
}

// True when `task`'s running stretch predates this app load — i.e. it is a pre-boot orphan that
// useOrphanedTaskRecovery (mirroring the same APP_LOAD_TIME instant) will also visit on this same
// mount. Exported — not inlined in checkTime — so this decision is unit-testable without a React
// renderer (mirrors decideOrphanTaskRecovery in useOrphanedTaskRecovery.js).
//
// Why the monitor must yield rather than race it: on mount, this hook's effect runs BEFORE
// useOrphanedTaskRecovery's (hook order in WorkerView.jsx), and its immediate checkTime() has no
// heartbeat awareness — an unconditional pauseTask(task) here credits [timerStartedAt → now],
// clamped to MAX_SESSION_MINUTES, as one ordinary session, silently swallowing the whole dead
// offline gap with no "Nedirbau" opt-out. Recovery knows the last heartbeat and always processes
// the same task (same `tasks` array), so skipping the 100% auto-pause for a pre-boot orphan just
// leaves it to recovery's better-informed pause (or resume). Once recovery acts, the task is either
// no longer running or carries a fresh post-boot timerStartedAt, and this function returns false —
// so a task that is STILL over its limit after that is a genuinely live overrun, handled normally.
export function isPreBootOrphanTask(task, appLoadTime = APP_LOAD_TIME) {
    const startedAtMs = new Date(task?.timerStartedAt).getTime();
    return Number.isFinite(startedAtMs) && startedAtMs < appLoadTime;
}

// Does this task still OWE its worker the 100% decision, now that recovery has settled it?
//
// The gate in checkTime only ever evaluates a RUNNING task, and on a pre-boot orphan it deliberately
// stands down (isPreBootOrphanTask) so recovery can stop the run at the right instant. Recovery then
// pauses it — and a paused task is no longer an activeTask, so the gate never gets another look. The
// worker is left with a task quietly parked past its plan and no way to ask for more time: the ONLY
// worker-side entry to a time-extension request is the limit popup this returns the payload for.
// That is the hole a worker falls into after an offline overrun — exactly the case the server-side
// notifyOverEstimateTimers push now wakes them for, which would otherwise send them into a dead end.
//
// Returns the popup payload, or null when nothing is owed. Every null is a real reason to stay quiet:
// still running (recovery re-anchored it — the gate re-arms itself on the fresh timerStartedAt),
// already finished, someone else's task, untimed, or — the important one — settled BACK under its
// plan: recovery credits only up to the last heartbeat, which can be well short of the elapsed time
// the gate saw while the run was still open. Pure + exported so the decision is unit-testable
// without a React renderer, mirroring isPreBootOrphanTask above.
export function limitDecisionOwedAfterRecovery(task, userId) {
    if (!task || task.timerStatus === 'running') return null;
    if (!userId || task.assignedUserId !== userId) return null;
    if (task.completed || task.status === 'completed' || task.status === 'confirmed' || task.status === 'deleted') return null;
    const estimatedMinutes = parseTimeStringToMinutes(task.estimatedTime);
    if (estimatedMinutes <= 0) return null;
    const totalMinutes = calculateCurrentTotalMinutes(task);
    if (totalMinutes < estimatedMinutes) return null;
    return { task, estimatedTime: task.estimatedTime, actualMinutes: Math.round(totalMinutes) };
}

// Undo the "your timer stopped" announcement when the stop turns out NOT to have happened.
//
// Under the revisioned engine the 100% limit block issues a pause COMMAND and then immediately
// latches the run, opens the forced popup and starts the alarm — all of which tell the worker the
// clock stopped. Issuing is not stopping: the command can still settle as rejected, or lose a
// multi-device race. The timer is then still running, and because the latch is keyed by an unchanged
// timerStartedAt it matches on every later tick, so the 100% block never fires again — the whole
// overrun accrues silently behind a popup claiming it had stopped. The legacy branch guards this
// synchronously; the canonical one cannot (offline the command is durably queued and resolves much
// later, and blocking there would be worse), so it retracts instead and lets the next 10 s tick
// retry the stop.
//
// Returns whether it retracted, so the caller logs only a genuine failure. Pure apart from the three
// effects it is asked to perform, and exported so those effects are testable without a DOM.
//
// @param {object|null} outcome - the settled command outcome; null/undefined = the settlement itself
//                                threw, which is also "the stop did not happen".
export function retractLimitPauseAnnouncement(outcome, { taskId, limitReached, setLimitPopup }) {
    // 'queued' is NOT a failure: the write is durably saved on the device and will land.
    if (outcome?.status === 'confirmed' || outcome?.status === 'queued') return false;
    limitReached.delete(taskId);
    SoundManager.stopTimeLimitRepeat();
    // Leave a popup belonging to a DIFFERENT task alone — the worker may have moved on.
    setLimitPopup((prev) => (prev?.task?.id === taskId ? null : prev));
    return true;
}

/**
 * Hook that monitors the active running task for time limit thresholds.
 * - At 70% of estimatedTime: shows warning popup + plays warning sound (FYI, task keeps running)
 * - At 100%: auto-pauses task (time STOPS), plays a repeating alarm, and shows the time-limit
 *   popup. The popup gives the worker two explicit choices — request more time from the manager
 *   (optionally with a note/photos) or finish the task (→ manager acceptance). The hook no longer
 *   auto-fires the extension request: that is now a deliberate worker action (see requestExtension).
 *
 * @param {Array} tasks - Array of task objects to monitor
 * @returns {Object} state for popups + the limit-popup action handlers
 */
export function useTaskTimeMonitor(tasks) {
    const { currentUser, userRole, userData, timerEngineEnabled } = useAuth();
    const revisionedSession = useRevisionedTimerSession(currentUser?.uid, timerEngineEnabled);

    // Popup state
    const [warningPopup, setWarningPopup] = useState(null);  // { task, remaining }
    const [limitPopup, setLimitPopup] = useState(null);       // { task, estimatedTime, actualTime }

    // Track which tasks have already triggered warnings/limits (by task id)
    const warned70Ref = useRef(new Set());
    // taskId -> the timerStartedAt we last STOPPED at. Keying the limit latch by the running
    // stretch's start (not just the task id) is what lets a RESUME after the limit re-arm the stop
    // — a fresh resume mints a new timerStartedAt, so the key no longer matches and the hard stop
    // fires again. See the 100% block.
    const limitReachedRef = useRef(new Map());
    // Track the task's estimatedTimeMinutes at the time we triggered, so extensions reset it
    const lastEstimatedRef = useRef(new Map()); // taskId -> estimatedMinutes when triggered
    // Task ids whose 100% gate we stood down on because recovery owned the stop (see the 100% block).
    // Membership is the proof that the missing popup is OURS to raise once the task settles — without
    // it, "paused and over its plan" would also match a task the worker knowingly parked days ago, and
    // they would be ambushed by a forced popup on every app open.
    const orphanYieldedRef = useRef(new Set());

    // Find the currently running task
    const activeTask = tasks?.find(t => {
        if (t.timerStatus !== 'running' || !t.estimatedTime) return false;
        // Must be assigned to current user
        if (t.assignedUserId !== currentUser?.uid) return false;
        // Must not be finished. A task can briefly be both "completed/confirmed" AND still
        // carry timerStatus:'running' (e.g. a same-day completed task left in the list); without
        // this guard the monitor would auto-pause, alarm, and fire a manager time-extension
        // request on a task the worker already closed. Mirrors the resume guard in sessionActions.
        if (t.completed || t.status === 'completed' || t.status === 'confirmed' || t.status === 'deleted') return false;
        return true;
    });

    // Keep a live reference to the active task so the interval can read fresh data each tick
    // WITHOUT being torn down and recreated on every render. `activeTask` is a brand-new
    // object on every Firestore snapshot (and every 1s parent re-render), so depending on the
    // object directly churned the 10s interval before it could ever fire — making the
    // auto-pause/alarm detection unreliable. We depend on stable primitives instead.
    const activeTaskRef = useRef(null);
    activeTaskRef.current = activeTask;
    const currentUserRef = useRef(currentUser);
    currentUserRef.current = currentUser;
    const userDataRef = useRef(userData);
    userDataRef.current = userData;
    const timerEngineEnabledRef = useRef(timerEngineEnabled);
    timerEngineEnabledRef.current = timerEngineEnabled;
    const revisionedSessionRef = useRef(revisionedSession);
    revisionedSessionRef.current = revisionedSession;

    const issueRevisionedLimitPause = async (task, issuedAt) => {
        const liveUser = currentUserRef.current;
        if (!liveUser?.uid) return false;

        const liveSession = revisionedSessionRef.current;
        if (!liveSession.loaded || liveSession.error) {
            logError(liveSession.error || new Error('Timer state is not loaded'), {
                source: 'useTaskTimeMonitor.limitPause.unavailable',
                taskId: task.id,
            });
            return false;
        }

        const plan = planTaskPause({
            task,
            userId: liveUser.uid,
            userData: userDataRef.current,
            activeRecord: liveSession.record,
            commandId: idFor('timer_limit_pause'),
            issuedAt,
            taskUpdates: { timeLimitReached: true },
        });
        const issued = await issueTimerCommand(plan);
        // Issuing is not stopping — see retractLimitPauseAnnouncement for why the announcement this
        // caller is about to make has to be undoable.
        const announcement = {
            taskId: task.id,
            limitReached: limitReachedRef.current,
            setLimitPopup,
        };
        issued.settlement.then((outcome) => {
            if (!retractLimitPauseAnnouncement(outcome, announcement)) return;
            logError(outcome.error || new Error(`Limit pause ${outcome.status}`), {
                source: 'useTaskTimeMonitor.limitPause.settlement',
                taskId: task.id,
                outcome: outcome.status,
                commandId: outcome.commandId,
            });
        }).catch((error) => {
            retractLimitPauseAnnouncement(null, announcement);
            logError(error, {
                source: 'useTaskTimeMonitor.limitPause.settlement',
                taskId: task.id,
                commandId: issued.commandId,
            });
        });
        return true;
    };

    // Check thresholds on an interval
    useEffect(() => {
        if (!activeTask) return;

        const taskId = activeTask.id;
        const estimatedMinutes = parseTimeStringToMinutes(activeTask.estimatedTime);
        if (estimatedMinutes <= 0) return;

        // If the estimated time changed (extension was granted), reset tracking for this task
        const prevEstimated = lastEstimatedRef.current.get(taskId);
        if (prevEstimated && prevEstimated !== estimatedMinutes) {
            warned70Ref.current.delete(taskId);
            limitReachedRef.current.delete(taskId);
        }
        lastEstimatedRef.current.set(taskId, estimatedMinutes);

        const checkTime = async () => {
            // Read the freshest task snapshot from the ref; bail if it changed/cleared.
            const task = activeTaskRef.current;
            if (!task || task.id !== taskId) return;

            const currentMinutes = calculateCurrentTotalMinutes(task);
            const percentage = (currentMinutes / estimatedMinutes) * 100;

            // Dynamic Unlatching: If time was manually deducted, re-arm the triggers and auto-heal the DB flags
            if (percentage < 100) {
                if (limitReachedRef.current.has(taskId)) limitReachedRef.current.delete(taskId);
                if (task.timeLimitReached) {
                    try { updateDoc(doc(db, 'tasks', taskId), { timeLimitReached: false }); } catch(e) { /* intentionally ignored */ }
                }
            }
            if (percentage < 70) {
                if (warned70Ref.current.has(taskId)) warned70Ref.current.delete(taskId);
                if (task.warningShown70) {
                    try { updateDoc(doc(db, 'tasks', taskId), { warningShown70: false }); } catch(e) { /* intentionally ignored */ }
                }
            }

            // 70% warning
            if (percentage >= 70 && percentage < 100 && !warned70Ref.current.has(taskId)) {
                // Check Firestore flag — maybe warning was already shown in a previous session
                if (!task.warningShown70) {
                    warned70Ref.current.add(taskId);
                    const remaining = Math.max(0, Math.round(estimatedMinutes - currentMinutes));
                    setWarningPopup({ task, remaining });
                    SoundManager.playTimeWarning70Sound();

                    // Mark on Firestore so it doesn't re-fire after page reload
                    try {
                        await updateDoc(doc(db, 'tasks', taskId), { warningShown70: true });
                    } catch (e) {
                        console.warn('Failed to mark 70% warning:', e);
                    }
                } else {
                    warned70Ref.current.add(taskId); // Already shown, just track locally
                }
            }

            // 100% limit — auto-pause and FORCE the decision. The latch is keyed by the running
            // stretch's timerStartedAt (not just the task id), which makes it do two jobs at once:
            //   • A RESUME after the limit mints a new timerStartedAt → the key no longer matches →
            //     the stop re-fires. So a worker can't press "Tęsti" and quietly work past the
            //     limit: every resume re-pauses and re-shows the popup until the manager grants more
            //     time (extendTaskTime clears the latch via the estimate-changed reset above).
            //   • The stale tick right after we pause (the snapshot hasn't flipped timerStatus yet)
            //     still carries the SAME timerStartedAt → it matches → no double pause / double
            //     work_sessions log. `task` here is always running (the activeTask filter requires
            //     it), so a paused limit-reached task is simply never evaluated.
            //
            // A pre-boot orphan is excluded here entirely — see isPreBootOrphanTask — and left to
            // useOrphanedTaskRecovery, which pauses it at the correct instant (or resumes it) instead
            // of this block crediting the whole dead gap as one ordinary session. Standing down is
            // only half a handover though: recovery stops the run but has no notion of the plan, so
            // the decision this gate exists to force would simply never be asked. Remember the task
            // here and pick it up once recovery settles it — see the settled-orphan effect below.
            if (percentage >= 100 && isPreBootOrphanTask(task)) {
                orphanYieldedRef.current.add(taskId);
            } else if (percentage >= 100 && limitReachedRef.current.get(taskId) !== task.timerStartedAt) {
                limitReachedRef.current.set(taskId, task.timerStartedAt);

                // 1. Auto-pause the task (stops the clock + logs the session). In the revisioned
                // engine this is the same atomic active/task/ledger command as a manual pause; in
                // legacy mode it keeps the old direct write path.
                if (timerEngineEnabledRef.current) {
                    try {
                        const issued = await issueRevisionedLimitPause(task, new Date().toISOString());
                        if (!issued) {
                            limitReachedRef.current.delete(taskId);
                            return;
                        }
                    } catch (e) {
                        limitReachedRef.current.delete(taskId);
                        logError(e, {
                            source: 'useTaskTimeMonitor.limitPause',
                            taskId,
                            code: e?.code,
                        });
                        return;
                    }
                } else {
                    try {
                        await pauseTask(task);
                    } catch (e) {
                        // Mirror the revisioned branch above: a FAILED stop must not leave the latch
                        // set. The latch is keyed by this stretch's timerStartedAt, which a failed
                        // pause leaves untouched — so every later 10s tick matched the same key and
                        // skipped the 100% block forever. The code then went on to write
                        // timeLimitReached, open the forced popup and raise the notification that
                        // literally says "Veikla sustabdyta", while timerStatus was still 'running':
                        // the clock kept accruing behind a popup claiming it had stopped, and the
                        // whole silent overrun was later credited as one stretch. Release the latch,
                        // record the failure durably (console alone left no trace), and return so the
                        // next tick retries the stop instead of latching a lie.
                        limitReachedRef.current.delete(taskId);
                        logError(e, { source: 'useTaskTimeMonitor.limitPause', taskId, code: e?.code });
                        return;
                    }

                    // 2. Mark on Firestore (idempotent — survives reload, gates the on_estimate badge).
                    try {
                        await updateDoc(doc(db, 'tasks', taskId), {
                            timeLimitReached: true,
                            updatedAt: new Date().toISOString()
                        });
                    } catch (e) {
                        console.warn('Failed to mark time limit reached:', e);
                    }
                }

                // 2. Force the decision popup — request more time OR finish (never auto-sent). Skip
                //    if one is already open for this task so a re-tick can't stack popups.
                const actualTime = Math.round(currentMinutes);
                setLimitPopup((prev) => (prev?.task?.id === taskId ? prev : {
                    task,
                    estimatedTime: task.estimatedTime,
                    actualMinutes: actualTime
                }));

                // 3. Start repeating alarm
                SoundManager.startTimeLimitRepeat();
            }
        };

        // Check immediately
        checkTime();

        // Then check every 10 seconds
        const interval = setInterval(checkTime, 10000);
        return () => clearInterval(interval);
        // Depend on stable primitives, not the activeTask object reference, so the interval
        // survives snapshot churn and only resets on a genuine task / estimate / user change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTask?.id, activeTask?.estimatedTime, currentUser?.uid]);

    // Raise the 100% decision on an orphan recovery has now stopped for us — the other half of the
    // handover the gate above starts. Runs off the tasks snapshot rather than an interval because the
    // moment it waits for IS a snapshot: recovery's pause landing.
    //
    // No alarm here, unlike the gate. The repeating alarm exists to reach a worker whose phone is
    // pocketed mid-shift; this popup only ever appears with the app open in front of them, and it is
    // usually the first thing they see after tapping the "Viršytas planuotas laikas" push.
    useEffect(() => {
        if (!Array.isArray(tasks) || !currentUser?.uid) return;
        for (const task of tasks) {
            if (!task || !orphanYieldedRef.current.has(task.id)) continue;
            // Still running = recovery re-anchored the timer (silent continuation). Leave it latched:
            // that fresh timerStartedAt makes it a normal live overrun the gate above re-arms on, and
            // if that gate stops it first, the popup is already open and the setter below defers.
            if (task.timerStatus === 'running') continue;
            orphanYieldedRef.current.delete(task.id); // asked at most once per app session
            const owed = limitDecisionOwedAfterRecovery(task, currentUser.uid);
            if (!owed) continue;
            setLimitPopup((prev) => prev || owed);

            // Stamp the same flag the live gate writes when it stops a task at 100%. It is not
            // cosmetic: onTaskFinishedBadge reads `after.timeLimitReached` on the completion edge to
            // decide whether the task blew its estimate, so an overrun that happened offline — where
            // the gate stood down and recovery, which knows nothing about plans, did the stop — was
            // still earning the "Telpa į planą" badge. This write is deliberately its OWN update,
            // issued now rather than folded into the later completion: the trigger reads the flag ON
            // that edge, so a flag set in the same batch that flips `completed` would be invisible to
            // it (see planTaskEnd's identical constraint). Fire-and-forget for the same reason the
            // gate's is — a task correctly stopped must not be held up by a bookkeeping write.
            updateDoc(doc(db, 'tasks', task.id), {
                timeLimitReached: true,
                updatedAt: new Date().toISOString(),
            }).catch((e) => logError(e, {
                source: 'useTaskTimeMonitor.recoveredOverrun.markLimit',
                taskId: task.id,
                code: e?.code,
            }));
        }
    }, [tasks, currentUser?.uid]);

    // Dismiss handler (warning popup only — the limit popup is forced and closes via its actions).
    const dismissWarning = useCallback(() => {
        setWarningPopup(null);
    }, []);

    // Worker chose "request more time" in the limit popup. Sends the manager an extension request
    // carrying an optional note + photos, then silences the alarm and closes the popup. The task
    // stays paused; the manager granting re-arms the monitor (extendTaskTime clears the latch).
    const requestExtension = useCallback(async ({ commentText, attachmentUrls } = {}) => {
        if (!limitPopup?.task) return;
        await requestTimeExtension({
            task: limitPopup.task,
            currentUser,
            estimatedTime: limitPopup.estimatedTime,
            actualMinutes: limitPopup.actualMinutes,
            commentText,
            attachmentUrls
        });
        SoundManager.stopTimeLimitRepeat();
        setLimitPopup(null);
    }, [limitPopup, currentUser]);

    // Worker chose "finish work" in the limit popup. The timer is already paused, so this only
    // writes the completion fields (→ manager acceptance for a worker) and closes the popup.
    const finishFromLimit = useCallback(async () => {
        if (!limitPopup?.task) return;
        const finishedTask = latestTaskForLimitAction(tasks, limitPopup.task);
        if (timerEngineEnabled) {
            if (!currentUser?.uid) throw new Error('Missing timer user');
            if (!revisionedSession.loaded || revisionedSession.error) {
                throw Object.assign(new Error('Timer state is unavailable'), {
                    code: 'timer/unavailable',
                });
            }

            const base = canonicalSessionState(revisionedSession.record, {
                ...userData,
                id: currentUser.uid,
            });
            if (base.status !== 'active' && finishedTask.timerStatus === 'running') {
                throw Object.assign(new Error('Timer projection is still syncing'), {
                    code: 'timer/syncing',
                });
            }

            const issuedAt = new Date().toISOString();
            const finishStatus = userRole === 'admin' ? 'confirmed' : 'completed';
            const plan = planTaskEnd({
                task: finishedTask,
                userId: currentUser.uid,
                userData,
                activeRecord: revisionedSession.record,
                commandId: idFor('timer_limit_finish'),
                issuedAt,
                completionStatus: finishStatus,
                confirmedBy: finishStatus === 'confirmed' ? currentUser.uid : null,
            });
            const issued = await issueTimerCommand(plan);
            SoundManager.stopTimeLimitRepeat();
            setLimitPopup(null);

            issued.settlement.then(async (outcome) => {
                if (outcome.status !== 'confirmed') {
                    logError(outcome.error || new Error(`Limit finish ${outcome.status}`), {
                        source: 'useTaskTimeMonitor.limitFinish.settlement',
                        taskId: finishedTask.id,
                        outcome: outcome.status,
                        commandId: outcome.commandId,
                    });
                    return;
                }

                if (finishStatus !== 'confirmed') {
                    let recipientId = finishedTask.managerId || null;
                    if (!recipientId || recipientId === currentUser.uid) {
                        recipientId = userData?.defaultManager || null;
                    }
                    if (recipientId && recipientId !== currentUser.uid) {
                        await notify({
                            recipientId,
                            type: 'task_completion',
                            taskId: finishedTask.id,
                            taskTitle: finishedTask.title || 'Užduotis',
                            actualTime: formatMinutesToTimeString(plan.totalMinutes),
                            actualMinutes: plan.totalMinutes,
                            userName: currentUser.displayName || currentUser.email || 'Meistras',
                            userId: currentUser.uid,
                            completedAt: issuedAt,
                        });
                    }
                }
            }).catch((error) => {
                logError(error, {
                    source: 'useTaskTimeMonitor.limitFinish.notify',
                    taskId: finishedTask.id,
                });
            });

            if (finishedTask.assignedUserId === currentUser?.uid) {
                window.dispatchEvent(new CustomEvent('request-completion-photo', {
                    detail: {
                        task: finishedTask,
                        totalMinutes: plan.totalMinutes,
                        showEarnings: false,
                    }
                }));
            }
            return { isManagerOrAdmin: finishStatus === 'confirmed', commandId: issued.commandId };
        }
        const result = await completeTaskAtLimit(finishedTask, { currentUser, userData, userRole });
        SoundManager.stopTimeLimitRepeat();
        setLimitPopup(null);
        // Same post-finish nudge as the timer's "Užbaigti": invite a work-end proof photo. No
        // earnings chained here — the limit-popup finish never showed earnings. WorkerView listens.
        if (finishedTask.assignedUserId === currentUser?.uid) {
            window.dispatchEvent(new CustomEvent('request-completion-photo', {
                detail: { task: finishedTask, showEarnings: false }
            }));
        }
        return result;
    }, [limitPopup, tasks, timerEngineEnabled, currentUser, userData, userRole, revisionedSession]);

    return {
        warningPopup,
        limitPopup,
        dismissWarning,
        requestExtension,
        finishFromLimit
    };
}
