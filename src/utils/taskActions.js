import { doc, updateDoc, collection, query, where, getDocs, getDoc, getDocFromServer, addDoc, setDoc, deleteDoc, orderBy, arrayUnion, arrayRemove } from 'firebase/firestore';
import { db } from '../firebase';
import { parseTimeStringToMinutes, formatMinutesToTimeString, getLithuanianNow, getLithuanianDateString, clampSessionMinutes, MIN_LOGGED_SESSION_MINUTES } from './timeUtils';
import { isManagerRole } from './formatters';
import { logError } from './errorLog';
import { notify, categoryOf } from './notify';
import { createTask, reopenTask, deleteTask as deleteTaskCommand, completeTask, humanActor, MODES } from '../domain';
import { withUserLock } from './sessionLock';

/**
 * Updates the user's work status in Firestore.
 */
const updateUserWorkStatus = async (userId, isWorking, status, taskId) => {
    if (!userId) return;
    try {
        await updateDoc(doc(db, 'users', userId), {
            workStatus: {
                isWorking,
                status, // 'running', 'paused', 'idle'
                activeTaskId: taskId,
                lastUpdated: new Date().toISOString()
            }
            // NOTE: activeSession is managed exclusively by sessionActions.js (startSession/endSession).
            // Previously this function also set activeSession, which caused a race condition:
            // startSession() would set activeSession to the new session (break/call/quick_work)
            // with the task stored in pausedSession, but then pauseTask() would fire and
            // overwrite activeSession to null, killing all session tracking.
        });
    } catch (err) {
        // A failed user-doc write desyncs workStatus from the task doc and is otherwise invisible
        // in production. Keep it non-fatal (no rethrow — pause/delete must not fail on this), but
        // record it durably in the ring buffer + error_logs like every other write-fail here.
        console.error("Error updating user work status:", err);
        logError(err, { source: 'taskActions.updateUserWorkStatus', userId });
    }
};

/**
 * Starts a task.
 *
 * Serialized per user via {@link withUserLock}: starting a task writes `activeSession`, and must
 * not interleave with a concurrent start/resume/secondary-session for the same worker (the shared
 * lost-update race). `pauseOtherTasks` it awaits is intentionally NOT separately locked — it runs
 * inside this critical section, which is why the lock wraps the public entry point, not the helper.
 *
 * @param {Object} task - The task to start.
 * @param {string} userId - The user ID.
 */
export const startTask = (task, userId) => withUserLock(userId, () => startTaskImpl(task, userId));

const startTaskImpl = async (task, userId) => {
    try {
        // 0. Re-validate INSIDE the lock before overwriting activeSession — the same guard
        // resumeTaskImpl carries. startTask is reachable with a STALE gate: a live break/call/
        // quick-work started on another device is not yet in this device's snapshot (so the UI's
        // isSecondarySessionActive gate passes), or Pertrauka and Pradėti are tapped in one tick.
        // Proceeding blindly overwrote activeSession and force-cleared the type flags below —
        // wiping a live secondary session whose elapsed existed ONLY in activeSession (never
        // banked, never logged). Fail CLOSED like resumeTask: an aborted start is a repeatable
        // no-op after the session ends; a wiped session is unrecoverable. Server-first with a
        // cache fallback so an offline worker still reads the latency-compensated local state.
        try {
            const snap = await getDocFromServer(doc(db, 'users', userId)).catch(() => getDoc(doc(db, 'users', userId)));
            const live = snap?.exists?.() ? snap.data()?.activeSession : null;
            if (live && live.type && live.type !== 'task' && live.startTime) {
                logError(new Error('startTask skipped: live secondary session present'), {
                    source: 'startTask:supersededByLiveSession', userId, taskId: task.id, liveType: live.type,
                });
                return;
            }
        } catch (guardErr) {
            // Fail CLOSED: unproven safety → skip the start rather than risk wiping a live session.
            logError(guardErr, { source: 'startTask:guardRead', userId, taskId: task.id });
            return;
        }

        // 1. Pause others (must complete before starting new task)
        await pauseOtherTasks(userId, task.id);

        // 1b. Bank any stretch THIS task is still running on the server before re-anchoring it —
        // pauseOtherTasks skips the current task, so nothing else covers this document.
        if (!(await closeRunningStretchOnTarget(task, userId, 'startTask'))) return;

        const now = new Date().toISOString();

        // 2. Update Task + User Status + activeSession in PARALLEL
        await Promise.all([
            updateDoc(doc(db, 'tasks', task.id), {
                timerStatus: 'running',
                timerStartedAt: now,
                // Seed the heartbeat at start so a reload seconds later already has a proof
                // anchor (orphan recovery's "no heartbeat → legacy clamp" path is then only
                // ever reached by pre-heartbeat data, never a freshly-started timer).
                timerLastHeartbeat: now,
                startedAt: task.startedAt || now,
                status: 'in-progress',
                updatedAt: now
            }),
            updateDoc(doc(db, 'users', userId), {
                workStatus: {
                    isWorking: true,
                    status: 'running',
                    activeTaskId: task.id,
                    lastUpdated: now
                },
                // Set activeSession so ActiveWorkSessions widget shows the task immediately
                activeSession: {
                    type: 'task',
                    startTime: now,
                    taskId: task.id,
                    taskTitle: task.title || 'Užduotis'
                },
                // Clear any orphaned legacy session flags to prevent UI deadlocks
                'breakState.isTakingBreak': false,
                'callState.isCalling': false,
                'quickWorkState.isQuickWorking': false
            })
        ]);

    } catch (err) {
        console.error("Error starting task:", err);
        // Record to the durable crash log before rethrowing — a failed timer start is exactly
        // the kind of session-lifecycle failure errorLog.js exists to capture, and it was
        // previously invisible there (only console.error fired).
        logError(err, { source: 'taskActions.startTask' });
        throw err;
    }
};

