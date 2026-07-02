import { useEffect, useRef } from 'react';
import { doc, getDocFromServer } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, creditAndResumeTask } from '../utils/taskActions';
import { claimRecoveredGap } from '../utils/sessionEditActions';
import { addRecoveryNotice } from '../utils/recoveryNotice';
import { logError } from '../utils/errorLog';
import { TIMER_HEARTBEAT_CONTINUE_MS, MAX_SESSION_MINUTES } from '../utils/timeUtils';

// Captured once when this module is first evaluated — i.e. when the app/tab boots.
// A task whose timerStartedAt predates this moment was left timerStatus:'running'
// across an app restart, reload, or crash: the live timer that started it no longer
// exists, so it is an ORPHAN, not a running session. (A timer started during this
// app session has timerStartedAt >= APP_LOAD_TIME and is left untouched.)
//
// Exported so useTaskTimeMonitor can recognize the SAME pre-boot orphans from this one
// canonical instant and yield to this hook instead of racing it — see
// isPreBootOrphanTask in useTaskTimeMonitor.js.
export const APP_LOAD_TIME = Date.now();

// Decide what a pre-boot running task's crash-recovery should do — pure + exported so the
// credit-instant policy is unit-testable without a React renderer (mirrors isAbandonedSession in
// useOrphanedSessionRecovery). Returns one of:
//   { mode: 'skip' }                              — not an orphan (unparseable start, or started this session)
//   { mode: 'pause-now' }                         — no heartbeat: pause crediting up to now (clamped downstream)
//   { mode: 'resume', creditTo }                  — brief reload while working: credit + re-anchor, no banner
//   { mode: 'pause-at-beat', creditTo, gapFrom, gapTo } — genuinely closed: credit to last beat, pause, offer gap
//
// The key policy fix: in the RESUME case we credit up to the reload instant (appLoadTime), NOT the
// last heartbeat. A gap short enough to resume (≤ TIMER_HEARTBEAT_CONTINUE_MS) with the worker
// demonstrably back in the app is real continuous work; crediting only to the last beat leaked up
// to that bound on EVERY reload, which compounds to hours under a reload loop (the reported bug).
export function decideOrphanTaskRecovery(task, appLoadTime = Date.now()) {
    const startedAt = new Date(task?.timerStartedAt).getTime();
    if (!Number.isFinite(startedAt)) return { mode: 'skip' };
    // A timer started during THIS app session is live, not orphaned.
    if (startedAt >= appLoadTime) return { mode: 'skip' };

    const beatMs = task?.timerLastHeartbeat ? new Date(task.timerLastHeartbeat).getTime() : NaN;
    if (!Number.isFinite(beatMs)) return { mode: 'pause-now' };

    // The last proven-alive instant can't precede the start (guard a stale beat).
    const lastBeat = Math.max(beatMs, startedAt);
    const tailMs = appLoadTime - lastBeat;

    if (tailMs <= TIMER_HEARTBEAT_CONTINUE_MS) {
        return { mode: 'resume', creditTo: appLoadTime };
    }
    return { mode: 'pause-at-beat', creditTo: lastBeat, gapFrom: lastBeat, gapTo: appLoadTime };
}

// Decide + carry out what happens to the untracked gap [decision.gapFrom, decision.gapTo] after a
// pause-at-beat recovery credited the proven part. Exported (not inlined in the effect) so this
// ORCHESTRATION — auto-credit vs. fall back to the opt-in claim offer — is unit-testable without a
// React renderer, mirroring decideOrphanTaskRecovery above.
//
// Only a plausibly-single real stretch (≥1 min, ≤16h) is auto-handled; a longer gap is almost
// certainly a multi-day forgotten timer, not one offline shift. AUTO-credit only fires when the
// running task is the CURRENT user's own (attribution/rules would be wrong otherwise) and the write
// succeeds — any other case falls back to the opt-in claim offer so the time is never silently lost.
export async function resolveUntrackedGap(task, currentUser, decision) {
    const gapMinutes = Math.round((decision.gapTo - decision.gapFrom) / 60000);
    if (gapMinutes < 1 || gapMinutes > MAX_SESSION_MINUTES || !task.assignedUserId) return;

    const fromIso = new Date(decision.gapFrom).toISOString();
    const toIso = new Date(decision.gapTo).toISOString();

    const offerManualClaim = () =>
        addRecoveryNotice(task.assignedUserId, {
            kind: 'task-gap', taskId: task.id, taskTitle: task.title || '',
            gapMinutes, fromIso, toIso,
        });

    const isOwnTask = currentUser?.uid && currentUser.uid === task.assignedUserId;
    if (!isOwnTask) { offerManualClaim(); return; }

    // AUTO-credit the gap as its own recovered-gap session (opt-out), attributed to and authored by
    // the worker so the work_sessions rules accept it.
    const claim = await claimRecoveredGap({
        task: { id: task.id, title: task.title },
        worker: currentUser,
        startTime: fromIso,
        endTime: toIso,
    });

    if (claim?.ok) {
        addRecoveryNotice(task.assignedUserId, {
            kind: 'task-gap-credited', taskId: task.id, taskTitle: task.title || '',
            gapMinutes, sessionId: claim.id,
        });
    } else {
        offerManualClaim();
    }
}

