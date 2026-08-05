import { useEffect, useRef } from 'react';
import { doc, getDocFromServer } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, creditAndResumeTask, startTask, clearLiveSessionAfterFailedResume } from '../utils/taskActions';
import { claimRecoveredGap } from '../utils/sessionEditActions';
import { raiseRefusedGapClaim } from '../utils/gapClaim';
import { addRecoveryNotice } from '../utils/recoveryNotice';
import { logError } from '../utils/errorLog';
import { TIMER_HEARTBEAT_CONTINUE_MS, MAX_SESSION_MINUTES, isCreditableUntrackedGap } from '../utils/timeUtils';
import { awaitServerClock, serverNowMs, toServerFrame } from '../utils/serverClock';
import { isOwnedByThisDevice } from '../utils/appInstance';

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

// The same boot instant, expressed in the SERVER's frame.
//
// APP_LOAD_TIME is unavoidably a raw device reading: it is taken when this module is evaluated,
// long before the clock probe could have landed. Everything it gets compared against — a run's
// timerStartedAt, its timerLastHeartbeat — is server-anchored. On a device whose clock is off, that
// mismatch is not a rounding detail: it shifts every "is this run pre-boot" and "how stale is this
// beat" answer by the device's full error, so a machine a few minutes fast reads its own live,
// beating timer as an unproven orphan and stops it on every boot. Call this (never APP_LOAD_TIME)
// wherever the boot instant meets a server-stamped one. It is a function, not a constant, because
// the anchor lands asynchronously — reading it early yields the uncorrected value, which is exactly
// the pre-anchor behaviour and no worse.
export const appLoadTimeServer = () => toServerFrame(APP_LOAD_TIME);