// Deterministic work_sessions doc id for ONE running stretch of a task timer, keyed on the run's
// start instant. Every closer of that same stretch — pauseTask (manual, monitor, recovery, or the
// manager's force-end), performFinish, and the server's autoStopForgottenTimers — mints this SAME
// id, so two independent closers converge on ONE row instead of each logging a random-id duplicate
// of the same interval (reports sum work_sessions, so a duplicate is double-paid time). The server
// copy is a hand-mirror in functions/index.js; the firebaseConsistency gate locks the prefix.
export const taskSessionDocId = (taskId, startMs) => `sess_task_${taskId}_${startMs}`;

// Task ids with a pause currently in flight. Two code paths can race to pause the
// SAME running task in one tick — e.g. the crash-recovery hook and the time-limit
// monitor both fire pauseTask on an orphaned task that is also over its limit. Both
// read the same (stale) timerStatus:'running' object, so the top guard does not
// dedupe them, and each would write a duplicate work_sessions log. This in-flight set
// makes the second concurrent call a no-op until the first settles.
const pauseInFlight = new Set();

/**
 * Pauses a task, calculating elapsed time and updating the database.
 * @param {Object} task - The task object to pause.
 * @returns {Promise<void>}
 */
export const pauseTask = async (task, { skipUserStatusUpdate = false, endTime = null } = {}) => {
    if (!task.timerStartedAt || task.timerStatus !== 'running') return null;
    if (pauseInFlight.has(task.id)) return null; // a concurrent pause for this task is already running
    pauseInFlight.add(task.id);

    try {
        // Re-confirm THIS task before crediting anything — the same staleness guard pauseOtherTasks
        // performs on every OTHER task. The caller's snapshot can be a silently stale cache copy: a
        // backgrounded second device (the time-limit monitor's activeTaskRef, a manager's table row)
        // keeps replaying `timerStatus:'running'` long after the phone already paused the task. Acting
        // on it credited [old timerStartedAt → now] onto a stale timerMinutes base, and — via the
        // deterministic taskSessionDocId — overwrote the real session row with a later endTime.
        // `getDoc` (not getDocFromServer) on purpose: its default source reads the server when online
        // and falls back to the cache when not, so a worker pausing offline in the field still works.
        // A read that fails, or a doc the read cannot see, proves NOTHING about the stretch, so we
        // keep the caller's snapshot there rather than strand a running timer; the guard exists to act
        // on positive server proof that the stretch already ended or was re-anchored elsewhere.
        let live = task;
        try {
            const snap = await getDoc(doc(db, 'tasks', task.id));
            const server = snap?.exists?.() ? { id: task.id, ...snap.data() } : null;
            if (server) {
                if (server.timerStatus !== 'running' || server.timerStartedAt !== task.timerStartedAt) {
                    return null; // already closed (or re-anchored) elsewhere — nothing of ours to credit
                }
                live = server;
            }
        } catch (guardErr) {
            logError(guardErr, { source: 'pauseTask:guardRead', taskId: task.id });
        }

        // The instant the credited stretch ENDS. Defaults to now (a normal pause), but the
        // heartbeat recovery passes the last-heartbeat instant so an abandoned timer is credited
        // only up to its last proof of life — not up to the (possibly much later) reopen.
        const endMoment = endTime != null ? new Date(endTime) : getLithuanianNow();
        const start = new Date(live.timerStartedAt);
        // Raw (unclamped) wall-clock delta, kept ONLY so the caller can tell whether the clamp
        // below actually had to cut the credited time down — that is what the crash-recovery
        // notice reports as "the 16h cap fired". It is never used as a credited or logged value.
        const rawMinutes = (endMoment - start) / (1000 * 60);
        // Sanitize the elapsed delta through the shared clamp: a future/invalid start
        // (clock skew) collapses to 0, and an implausibly large value — e.g. a timer
        // left running across a crash/reload before this pause — is capped to
        // MAX_SESSION_MINUTES so an orphaned interval cannot credit hours of ghost time.
        const elapsedMinutes = clampSessionMinutes((endMoment - start) / (1000 * 60)); // minutes, float for precision

        // A recovery-driven pause (crash/reload) always passes an explicit endTime. Its every
        // segment is PROVEN worked time (bounded start→last-heartbeat), so the sub-minute
        // MIN_LOGGED gate — which exists only to swallow an accidental start-then-immediately-stop
        // tap on a MANUAL pause — must NOT apply here. Under a rapid reload loop each surviving
        // segment can be sub-minute; dropping them silently shreds hours of real work (the reported
        // incident). For recovery we credit any positive interval; for a manual pause we keep the
        // original mis-tap guard. Either way clampSessionMinutes has already zeroed clock-skew.
        const isRecovery = endTime != null;
        const shouldCredit = isRecovery
            ? elapsedMinutes > 0
            : elapsedMinutes > MIN_LOGGED_SESSION_MINUTES;

        // 1. Get current Timer Minutes (from the CONFIRMED copy — a stale base would under- or
        // over-credit the running total the moment another device already banked a stretch).
        const currentTimerMinutes = live.timerMinutes || 0;
        const newTimerMinutes = shouldCredit
            ? currentTimerMinutes + elapsedMinutes
            : currentTimerMinutes;

        // 2. Get current Manual Minutes (backwards compat)
        const totalCurrentMinutes = parseTimeStringToMinutes(live.actualTime || '0m');
        const currentManualMinutes = live.manualMinutes !== undefined
            ? live.manualMinutes
            : Math.max(0, totalCurrentMinutes - currentTimerMinutes);

        // Run task update, user status update, and work session log in PARALLEL
        const parallelOps = [
            updateDoc(doc(db, 'tasks', task.id), {
                timerStatus: 'paused',
                timerStartedAt: null,
                timerMinutes: newTimerMinutes,
                manualMinutes: currentManualMinutes,
                updatedAt: new Date().toISOString()
            })
        ];

        // Update User Status to Paused — SKIP when called from pauseOtherTasks
        // because startTask/resumeTask will immediately overwrite this to 'running'.
        if (!skipUserStatusUpdate && live.assignedUserId) {
            // ...but only while the owner's live session STILL points at THIS task — the same guard
            // performFinish already carries. A pause issued from a second device (or the time-limit
            // monitor on a backgrounded one) can land after the worker has already started ANOTHER
            // task on their phone; blindly writing activeSession:null then WIPED that live session
            // while the other task's timer kept accruing, blanking both the screen-colour session
            // indicator and the manager's "Aktyvi veikla" panel until orphan recovery cleaned up.
            let ownsLiveSession = true;
            try {
                const userSnap = await getDoc(doc(db, 'users', live.assignedUserId));
                const activeTaskId = userSnap?.exists?.()
                    ? (userSnap.data()?.activeSession?.taskId || userSnap.data()?.workStatus?.activeTaskId)
                    : null;
                ownsLiveSession = !activeTaskId || activeTaskId === task.id;
            } catch (readErr) {
                // Unreadable user doc → keep the old behaviour (clear it), exactly as performFinish
                // falls back: a stuck "still working" banner is worse than a redundant clear.
                logError(readErr, { source: 'pauseTask:userSessionRead', taskId: task.id });
            }
            if (ownsLiveSession) {
                parallelOps.push(updateUserWorkStatus(live.assignedUserId, false, 'paused', task.id));
                // Also clear activeSession so ActiveWorkSessions stops showing user as busy
                parallelOps.push(
                    updateDoc(doc(db, 'users', live.assignedUserId), { activeSession: null })
                );
            }
        }

        // Log Work Session (fire alongside task update) — gated identically to the timerMinutes
        // accrual above so the task total and the summed work_sessions never diverge (a recovery
        // pause that credits a sub-minute segment also logs its matching session).
        if (shouldCredit) {
            // Attribute the session to the date the work ENDED (endMoment), matching every
            // other work_sessions writer (sessionActions, time-correction). Using the
            // start date previously mis-bucketed sessions that ran across midnight.
            const sessionDate = getLithuanianDateString(endMoment);
            // Deterministic id (taskSessionDocId): a concurrent closer of this SAME running
            // stretch — a second device, the manager's force-end, the server auto-stop — lands on
            // the same doc, so the interval can never be logged twice. merge:true keeps the
            // trigger-stamped fields (teamManagerIds) intact when this write arrives second.
            parallelOps.push(
                setDoc(doc(db, 'work_sessions', taskSessionDocId(task.id, start.getTime())), {
                    taskId: task.id,
                    taskTitle: live.title || 'Nežinoma užduotis',
                    userId: live.assignedUserId,
                    userName: live.assignedUserName || null,
                    startTime: start.toISOString(),
                    endTime: endMoment.toISOString(),
                    durationMinutes: elapsedMinutes,
                    date: sessionDate,
                    createdAt: new Date().toISOString()
                }, { merge: true }).catch(logErr => logError(logErr, { source: 'writeFail:pauseTask.workSession' }))
            );
        }

        await Promise.all(parallelOps);

        // Surface the credited duration + whether the clamp actually reduced it, so the
        // crash-recovery hook can show the worker an accurate "timer recovered" notice. The
        // clamp fired when the unclamped delta exceeded the bounded credit (a genuine overflow,
        // ignoring sub-minute float noise). A clean, in-bounds pause reports wasCapped:false.
        return {
            creditedMinutes: elapsedMinutes,
            rawMinutes,
            wasCapped: rawMinutes - elapsedMinutes > 1,
        };
    } catch (err) {
        console.error("Error pausing task:", err);
        // Durable-log the pause failure: a failed pause is what leaves the timer running and
        // credits ghost time on the next pause, so it must be visible in the crash log — not
        // only the console. (The work_sessions write already has its own .catch→logError.)
        logError(err, { source: 'taskActions.pauseTask' });
        throw err;
    } finally {
        pauseInFlight.delete(task.id);
    }
};

