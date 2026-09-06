import { useEffect, useRef } from 'react';
import { doc, getDocFromServer } from 'firebase/firestore';
import { db } from '../firebase';
import { useRevisionedTimerSession } from './useRevisionedTimerSession';
import {
    canonicalSessionState,
    planTaskRecover,
} from '../utils/timerTransitionPlan';
import { issueTimerCommand } from '../utils/timerCommandEngine';
import { awaitServerClock, serverNowISO } from '../utils/serverClock';
import { addRecoveryNotice } from '../utils/recoveryNotice';
import { raiseRefusedGapClaim } from '../utils/gapClaim';
import { logError } from '../utils/errorLog';
import { appLoadTimeServer } from './useOrphanedTaskRecovery';
import { isOwnedByThisDevice } from '../utils/appInstance';

const idFor = (prefix) => {
    const random = globalThis.crypto?.randomUUID?.()
        || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${random}`;
};

/**
 * The PRE-BOOT gate: is there a task run in the canonical record that this boot should even
 * consider recovering? Returns the run, or null.
 *
 * Extracted from the effect so the sequence can be proved without React. It is a gate, not a
 * decision: passing it only earns the run a SERVER read (see canRecoverConfirmedRun below).
 * A run that started at or after this boot is the timer the worker is running right now.
 */
export function taskRunAwaitingRecovery(base, appLoadedAt) {
    if (!base || base.status !== 'active' || base.run?.type !== 'task') return null;
    const startedAt = new Date(base.run.startedAt).getTime();
    if (!Number.isFinite(startedAt) || startedAt >= appLoadedAt) return null;
    return base.run;
}

/**
 * The SERVER-CONFIRMATION gate: given the task document as the SERVER has it right now, may THIS
 * device recover `runId`? Every clause exists because it once failed in production:
 *
 *  - not running any more → the nightly forgotten-timer net (or a manager force-end, or another
 *    device) already closed and credited this stretch; recovering on top wrote a SECOND ledger row
 *    for the same minutes under an id that can never dedupe against the first.
 *  - a DIFFERENT run id → the worker already started a new run; crediting would attribute the new
 *    run's minutes to the dead one.
 *  - owned by another DEVICE → not an orphan at all. A phone timer is always "pre-boot" and always
 *    looks dead to a PC (the heartbeat is foreground-only), so without this clause signing in on a
 *    second device reliably stopped the worker's live timer — the reported "when I sign in, it
 *    stops". A run genuinely abandoned on a device that never returns is closed by the server net,
 *    never by a bystander. (ADR 0026.)
 */
export function canRecoverConfirmedRun(fresh, runId) {
    if (!fresh || fresh.timerStatus !== 'running' || !fresh.timerStartedAt) return false;
    if (fresh.timerRunId && fresh.timerRunId !== runId) return false;
    return isOwnedByThisDevice(fresh.timerOwnerInstance);
}

export function useRevisionedTaskRecovery(
    tasks,
    currentUser,
    userData,
    enabled
) {
    const session = useRevisionedTimerSession(currentUser?.uid, enabled);
    const handledRuns = useRef(new Set());

    useEffect(() => {
        if (!enabled || !currentUser?.uid || !session.loaded || session.error) return;

        const base = canonicalSessionState(session.record, {
            ...userData,
            id: currentUser.uid,
        });
        const pendingRun = taskRunAwaitingRecovery(base, appLoadTimeServer());
        if (!pendingRun) return;
        if (handledRuns.current.has(base.run.runId)) return;

        const task = tasks.find((candidate) => candidate.id === base.run.taskId);
        if (!task) return;

        handledRuns.current.add(base.run.runId);

        // An effect callback cannot be async, and the server confirmation below must be awaited
        // before any plan is built — so the rest of the recovery runs as its own async scope.
        (async () => {
        // Anchor the clock BEFORE anything is stamped. This runs at boot, which is precisely the
        // window in which the fire-and-forget probe from main.jsx has not landed yet, so serverNowISO
        // would still be the raw device clock. On a machine that runs fast, the recoveryEnd below
        // would then exceed the rules' 2-minute future bound and the whole atomic transition is
        // denied — leaving the run canonically active, unstoppable and unrestartable on that device.
        // Unlike a human-triggered action, nothing here waits seconds for a tap, so this is the one
        // path that must ask. It joins the in-flight boot probe rather than issuing its own.
        await awaitServerClock();

        // Confirm against the SERVER before crediting anything — the guard the legacy path has had
        // since the first double-credit incident (confirmTaskOrphanOnServer), and which this path
        // never had. Two things make it mandatory here:
        //
        //  • The nightly autoStopForgottenTimers may already have closed this run: it credits the
        //    heartbeat-proven minutes and writes work_sessions/sess_task_{taskId}_{startMs}. It does
        //    NOT touch active_sessions (functions/ has no notion of it), so the canonical record
        //    still says 'active' and every rules check still passes. Recovering on top of that wrote
        //    a SECOND ledger row (sess_run_{runId}) for the same stretch — two ids that can never
        //    dedupe — and flipped the task back to running, undoing the server's stop.
        //  • The `tasks` array here is snapshot state whose first emission after boot comes from the
        //    local cache, so task.timerMinutes can be the pre-death value. The accumulation below is
        //    base + proven + gap, so a stale base silently discards whatever the server credited.
        //
        // A read that FAILS proves nothing (offline boot), so the run is left unlatched to retry —
        // never recovered from the cache copy.
        let fresh;
        try {
            const snap = await getDocFromServer(doc(db, 'tasks', task.id));
            fresh = snap.exists() ? { id: snap.id, ...snap.data() } : null;
        } catch (error) {
            handledRuns.current.delete(base.run.runId);
            logError(error, {
                source: 'revisionedTaskRecovery.confirm',
                taskId: task.id,
                runId: base.run.runId,
            });
            return;
        }

        // Already finalized elsewhere, superseded by a newer run, or anchored by another DEVICE —
        // each reason and its production incident is documented on canRecoverConfirmedRun above.
        if (!canRecoverConfirmedRun(fresh, base.run.runId)) return;

        const recoveredAt = serverNowISO();
        let plan;
        try {
            plan = planTaskRecover({
                task: fresh,
                userId: currentUser.uid,
                userData,
                activeRecord: session.record,
                commandId: idFor('timer_recover'),
                runId: idFor('timer_run'),
                issuedAt: recoveredAt,
                recoveredAt,
            });
        } catch (error) {
            handledRuns.current.delete(base.run.runId);
            logError(error, {
                source: 'revisionedTaskRecovery.plan',
                taskId: task.id,
                runId: base.run.runId,
            });
            return;
        }

        issueTimerCommand(plan).then((issued) => {
            issued.settlement.then((outcome) => {
                if (outcome.status !== 'confirmed') return;
                if (plan.recoveredGap) {
                    addRecoveryNotice(currentUser.uid, {
                        kind: 'task-gap-credited',
                        taskId: task.id,
                        taskTitle: task.title || '',
                        gapMinutes: Math.round(plan.recoveredGap.gapMinutes),
                        sessionId: plan.recoveredGap.sessionId,
                    });
                    return;
                }
                // The plan declined to auto-credit this interval (too long, or it spans two work
                // days). It may still be real work, so offer the opt-IN claim instead of dropping
                // it — the same fallback legacy's offerManualClaim provides, including the durable
                // server trace, because the localStorage notice alone leaves nothing to triage from
                // if the worker never taps it.
                if (plan.refusedGap) {
                    const gapMinutes = Math.round(plan.refusedGap.gapMinutes);
                    logError(new Error('orphan gap not auto-credited (gap-not-one-work-stretch)'), {
                        source: 'revisionedTaskRecovery.gapNotAutoCredited',
                        taskId: task.id,
                        gapMinutes,
                        fromIso: plan.refusedGap.fromIso,
                        toIso: plan.refusedGap.toIso,
                    });
                    addRecoveryNotice(currentUser.uid, {
                        kind: 'task-gap',
                        taskId: task.id,
                        taskTitle: task.title || '',
                        gapMinutes,
                        fromIso: plan.refusedGap.fromIso,
                        toIso: plan.refusedGap.toIso,
                    });
                    // ADR 0025 — mirror legacy's escalation exactly (see offerManualClaim). The two
                    // engines credit the same physical event, so a refusal must reach the same people
                    // on both; the atomic batch fixed counter drift, not this. Fire-and-forget: the
                    // recover command has already settled and must not be held up by a notification.
                    raiseRefusedGapClaim({
                        task: { id: task.id, title: task.title },
                        worker: currentUser,
                        fromIso: plan.refusedGap.fromIso,
                        toIso: plan.refusedGap.toIso,
                        gapMinutes,
                        cause: 'gap-not-one-work-stretch',
                        engine: 'canonical',
                    }).catch(() => { /* helper is best-effort and logs its own failures */ });
                }
            });
        }).catch((error) => {
            handledRuns.current.delete(base.run.runId);
            logError(error, {
                source: 'revisionedTaskRecovery.issue',
                taskId: task.id,
                runId: base.run.runId,
            });
        });
        })();
    }, [
        currentUser,
        enabled,
        session.error,
        session.loaded,
        session.record,
        tasks,
        userData,
    ]);
}