// Confirm a suspected orphan against the SERVER (never the cache) before any recovery write. The
// local snapshot that flagged the orphan can be arbitrarily stale — with the persistent cache, the
// first emission after boot is simply the previous run's state — and every past double-credit in
// this class came from acting on it: the server's autoStopForgottenTimers had already paused the
// task and credited [start → beat], or a second device had already paused/finished the run, and a
// recovery pause here logged the SAME interval again. Returns the FRESH task when the exact same
// run (same timerStartedAt) is still running on the server, or null when another closer got there
// first / a new run replaced it. Throws on a failed read (offline) — the caller must treat the
// orphan as UNPROVEN and retry later rather than fall back to the cache.
export async function confirmTaskOrphanOnServer(task) {
    const snap = await getDocFromServer(doc(db, 'tasks', task.id));
    if (!snap.exists()) return null;
    const fresh = { id: snap.id, ...snap.data() };
    if (fresh.timerStatus !== 'running' || !fresh.timerStartedAt) return null;
    if (fresh.timerStartedAt !== task.timerStartedAt) return null;
    return fresh;
}

// Recover ONE server-confirmed orphan end-to-end: confirm, re-decide on the FRESH doc, dispatch.
// Exported so the confirm→decide→dispatch orchestration is unit-testable without a React renderer.
//
// Two deliberate choices:
//   • The decision runs on the SERVER doc, not the snapshot that raised the suspicion — the fresh
//     copy carries the true timerMinutes base (so a pause cannot overwrite a newer credit with a
//     stale sum) and the true last beat.
//   • It is anchored at nowMs (the confirm instant), not the boot instant: on an offline boot the
//     confirm runs only when connectivity returns, and the untracked-gap window must extend to
//     cover the app-open stretch worked in between, or that stretch would be silently dropped.
// A confirm failure propagates to the caller (unlatch + retry); a failed WRITE after a successful
// confirm is logged and stays latched, exactly as before.
export async function recoverConfirmedOrphan(task, currentUser, nowMs = Date.now()) {
    const fresh = await confirmTaskOrphanOnServer(task);
    if (!fresh) return null; // another closer already finalized this run — nothing left to recover
    const decision = decideOrphanTaskRecovery(fresh, nowMs);
    if (decision.mode === 'skip') return null;
    try {
        // (1) No proof of life — fall back to the original behaviour exactly: credit up to
        // now (clamped), pause, and tell the worker. We have nothing better to go on.
        if (decision.mode === 'pause-now') {
            stampRecoveredNotice(fresh, await pauseTask(fresh));
            return null;
        }
        // (2) Brief reload while working — credit up to the reload instant (real continuous
        // work, not just up to the last beat) and re-anchor. Seamless, no banner.
        if (decision.mode === 'resume') {
            await creditAndResumeTask(fresh, decision.creditTo);
            return null;
        }
        // (3) Large tail — credit the proven part up to the last beat and pause, then resolve
        // the untracked gap (auto-credit or claim offer); see pauseAtBeatAndResolveGap.
        return await pauseAtBeatAndResolveGap(fresh, currentUser, decision);
    } catch (e) {
        logError(e, { source: 'orphanRecovery:pauseTask', taskId: task.id });
        return null;
    }
}

// Carry out a pause-at-beat recovery for one orphan: credit the proven stretch up to the last beat,
// stamp the one-time "recovered" notice, then resolve the untracked gap [last beat → load]. Exported
// (not inlined in the effect) so this pause→gap ORCHESTRATION is unit-testable without a React
// renderer, mirroring resolveUntrackedGap / decideOrphanTaskRecovery.
//
// The gap is resolved ONLY when our own pause actually credited it — i.e. pauseTask returned a
// non-null result. A null result means the pause was DEDUPED by pauseInFlight: the time-limit
// monitor's checkTime auto-paused this same over-limit orphan one tick earlier, crediting ONE
// session up to NOW — an instant strictly later than the last beat — so that single session already
// covers the whole [last beat → now] gap. Auto-crediting the gap again here would write a SECOND
// work_sessions row for the same interval; since reports sum work_sessions, the interval would
// double-count and the summed sessions would diverge from task.timerMinutes (the very invariant
// pauseTask maintains). Gating on the result closes that double-credit path.
export async function pauseAtBeatAndResolveGap(task, currentUser, decision) {
    const result = await pauseTask(task, { endTime: decision.creditTo });
    stampRecoveredNotice(task, result);
    if (result) await resolveUntrackedGap(task, currentUser, decision);
    return result;
}