/**
 * Close an already-running stretch on the task we are about to (RE-)ANCHOR.
 *
 * `pauseOtherTasks` deliberately skips the task being started — so the ONE document whose
 * timerStartedAt this write is about to overwrite was the only one nobody confirmed. When the
 * caller's snapshot is a stale cache copy (a backgrounded tablet still showing 'paused' for a task
 * the phone has been running since 08:00), tapping Pradėti/Tęsti re-anchored timerStartedAt to now
 * and the whole 08:00→now stretch vanished: no work_sessions row, no timerMinutes credit, no error.
 * So: read the task server-first, and if the server says it is STILL running, bank that stretch
 * through pauseTask first (deterministic taskSessionDocId, so a concurrent closer converges on the
 * same row) and only then let the caller re-anchor.
 *
 * Fails CLOSED — an unconfirmed or unbanked stretch aborts the start. A start that did not happen is
 * a repeatable tap; worked time discarded by a re-anchor is unrecoverable.
 *
 * @returns {Promise<boolean>} true when it is safe to proceed with the re-anchor.
 */
const closeRunningStretchOnTarget = async (task, userId, source) => {
    let confirmed;
    try {
        const snap = await getDocFromServer(doc(db, 'tasks', task.id))
            .catch(() => getDoc(doc(db, 'tasks', task.id)));
        confirmed = snap?.exists?.() ? { id: task.id, ...snap.data() } : null;
    } catch (guardErr) {
        logError(guardErr, { source: `${source}:targetGuardRead`, userId, taskId: task.id });
        return false;
    }
    // Nothing running on the server (the normal case) → nothing to bank, proceed.
    if (!confirmed || confirmed.timerStatus !== 'running' || !confirmed.timerStartedAt) return true;
    try {
        // Credit only up to the last PROOF OF LIFE, never to `now`.
        //
        // The precondition this helper fires on — server says 'running', this client believed
        // 'paused' — is the very same state an abandoned or crashed timer leaves behind. A bare
        // pause credits [timerStartedAt → now] clamped to MAX_SESSION_MINUTES (16h), so on the
        // orphan reading it would silently INVENT the whole dead offline gap as paid work; see the
        // identical hazard spelled out on isPreBootOrphanTask (hooks/useTaskTimeMonitor.js), which
        // exists so the 100% monitor yields rather than does exactly this. Discarding worked time
        // and inventing it are both wrong numbers, and the invented one reaches reports and pay.
        //
        // The heartbeat is already on the doc we just read server-first, so bounding the credit to
        // it costs nothing and needs no cross-layer import (utils never imports from hooks, and
        // useOrphanedTaskRecovery imports pauseTask from here — that direction would be a cycle).
        // Anything past the last beat stays untracked and is left to the recovery flow's opt-in
        // "Buvau darbe" claim rather than being auto-credited here.
        const startedMs = new Date(confirmed.timerStartedAt).getTime();
        const beatMs = confirmed.timerLastHeartbeat ? new Date(confirmed.timerLastHeartbeat).getTime() : NaN;
        const creditTo = Number.isFinite(beatMs) && beatMs > startedMs ? new Date(beatMs).toISOString() : null;
        // skipUserStatusUpdate: the caller overwrites the user doc to 'running' immediately after.
        await pauseTask(confirmed, { skipUserStatusUpdate: true, endTime: creditTo });
    } catch (pauseErr) {
        logError(pauseErr, { source: `${source}:closeRunningStretch`, userId, taskId: task.id });
        return false;
    }
    return true;
};