// Decide what a pre-boot running task's crash-recovery should do — pure + exported so the
// credit-instant policy is unit-testable without a React renderer (mirrors isAbandonedSession in
// useOrphanedSessionRecovery). Returns one of:
//   { mode: 'skip' }                              — not an orphan (unparseable start, or started this session)
//   { mode: 'resume', creditTo }                  — credit the whole stretch up to now, then re-anchor
//   { mode: 'pause-at-beat', creditTo, gapFrom, gapTo } — long silence: credit to the last beat, then
//                                                   resolve the untracked gap, then re-anchor
//
// Neither outcome leaves the timer stopped any more (ADR 0027) — "pause" here names only the CLOSE
// half of each transition, which is what files the ledger row; a fresh run is anchored right after.
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

    // No usable beat — pre-heartbeat data, or a timer killed before its first beat. There is no
    // proven boundary to split on, so the whole stretch is credited up to now (clamped downstream)
    // and the run continues: the same outcome as a brief reload, which is why it is the same mode.
    const beatMs = task?.timerLastHeartbeat ? new Date(task.timerLastHeartbeat).getTime() : NaN;
    if (!Number.isFinite(beatMs)) return { mode: 'resume', creditTo: appLoadTime };

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
// `silent` suppresses ONLY the success banner. It is set on the silent-continuation path, where the
// timer never stopped and the worker is meant to notice nothing at all — a banner there would be the
// single interruption in an otherwise seamless recovery. The FAILURE branch is never silenced: when
// the auto-credit write does not land the time is genuinely un-credited, so the claim offer (and its
// durable error_logs trace) must still appear or real worked time disappears without a record.
export async function resolveUntrackedGap(task, currentUser, decision, silent = false) {
    const gapMinutes = Math.round((decision.gapTo - decision.gapFrom) / 60000);
    if (gapMinutes < 1 || gapMinutes > MAX_SESSION_MINUTES || !task.assignedUserId) return;

    const fromIso = new Date(decision.gapFrom).toISOString();
    const toIso = new Date(decision.gapTo).toISOString();

    // Offer the opt-in "Užskaityti" claim as the fallback when the gap cannot be AUTO-credited, and
    // leave a durable server trace the moment it happens. The claim offer itself lives ONLY in
    // per-device localStorage (recoveryNotice), so a fallback the worker never taps used to vanish
    // with no server record at all — which is precisely why a genuine lost-time report could not be
    // traced afterwards (the incident had no error_logs, only a cold "Neaktyvus" band). The trace
    // names the un-credited gap [fromIso → toIso] so the next triage can find and restore it.
    const offerManualClaim = (cause) => {
        logError(new Error(`orphan gap not auto-credited (${cause})`), {
            source: 'orphanRecovery:gapNotAutoCredited',
            taskId: task.id, gapMinutes, fromIso, toIso, cause,
        });
        addRecoveryNotice(task.assignedUserId, {
            kind: 'task-gap', taskId: task.id, taskTitle: task.title || '',
            gapMinutes, fromIso, toIso,
        });
        // ADR 0025: the localStorage offer above is per-device, shown once, and only to the worker —
        // so on its own it lets real worked time be forfeited in silence. Escalate the same interval
        // to everyone who oversees them, as a decision they can settle in one tap. Fire-and-forget:
        // the pause/credit has already landed and must not be held up or undone by this, and the
        // helper records its own failures. Only for the worker's OWN task — a claim is authored as
        // the subject, so we cannot raise one on somebody else's behalf.
        if (currentUser?.uid && currentUser.uid === task.assignedUserId) {
            raiseRefusedGapClaim({
                task: { id: task.id, title: task.title },
                worker: currentUser,
                fromIso, toIso, gapMinutes, cause, engine: 'legacy',
            }).catch(() => { /* helper is best-effort and logs its own failures */ });
        }
    };

    const isOwnTask = currentUser?.uid && currentUser.uid === task.assignedUserId;
    if (!isOwnTask) { offerManualClaim('not-own-task'); return; }

    // An interval too long — or spanning two work days — is a forgotten timer, not silent work, so
    // it must not be paid for by default. Bounding this by the 16h SESSION ceiling let a timer left
    // running overnight credit 623 minutes of sleep (production, 2026-07-27). Falling through to
    // the claim offer keeps the worker's real option open: it flips the default from opt-out to
    // opt-in rather than discarding the time.
    if (!isCreditableUntrackedGap(decision.gapFrom, decision.gapTo)) {
        offerManualClaim('gap-not-one-work-stretch');
        return;
    }

    // AUTO-credit the gap as its own recovered-gap session (opt-out), attributed to and authored by
    // the worker so the work_sessions rules accept it.
    const claim = await claimRecoveredGap({
        task: { id: task.id, title: task.title },
        worker: currentUser,
        startTime: fromIso,
        endTime: toIso,
    });

    if (claim?.ok) {
        if (silent) return;
        addRecoveryNotice(task.assignedUserId, {
            kind: 'task-gap-credited', taskId: task.id, taskTitle: task.title || '',
            gapMinutes, sessionId: claim.id,
        });
    } else {
        offerManualClaim('auto-credit-write-failed');
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
    // Only THIS DEVICE's own run is recoverable. A pre-boot run is not evidence of a crash when the
    // worker simply has another device: their phone's timer is always pre-boot from a PC signing in
    // later, and its foreground-only heartbeat goes quiet the moment the phone is pocketed — so this
    // check is the whole difference between "recover my crashed run" and "stop the timer they are
    // using". Runs abandoned on a device that never returns are the server net's job.
    if (!isOwnedByThisDevice(fresh.timerOwnerInstance)) return null;
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
export async function recoverConfirmedOrphan(task, currentUser, nowMs = serverNowMs(), appLoadTime = appLoadTimeServer()) {
    const fresh = await confirmTaskOrphanOnServer(task);
    if (!fresh) return null; // another closer already finalized this run — nothing left to recover
    const decision = decideOrphanTaskRecovery(fresh, nowMs);
    if (decision.mode === 'skip') return null;
    try {
        // (1) Nothing proven to split on, or only a brief silence — credit the whole stretch up to
        // now (clamped) and re-anchor. Seamless, no banner.
        if (decision.mode === 'resume') {
            await creditAndResumeTask(fresh, decision.creditTo);
            return null;
        }
        // (2) Long silence — credit the proven part up to the last beat, resolve the untracked gap
        // (auto-credit or claim offer), then re-anchor; see pauseAtBeatAndResolveGap.
        //
        // The re-anchor is unconditional (ADR 0027). The app cannot tell "pocketed but working" from
        // "stopped working" — both are just a quiet heartbeat — and iOS discards a backgrounded PWA,
        // so on a phone EVERY return to the app arrived here with a stale beat and stopped a timer
        // the worker was still using (reported 2026-08-05). It no longer guesses: a running timer
        // means work until the worker stops it. What may be PAID is a separate question, answered
        // below by resolveUntrackedGap and unchanged.
        //
        // `silentGap` still is conditional, and on different evidence: the offline restart, where
        // THIS app has been open and showing this timer as running the whole time. It restarted with
        // no signal, so it could neither server-confirm the orphan (this function's first line
        // throws, and the caller retries) nor write a heartbeat (it does not own the run) — while the
        // worker watched a running timer and kept working. A confirm that lands well after boot is
        // the evidence that this is what happened, and there the worker should notice nothing at all.
        // On an ordinary cold re-open they WERE away, so the credited-gap banner must appear: those
        // minutes are opt-OUT pay, and that banner is their only way to refuse them.
        return await pauseAtBeatAndResolveGap(fresh, currentUser, decision, {
            silentGap: nowMs - appLoadTime > TIMER_HEARTBEAT_CONTINUE_MS,
        });
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
//
// The close is always followed by a re-anchor (ADR 0027), so no "timer was recovered and stopped"
// notice is shown — it was not stopped. The one exception is a re-anchor that DECLINES, handled at
// the bottom: there the timer really is stopped and the worker must be told so.
//
// `silentGap` swallows the gap's own success banner, and it is a separate decision on different
// evidence: the offline restart, where the app was open and visibly running the whole time and the
// worker should notice nothing at all. On an ordinary cold re-open they were away, and those
// credited minutes are opt-OUT pay whose "Nedirbau" banner is their only way to refuse time they did
// not work. That banner is about credited MONEY, not about the timer.
export async function pauseAtBeatAndResolveGap(task, currentUser, decision, { silentGap = false } = {}) {
    // Skip the user-doc clear because a re-anchor follows, for the same reason creditAndResumeTask
    // does — the session must not blink out between the close and the restart.
    const result = await pauseTask(task, { endTime: decision.creditTo, skipUserStatusUpdate: true });
    if (result) await resolveUntrackedGap(task, currentUser, decision, silentGap);

    // A null result means our pause was DEDUPED — the time-limit monitor closed this same run one
    // tick earlier and credited it up to now, which is also why it is showing the worker a forced
    // "limit reached" popup. Re-anchoring on top of that would start a second run behind that popup,
    // so the continuation is off here for the same reason the gap credit above is.
    if (!result) {
        stampRecoveredNotice(task, result);
        return result;
    }

    // startTask fails CLOSED (returns false, never throws). If it declines, the timer really is
    // stopped, so undo the skipped clear and fall back to the honest "recovered and stopped" notice.
    const resumed = await startTask(task, task.assignedUserId);
    if (!resumed) {
        await clearLiveSessionAfterFailedResume(task);
        stampRecoveredNotice(task, result);
    }
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
 * RECOVERY NEVER LEAVES THE TIMER STOPPED (ADR 0027). It always closes the old run — which is what
 * files the ledger row — and anchors a fresh one from this instant. The app cannot tell "pocketed but
 * working" from "stopped working": both are just a quiet heartbeat, and since iOS discards a
 * backgrounded PWA, every return to the app on a phone arrives here with a stale beat. Guessing
 * "stopped" there killed the timer on EVERY re-open. So it no longer guesses — a running timer means
 * work until the worker stops it.
 *
 * What may be CREDITED is a separate question, and the per-minute heartbeat ({@link useTaskHeartbeat})
 * is what answers it, using the last beat as the "last proof of work" instant:
 *   1. No heartbeat at all (pre-heartbeat data, or a timer killed within the first beat), or a small
 *      tail (load time − last beat ≤ {@link TIMER_HEARTBEAT_CONTINUE_MS}) → nothing to split on, or a
 *      brief reload while working: credit the whole stretch up to now, clamped to 16h. No banner.
 *   2. Large tail → credit up to the last beat (never blindly the dead gap), then AUTO-credit the
 *      untracked gap [last beat → load] as work and show a notice with a one-tap "Nedirbau" to remove
 *      it. This is an OPT-OUT, not an opt-in: offline field work with a pocketed phone (which freezes
 *      the heartbeat) is the norm, so silently requiring the worker to claim it lost real pay.
 *      Bounded to a plausible single shift; a longer gap, no signed-in identity, or a failed
 *      auto-credit write falls back to the opt-in claim offer so the time is never silently lost.
 *
 * Each task is handled at most once per app session — after a SERVER confirmation that the orphan
 * is real (confirmTaskOrphanOnServer). A failed confirmation (offline boot) unlatches the task so
 * a later snapshot retries; a cached, unconfirmed copy is never acted on.
 *
 * @param {Array} tasks - the live tasks list (already scoped to the current user).
 * @param {Object} currentUser - the authenticated user (attributes + authors the auto-credited gap).
 */
export function useOrphanedTaskRecovery(tasks, currentUser, enabled = true) {
    const handledRef = useRef(new Set());

    useEffect(() => {
        if (!enabled) return;
        if (!Array.isArray(tasks) || tasks.length === 0) return;
        // Wait for a resolved identity before acting OR latching. resolveUntrackedGap AUTO-credits the
        // untracked gap as a session authored by and attributed to the signed-in worker (its own-task
        // check). If this effect ran while currentUser was still null — a boot where the tasks snapshot
        // arrives before auth resolves — it would latch the task with only the opt-in claim offer and,
        // because handledRef then no-ops the re-run, NEVER auto-credit once auth landed: the gap
        // silently downgraded to "claim it yourself". Skipping until the uid is present (currentUser is
        // a dep, so this re-runs when auth lands) is the same discipline useOrphanedSessionRecovery uses.
        if (!currentUser?.uid) return;

        tasks.forEach((task) => {
            if (!task || task.timerStatus !== 'running' || !task.timerStartedAt) return;
            if (handledRef.current.has(task.id)) return;

            // Cheap pre-filter on the (possibly cached) snapshot: only a pre-boot run is even a
            // candidate. The REAL decision is re-made inside recoverConfirmedOrphan on the
            // server-confirmed doc — never on this unconfirmed copy.
            if (decideOrphanTaskRecovery(task, appLoadTimeServer()).mode === 'skip') return;

            handledRef.current.add(task.id);

            // Anchor the clock before the recovery reads "now" or stamps anything. This runs at
            // boot, the one window where the fire-and-forget probe from main.jsx may not have landed
            // — see awaitServerClock for why an unanchored recovery write is refused outright by the
            // rules and leaves the run stuck active.
            awaitServerClock().then(() => recoverConfirmedOrphan(task, currentUser)).catch((e) => {
                // The server re-read failed (offline boot, transient network): the orphan is
                // UNPROVEN and nothing was written. Unlatch so a later snapshot — e.g. the one
                // that fires on reconnect — retries; deciding from the unconfirmed cache is the
                // exact staleness that used to double-credit / kill live timers.
                handledRef.current.delete(task.id);
                logError(e, { source: 'orphanRecovery:confirmTask', taskId: task.id });
            });
        });
        // currentUser is a dep so a task first seen before auth resolves is processed once the user
        // arrives (the guard above skips until then); handledRef makes any later re-run a no-op for a
        // task already handled.
    }, [tasks, currentUser, enabled]);
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