/**
 * Crash/reload recovery for orphaned running tasks — heartbeat-aware.
 *
 * A live task timer is only a stored start instant; the next manual pause credits
 * (now - timerStartedAt). Without recovery, a task left "running" when the app died would crash
 * the ENTIRE offline gap into work_sessions on the next pause. The original fix bluntly paused
 * every such orphan — but that ALSO stopped the timer of a worker whose app merely reloaded
 * mid-shift, silently dropping the rest of their work until they noticed (the reported incident).
 *
 * With the per-minute heartbeat ({@link useTaskHeartbeat}) we can do better, using the last beat
 * as the "last proof of work" instant:
 *   1. No heartbeat at all (pre-heartbeat data, or a timer killed within the first beat) →
 *      preserve the original safe behaviour: pause, crediting up to now, clamped to 16h.
 *   2. Small tail (load time − last beat ≤ {@link TIMER_HEARTBEAT_CONTINUE_MS}) → a brief reload
 *      WHILE WORKING: credit up to the last beat and RE-ANCHOR the timer to keep running. Seamless,
 *      no banner — the worker never has to restart.
 *   3. Large tail → the app was genuinely closed: credit up to the last beat (never the dead gap)
 *      and pause, then AUTO-credit the untracked gap [last beat → load] as work and show a notice
 *      with a one-tap "Nedirbau" to remove it. This is an OPT-OUT, not an opt-in: offline field
 *      work with a pocketed phone (which freezes the heartbeat) is the norm, so silently requiring
 *      the worker to claim it lost real pay. Bounded to a plausible single shift (≤16h); a longer
 *      gap, or no signed-in identity / a failed auto-credit write, falls back to the opt-in claim
 *      offer so the time is never silently lost.
 *
 * Each task is handled at most once per app session — after a SERVER confirmation that the orphan
 * is real (confirmTaskOrphanOnServer). A failed confirmation (offline boot) unlatches the task so
 * a later snapshot retries; a cached, unconfirmed copy is never acted on.
 *
 * @param {Array} tasks - the live tasks list (already scoped to the current user).
 * @param {Object} currentUser - the authenticated user (attributes + authors the auto-credited gap).
 */
export function useOrphanedTaskRecovery(tasks, currentUser) {
    const handledRef = useRef(new Set());

    useEffect(() => {
        if (!Array.isArray(tasks) || tasks.length === 0) return;

        tasks.forEach((task) => {
            if (!task || task.timerStatus !== 'running' || !task.timerStartedAt) return;
            if (handledRef.current.has(task.id)) return;

            // Cheap pre-filter on the (possibly cached) snapshot: only a pre-boot run is even a
            // candidate. The REAL decision is re-made inside recoverConfirmedOrphan on the
            // server-confirmed doc — never on this unconfirmed copy.
            if (decideOrphanTaskRecovery(task, APP_LOAD_TIME).mode === 'skip') return;

            handledRef.current.add(task.id);

            recoverConfirmedOrphan(task, currentUser).catch((e) => {
                // The server re-read failed (offline boot, transient network): the orphan is
                // UNPROVEN and nothing was written. Unlatch so a later snapshot — e.g. the one
                // that fires on reconnect — retries; deciding from the unconfirmed cache is the
                // exact staleness that used to double-credit / kill live timers.
                handledRef.current.delete(task.id);
                logError(e, { source: 'orphanRecovery:confirmTask', taskId: task.id });
            });
        });
        // currentUser is a dep so a task loaded before auth resolves is still auto-credited once the
        // user arrives; handledRef makes the re-run a no-op for any task already processed.
    }, [tasks, currentUser]);
}

// Stamp the one-time "timer recovered" notice when a pause actually credited time. Keyed to the
// task OWNER (assignedUserId), the same uid the banner reads on next open. A sub-minute orphan
// credits nothing and recovers invisibly.
function stampRecoveredNotice(task, result) {
    if (result && result.creditedMinutes > 0 && task.assignedUserId) {
        addRecoveryNotice(task.assignedUserId, {
            kind: 'task',
            taskId: task.id,
            taskTitle: task.title || '',
            minutes: result.creditedMinutes,
            wasCapped: !!result.wasCapped,
        });
    }
}