/**
 * Resumes a paused task.
 *
 * Serialized per user via {@link withUserLock} (same rationale as startTask). Note endSession's
 * fire-and-forget resume calls THIS function after it has released its own lock, so the two queue
 * rather than deadlock.
 *
 * @param {Object} task - The task object to resume.
 * @param {string} userId - The user ID.
 * @returns {Promise<void>}
 */
export const resumeTask = (task, userId) => withUserLock(userId, () => resumeTaskImpl(task, userId));

const resumeTaskImpl = async (task, userId) => {
    try {
        // Re-validate INSIDE the lock before overwriting activeSession. endSession's doResume calls
        // this fire-and-forget AFTER its supersede check ran OUTSIDE any lock; during that check's
        // round-trip the worker can tap a new break/call/quick-work, whose startSession commits on
        // THIS same per-user lock. Re-reading here — inside the lock, so that commit is already
        // visible — lets us abort rather than blindly overwrite activeSession, which was a silent,
        // unrecoverable wipe of a session that had not yet been logged anywhere. Skipping the resume
        // is the safe side: a non-resumed paused task stays recoverable (manual resume / orphan
        // recovery). Server-first with a cache fallback so an offline worker still reads the
        // latency-compensated local state (the same-device commit is already there).
        try {
            const snap = await getDocFromServer(doc(db, 'users', userId)).catch(() => getDoc(doc(db, 'users', userId)));
            const live = snap?.exists?.() ? snap.data()?.activeSession : null;
            if (live && live.type && live.type !== 'task' && live.startTime) {
                logError(new Error('resumeTask skipped: live secondary session present'), {
                    source: 'resumeTask:supersededByLiveSession', userId, taskId: task.id, liveType: live.type,
                });
                return;
            }
        } catch (guardErr) {
            // Fail CLOSED: unproven safety → skip the resume rather than risk wiping a live session.
            logError(guardErr, { source: 'resumeTask:guardRead', userId, taskId: task.id });
            return;
        }

        // 1. Pause others (must complete before resuming)
        await pauseOtherTasks(userId, task.id);

        // 1b. Same as startTask: a resume tapped from a stale 'paused' snapshot would otherwise
        // re-anchor over a stretch that is still running on the server and discard it silently.
        if (!(await closeRunningStretchOnTarget(task, userId, 'resumeTask'))) return;

        const now = new Date().toISOString();

        // 2. Update Task + User Status + activeSession in PARALLEL
        await Promise.all([
            updateDoc(doc(db, 'tasks', task.id), {
                timerStatus: 'running',
                timerStartedAt: now,
                // Seed the heartbeat on resume too (same rationale as startTask).
                timerLastHeartbeat: now,
                startedAt: task.startedAt || now,
                status: 'in-progress',
                updatedAt: now
            }),
            updateDoc(doc(db, 'users', userId), {
                workStatus: {
                    isWorking: true,
                    status: 'running',
                    activeTaskId: task.id,
                    lastUpdated: now
                },
                activeSession: {
                    type: 'task',
                    startTime: now,
                    taskId: task.id,
                    taskTitle: task.title || 'Užduotis'
                },
                // Clear any orphaned legacy session flags to prevent UI deadlocks
                'breakState.isTakingBreak': false,
                'callState.isCalling': false,
                'quickWorkState.isQuickWorking': false
            })
        ]);

    } catch (err) {
        console.error("Error resuming task:", err);
        // Same durable-log rationale as startTask — a failed resume must reach errorLog.js, not
        // just the console.
        logError(err, { source: 'taskActions.resumeTask' });
        throw err;
    }
};

/**
 * Recover a briefly-orphaned running task WITHOUT stopping its timer.
 *
 * Used by the crash/reload recovery hook when a timer that was left "running" across an app
 * restart has a recent heartbeat — i.e. the worker was actively working and the app merely
 * reloaded (backgrounded tab killed, PWA update, memory eviction). Instead of pausing and
 * forcing a manual restart (which silently dropped the rest of the shift in the original
 * incident), we:
 *   1. credit the proven stretch [timerStartedAt → endTimeMs] as one session (pauseTask with an
 *      explicit end — so nothing past the last heartbeat is credited), then
 *   2. re-anchor a fresh running interval from now (startTask) so the timer simply continues.
 *
 * Both steps already serialize per user (pauseTask via its in-flight guard, startTask via the
 * user lock), so the user's activeSession ends correct and the worker never has to notice.
 *
 * @param {Object} task   - the orphaned running task (needs id, timerStartedAt, assignedUserId).
 * @param {number} endTimeMs - epoch ms of the last heartbeat (the credited stretch's end).
 */
export const creditAndResumeTask = async (task, endTimeMs) => {
    // Credit + log the proven segment, then resume. skipUserStatusUpdate is intentionally NOT
    // set: pauseTask's user-doc write is harmless here because startTask immediately overwrites
    // it back to 'running' with a fresh activeSession.
    await pauseTask(task, { endTime: endTimeMs });
    await startTask(task, task.assignedUserId);
};

/**
 * Helper to get docs with cache fallback.
 */
const getDocsWithCacheFallback = async (q) => {
    try {
        // Try default (server first/smart)
        return await getDocs(q);
    } catch (err) {
        console.warn("Network fetch failed, attempting cache fallback...", err);
        // Fallback to cache
        // Note: getDocs({ source: 'cache' }) requires the query to perfectly match cached data or it might be empty
        // But for simple queries it often works.
        try {
            return await getDocs(q, { source: 'cache' });
        } catch (cacheErr) {
            console.error("Cache fallback also failed:", cacheErr);
            return { docs: [] }; // Return empty to not block
        }
    }
};

/**
 * Pauses all OTHER running tasks for a user, to ensure single threaded work.
 * @param {string} userId - The ID of the user.
 * @param {string} currentTaskId - The ID of the task that is about to start (to skip pausing it).
 * @returns {Promise<void>}
 */
export const pauseOtherTasks = async (userId, currentTaskId) => {
    try {
        const q = query(
            collection(db, 'tasks'),
            where('assignedUserId', '==', userId),
            where('timerStatus', '==', 'running')
        );

        // Use robust fetch
        const snapshot = await getDocsWithCacheFallback(q);

        const candidates = snapshot.docs.filter(docSnap => docSnap.id !== currentTaskId);

        const pausePromises = candidates.map(async (docSnap) => {
            // The discovery query above can be served from a stale local cache with no error at
            // all (persistentLocalCache does this silently when offline; the try/catch inside
            // getDocsWithCacheFallback only covers the rarer hard-failure case) — the SAME class
            // of staleness startTask/resumeTask already guard against on the user doc. Re-confirm
            // THIS specific task doc against the server before pausing it: if another device
            // already paused it, the server copy shows timerStatus:'paused' (or a resumed run with
            // a newer timerStartedAt), and blindly pausing the stale snapshot would credit idle
            // time from the old timerStartedAt and clobber the newer work_sessions row via the
            // deterministic doc id (taskSessionDocId).
            let confirmed;
            try {
                const serverSnap = await getDocFromServer(doc(db, 'tasks', docSnap.id))
                    .catch(() => getDoc(doc(db, 'tasks', docSnap.id)));
                confirmed = serverSnap?.exists?.() ? { id: docSnap.id, ...serverSnap.data() } : null;
            } catch (guardErr) {
                // Fail CLOSED like startTask/resumeTask: an unconfirmed pause is skipped rather than
                // risk crediting stale idle time. A task left running a little longer is a repairable
                // no-op (the next pause/recovery catches it); a wrongly-credited or clobbered session
                // row is not.
                logError(guardErr, { source: 'pauseOtherTasks:guardRead', userId, taskId: docSnap.id });
                return null;
            }
            if (!confirmed || confirmed.timerStatus !== 'running') return null; // already paused elsewhere
            return pauseTask(confirmed, { skipUserStatusUpdate: true });
        });

        // We use allSettled to ensure one failure doesn't stop others
        await Promise.allSettled(pausePromises);
    } catch (err) {
        // Explicitly catch everything in pauseOtherTasks so it NEVER blocks startTask.
        // Still record it durably: a failure here leaves OTHER tasks running (ghost time /
        // concurrent-running state), so an admin must be able to see it remotely.
        logError(err, { source: 'taskActions.pauseOtherTasks' });
    }
};
/**
 * Archives a task by moving it from 'tasks' to 'archived_tasks' collection.
 * @param {Object} task - The full task data.
 * @param {string} userId - The ID of the user performing the archive.
 * @returns {Promise<void>}
 */
export const archiveTask = async (task, userId) => {
    if (!task || !task.id) return;

    try {
        const { id, ...taskData } = task;

        // 1. Create document in archived_tasks
        await setDoc(doc(db, 'archived_tasks', id), {
            ...taskData,
            archivedAt: new Date().toISOString(),
            archivedBy: userId
        });

        // 2. Delete from tasks
        await deleteDoc(doc(db, 'tasks', id));


    } catch (err) {
        console.error("Error archiving task:", err);
        throw err;
    }
};

/**
 * Saves a new task template.
 * @param {string} templateName - The name of the template.
 * @param {Object} selectedData - The task data to save in the template.
 * @param {Object} user - The current user object.
 * @returns {Promise<void>}
 */
export const saveTaskTemplate = async (templateName, selectedData, user, category = '', scope = 'personal') => {
    try {
        await addDoc(collection(db, 'task_templates'), {
            templateName,
            data: selectedData,
            // Top-level (not inside `data`) so it groups templates without ever leaking into the
            // task form when the template is applied.
            category: category || '',
            // 'personal' (private to this user) by default; 'team' = the shared, admin-curated
            // library everyone sees. The Firestore rules only let an admin write a 'team' scope.
            scope: scope === 'team' ? 'team' : 'personal',
            createdBy: user.uid,
            creatorName: user.displayName || user.email,
            createdAt: new Date().toISOString()
        });

    } catch (err) {
        console.error("Error saving template:", err);
        throw err;
    }
};

/**
 * Hide a (team) template from THIS user's own list without deleting it for anyone else. The hidden
 * set lives on the user's own doc (`hiddenTemplateIds`), so each person prunes their own view; the
 * shared template stays intact. Reversible via {@link unhideTemplateForUser}.
 * @param {string} uid
 * @param {string} templateId
 */
export const hideTemplateForUser = async (uid, templateId) => {
    if (!uid || !templateId) return;
    try {
        await updateDoc(doc(db, 'users', uid), { hiddenTemplateIds: arrayUnion(templateId) });
    } catch (err) {
        console.error('Error hiding template:', err);
        throw err;
    }
};

/**
 * Un-hide a template previously hidden via {@link hideTemplateForUser} — it reappears in the list.
 * @param {string} uid
 * @param {string} templateId
 */
export const unhideTemplateForUser = async (uid, templateId) => {
    if (!uid || !templateId) return;
    try {
        await updateDoc(doc(db, 'users', uid), { hiddenTemplateIds: arrayRemove(templateId) });
    } catch (err) {
        console.error('Error un-hiding template:', err);
        throw err;
    }
};

/**
 * Fetches all task templates.
 * @returns {Promise<Array>} Array of template objects.
 */
export const getTaskTemplates = async () => {
    try {
        const q = query(collection(db, 'task_templates'), orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (err) {
        console.error("Error fetching templates:", err);
        throw err;
    }
};

export const deleteTaskTemplate = async (templateId) => {
    try {
        await deleteDoc(doc(db, 'task_templates', templateId));

    } catch (err) {
        console.error("Error deleting template:", err);
        throw err;
    }
};

/**
 * Updates an existing task template.
 * @param {string} templateId - The ID of the template to update.
 * @param {string} templateName - The name of the template.
 * @param {Object} selectedData - The task data to save in the template.
 * @param {Object} user - The current user object.
 * @returns {Promise<void>}
 */
export const updateTaskTemplate = async (templateId, templateName, selectedData, user, category = '', scope = undefined) => {
    try {
        const payload = {
            templateName,
            data: selectedData,
            category: category || '',
            updatedBy: user.uid,
            updatedByName: user.displayName || user.email,
            updatedAt: new Date().toISOString()
        };
        // Re-scoping (promote personal → team or back) is admin-only and rare, so it is opt-in:
        // pass a scope to change it, omit it to leave the template's current scope untouched.
        if (scope === 'team' || scope === 'personal') payload.scope = scope;
        await updateDoc(doc(db, 'task_templates', templateId), payload);

    } catch (err) {
        console.error("Error updating template:", err);
        throw err;
    }
};

/**
 * Sets (or clears) a template's recurrence descriptor — the WHEN that turns a plain template into a
 * recurring job the scheduled generator materializes. Pass the full recurrence object (see
 * utils/recurrence.js) or null to make the template non-recurring.
 *
 * WRITE SCOPE (this used to claim "manager/admin-writable — no new rule needed", which is FALSE and
 * cost managers unexplained 'Nepavyko išsaugoti.' failures): the task_templates update rule admits
 * only an ADMIN or the template's own `createdBy`. A plain manager editing someone else's template
 * is denied by the rules, however manager-shaped the surface calling this looks.
 *
 * @param {string} templateId
 * @param {Object|null} recurrence
 * @param {Object} user - current user (for the audit stamp)
 */
export const setTemplateRecurrence = async (templateId, recurrence, user) => {
    try {
        await updateDoc(doc(db, 'task_templates', templateId), {
            recurrence: recurrence || null,
            updatedBy: user.uid,
            updatedByName: user.displayName || user.email,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error("Error setting template recurrence:", err);
        throw err;
    }
};

/**
 * Sets a template's baked assignee to the single CANONICAL field (`data.assignedUserId`), which the
 * generator reads. This is also the place the legacy `assignedWorkerId` drift is healed: writing the
 * canonical field and clearing the old one removes the ambiguity the data exposed (templates split
 * 5 old / 9 new). Pass an empty string to leave it unassigned.
 *
 * @param {string} templateId
 * @param {string} assignedUserId
 * @param {Object} user
 */
export const setTemplateAssignee = async (templateId, assignedUserId, user) => {
    try {
        await updateDoc(doc(db, 'task_templates', templateId), {
            'data.assignedUserId': assignedUserId || '',
            'data.assignedWorkerId': null, // heal the old-field drift on write
            updatedBy: user.uid,
            updatedByName: user.displayName || user.email,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error("Error setting template assignee:", err);
        throw err;
    }
};

/**
 * Create a single task from a plain field object — the shared create path for the manager
 * conveniences (one-tap "create from template", the quick-add bar). Writes a normal `tasks` doc so
 * the stampTeamOnTaskWrite trigger denormalizes teamManagerIds and approval/timer/archival all work
 * unchanged. Canonicalizes priority + persists estimatedTimeMinutes so the write satisfies the
 * tasks shape rules and reports read clean values. Status is always 'pending'.
 *
 * @param {Object} fields - { title, description?, priority?, estimatedTime?, assignedUserId?,
 *                            managerId?, tag?, links?, checklist?, sourceTemplateId? }
 * @param {Object} user - the current user (createdBy/auditor when no managerId is given)
 * @returns {Promise<string>} the new task id
 */
export const createManagerTask = async (fields, user) => {
    const managerId = fields.managerId || user.uid;
    // Assemble the caller-owned fields; createTask canonicalizes priority/estimate, stamps
    // provenance from the actor (createdBy/creatorName), defaults status='pending', mints the id,
    // writes the doc, and records ONE decision_log entry (ADR 0015, increment 3). The previous
    // inline addDoc is gone — task creation now has a single, audited path.
    const taskFields = {
        title: fields.title,
        description: fields.description || '',
        priority: fields.priority,
        estimatedTime: fields.estimatedTime || '',
        assignedUserId: fields.assignedUserId || '',
        managerId,
        taskAuditor: managerId,
        deadline: fields.deadline || '',
        tag: fields.tag || '',
        links: fields.links,
        checklist: fields.checklist,
    };
    if (fields.sourceTemplateId) taskFields.sourceTemplateId = fields.sourceTemplateId;
    const result = await createTask(
        { fields: taskFields },
        { actor: humanActor(user), mode: MODES.COMMIT, reason: 'created via manager convenience' },
    );
    return result.targetId;
};

/**
 * Deletes a task by.
 * Depending on options, it either archives it as deleted (keeping hours) or hard-deletes it and marks sessions as deleted.
 * @param {Object} task - The task to delete.
 * @param {string} userId - The user ID.
 * @param {Object} options - Options for deletion, e.g. { keepWorkHours: boolean }
 */
export const deleteTask = async (task, userId, options = { keepWorkHours: false }) => {
    if (!task || !task.id) return;

    try {
        // 0. Pause a running timer first (logs the final session, frees the user) — kept here so the
        // deleteTask command needn't import the timer code and create a domain↔taskActions cycle.
        if (task.timerStatus === 'running') {
            try {
                await pauseTask(task);
                if (task.assignedUserId) {
                    await updateUserWorkStatus(task.assignedUserId, false, 'idle', null);
                }
            } catch (pErr) {
                console.error("Error pausing active task before deletion:", pErr);
                // Continue with deletion even if pause fails, to avoid "undead" tasks
            }
        }

        // Resolve the actor's role (the keep-hours path auto-confirms for a manager) + name for the
        // audit, reusing the single user-doc read the role check already needs.
        const userDoc = await getDoc(doc(db, 'users', userId));
        const userData = userDoc.exists() ? userDoc.data() : {};
        const isManager = isManagerRole(userData.role || 'worker');
        const actor = humanActor({ uid: userId, displayName: userData.displayName, email: userData.email, role: userData.role });

        // The soft/hard delete writes + the decision_log entry are owned by the audited deleteTask
        // command (ADR 0015, increment 6). This util keeps the timer-pause + role/actor resolution.
        await deleteTaskCommand(
            { task, keepWorkHours: !!options.keepWorkHours, isManager },
            { actor, mode: MODES.COMMIT, reason: options.keepWorkHours ? 'deleted (kept hours)' : 'deleted (hard)' },
        );

        // Tell the assignee their task was removed (so it doesn't just silently vanish from their
        // list). Best-effort + self-dropped by notify(): a worker deleting their own task, or a task
        // with no assignee, never pings. Fired after the delete commits, so a notify failure can't
        // block the deletion.
        if (task.assignedUserId) {
            await notify({
                recipientId: task.assignedUserId,
                type: 'task_deleted',
                taskId: task.id,
                taskTitle: task.title || 'Užduotis',
                actorUid: userId,
                actorName: userData.displayName || userData.email,
            });
        }
    } catch (err) {
        console.error("Error deleting task:", err);
        throw err;
    }
};


/**
 * Reverts a completed or deleted task back to active (pending) state.
 * Clears completion, deletion, and confirmation flags so the user can continue working.
 * @param {Object} task - The task to revert.
 * @returns {Promise<void>}
 */
export const revertTask = async (task, user) => {
    if (!task || !task.id) return;
    // Routed through the audited reopenTask command (ADR 0015, increment 4): the same status/
    // completion/deletion reset, now plus a decision_log entry naming who reopened it. The previous
    // inline updateDoc is gone.
    await reopenTask({ task }, { actor: humanActor(user), mode: MODES.COMMIT, reason: 'reverted to active' });
};

export const extendTaskTime = async (taskId, additionalTimeString, extendedBy) => {
    if (!taskId || !additionalTimeString) return;

    try {
        const taskRef = doc(db, 'tasks', taskId);
        const taskSnap = await getDoc(taskRef);
        if (!taskSnap.exists()) throw new Error('Task not found');

        const taskData = taskSnap.data();
        const currentEstimatedMinutes = parseTimeStringToMinutes(taskData.estimatedTime || '0m');
        const additionalMinutes = parseTimeStringToMinutes(additionalTimeString);

        if (additionalMinutes <= 0) throw new Error('Invalid time extension');

        const newTotalMinutes = currentEstimatedMinutes + additionalMinutes;
        const newEstimatedTime = formatMinutesToTimeString(newTotalMinutes);

        // Build extension history entry
        const extensionEntry = {
            amount: additionalTimeString,
            amountMinutes: additionalMinutes,
            addedAt: new Date().toISOString(),
            addedBy: extendedBy,
            previousEstimate: taskData.estimatedTime
        };

        await updateDoc(taskRef, {
            estimatedTime: newEstimatedTime,
            estimatedTimeMinutes: newTotalMinutes,
            timeLimitReached: false,
            warningShown70: false,
            inspectionStatus: null,
            timeExtensions: [...(taskData.timeExtensions || []), extensionEntry],
            updatedAt: new Date().toISOString()
        });

    } catch (err) {
        console.error('Error extending task time:', err);
        throw err;
    }
};

/**
 * requestTimeExtension — the worker explicitly asks their manager for more time once the whole
 * estimate is spent. This used to be auto-fired by useTaskTimeMonitor the moment 100% was hit;
 * it is now a deliberate worker action chosen from the time-limit popup, so it may carry a note
 * and/or photos. The task stays paused; the manager granting (extendTaskTime) re-arms the monitor.
 *
 * Written with a DIRECT addDoc (not the best-effort `notify()`), because this is a deliberate
 * worker action that the popup must be able to report as failed — `notify()` swallows write errors,
 * which would let the popup falsely show "sent". We still stamp `category` from the one type→category
 * map (so the bell can never disagree) and keep the `userId` worker-as-author provenance the rule
 * and the manager card both expect. `commentText` is trimmed and capped to the rule's 2000-char limit.
 */
export const requestTimeExtension = async ({ task, currentUser, estimatedTime, actualMinutes, commentText = '', attachmentUrls = [] }) => {
    const recipientId = task?.managerId || task?.taskAuditor;
    // No manager to ask — signal the caller so it can surface friendly LT copy instead of writing
    // a doc that violates the recipientId rule.
    if (!recipientId) throw new Error('no-manager');

    const payload = {
        recipientId,
        type: 'time_extension_request',
        category: categoryOf('time_extension_request'),
        taskId: task.id,
        taskTitle: task.title || 'Užduotis',
        estimatedTime: estimatedTime || task.estimatedTime || null,
        actualMinutes: Number.isFinite(actualMinutes)
            ? actualMinutes
            : Math.round((task.timerMinutes || 0) + (task.manualMinutes || 0)),
        userName: currentUser?.displayName || currentUser?.email || 'Meistras',
        userId: currentUser?.uid,
        isRead: false,
        createdAt: new Date().toISOString()
    };

    const trimmed = (commentText || '').trim();
    if (trimmed) payload.commentText = trimmed.slice(0, 2000);
    if (Array.isArray(attachmentUrls) && attachmentUrls.length) payload.attachmentUrls = attachmentUrls;

    await addDoc(collection(db, 'request_notifications'), payload);
};

/**
 * completeTaskAtLimit — finalize an ALREADY-PAUSED task straight from the time-limit popup.
 *
 * The monitor pauses the timer (committing minutes + the work_sessions row) BEFORE the popup
 * appears, so — unlike performFinish, which finishes a still-running timer — this neither
 * recomputes elapsed time nor logs another session.
 *
 * The status/approval transition is delegated to the audited domain `completeTask` command, so the
 * auto-confirm rule (manager/admin or own-manager → 'confirmed'; worker → 'completed' awaiting
 * acceptance) lives in ONE place and this path also gets a decision_log entry. The command derives
 * the rule from the ACTOR's role, which lives on `userData`/`userRole` — NOT on the Firebase auth
 * `currentUser` — so we build the actor with the app role explicitly. On top of the command we set
 * the denormalized `actualTime` + clear the alarm latch, clear the worker's active session, and
 * (workers only) notify the manager so the task reaches the pridavimas queue.
 */
export const completeTaskAtLimit = async (task, { currentUser, userData, userRole }) => {
    const totalMinutes = (task.timerMinutes || 0) + (task.manualMinutes || 0);
    const formattedTime = formatMinutesToTimeString(totalMinutes);

    // 1. Audited status write (single source of the auto-confirm rule + decision_log entry).
    const actor = humanActor({
        uid: currentUser?.uid,
        displayName: currentUser?.displayName,
        email: currentUser?.email,
        role: userRole
    });
    let result;
    try {
        result = await completeTask({ task }, {
            actor,
            mode: MODES.COMMIT,
            reason: 'finished from time-limit popup'
        });
    } catch (err) {
        // A manager-shaped role auto-confirms (resolveCompletionStatus), but the deployed rules only
        // let a manager flip the approval fields on a task they actually OVERSEE — a whole-team
        // viewer, the task's named vadovas/auditor, or a scoped overseer whose closure holds the row.
        // A scoped or SENIOR manager finishing their OWN task, assigned to them by someone else,
        // matches none of those (the assignee branch is blocked by changesApprovalFields), so the
        // 'confirmed' write is denied. This door has no other exit: the caller stops the repeating
        // alarm and closes the forced popup only AFTER this resolves, so the throw trapped the worker
        // with a sounding alarm and a modal that would not close. On that exact denial re-issue the
        // completion as a NON-manager one — the identical payload with status 'completed', a write the
        // assignee is always permitted — so the task finishes and simply waits for its real overseer's
        // priėmimas. The same fallback TaskTimerControls.performFinish already performs. Only the ROLE
        // the status rule reads is downgraded; the decision_log still stamps the real actor.
        if (err?.code !== 'permission-denied' || !isManagerRole(userRole)) throw err;
        logError(err, { source: 'completeTaskAtLimit.autoConfirmDenied', taskId: task.id });
        result = await completeTask({ task }, {
            actor: { ...actor, role: null },
            mode: MODES.COMMIT,
            reason: 'finished from time-limit popup (auto-confirm denied — awaiting overseer acceptance)'
        });
    }
    // The command reports the resulting status: 'confirmed' = a manager/own-manager auto-confirmed
    // (no review needed), 'completed' = a worker's task now awaiting the manager's acceptance.
    const isManagerOrAdmin = result?.effect?.after?.status === 'confirmed';

    // 2. Denormalized fields the command does not own: the displayed total + the alarm latch.
    try {
        await updateDoc(doc(db, 'tasks', task.id), {
            actualTime: formattedTime,
            timeLimitReached: false,
            updatedAt: new Date().toISOString()
        });
    } catch (e) {
        logError(e, { source: 'completeTaskAtLimit.actualTime' });
    }

    // 3. Clear the worker's active session if it still points at this task. pauseTask already cleared
    // activeSession on auto-pause, but workStatus.activeTaskId can still reference the finished task.
    if (task.assignedUserId === currentUser?.uid) {
        try {
            await updateDoc(doc(db, 'users', currentUser.uid), {
                workStatus: {
                    isWorking: false,
                    status: 'idle',
                    activeTaskId: null,
                    lastUpdated: new Date().toISOString()
                },
                activeSession: null
            });
        } catch (e) {
            logError(e, { source: 'completeTaskAtLimit.clearSession' });
        }
    }

    // 4. Notify the manager (workers only — a manager/admin completing auto-confirms, no review
    // needed). Best-effort via notify(): the task IS already completed, so a failed notice must not
    // surface as a completion failure (mirrors performFinish).
    if (!isManagerOrAdmin) {
        let recipientId = task.managerId || null;
        if (!recipientId || recipientId === currentUser?.uid) {
            recipientId = userData?.defaultManager || null;
        }
        await notify({
            recipientId,
            type: 'task_completion',
            taskId: task.id,
            taskTitle: task.title || 'Užduotis',
            actualTime: formattedTime,
            actualMinutes: totalMinutes,
            userName: currentUser?.displayName || currentUser?.email || 'Meistras',
            userId: currentUser?.uid,
            completedAt: new Date().toISOString()
        });
    }

    return { isManagerOrAdmin };
};

