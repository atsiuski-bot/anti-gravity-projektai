import { useEffect, useRef } from 'react';
import { doc, getDocFromServer } from 'firebase/firestore';
import { db } from '../firebase';
import { useRevisionedTimerSession } from './useRevisionedTimerSession';
import {
    canonicalSessionState,
    planTaskRecover,
} from '../utils/timerTransitionPlan';
import { issueTimerCommand } from '../utils/timerCommandEngine';
import { serverNowISO } from '../utils/serverClock';
import { addRecoveryNotice } from '../utils/recoveryNotice';
import { raiseRefusedGapClaim } from '../utils/gapClaim';
import { logError } from '../utils/errorLog';
import { APP_LOAD_TIME } from './useOrphanedTaskRecovery';

const idFor = (prefix) => {
    const random = globalThis.crypto?.randomUUID?.()
        || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${random}`;
};

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
        if (base.status !== 'active' || base.run?.type !== 'task') return;

        const startedAt = new Date(base.run.startedAt).getTime();
        if (!Number.isFinite(startedAt) || startedAt >= APP_LOAD_TIME) return;
        if (handledRuns.current.has(base.run.runId)) return;

        const task = tasks.find((candidate) => candidate.id === base.run.taskId);
        if (!task) return;

        handledRuns.current.add(base.run.runId);

        // An effect callback cannot be async, and the server confirmation below must be awaited
        // before any plan is built — so the rest of the recovery runs as its own async scope.
        (async () => {
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

        // Someone else already finalized this stretch — the server net, a second device, or a
        // manager force-end. Nothing of ours left to credit.
        if (!fresh || fresh.timerStatus !== 'running' || !fresh.timerStartedAt) return;
        // …and it must still be THE SAME run, not a newer one started meanwhile.
        if (fresh.timerRunId && fresh.timerRunId !== base.run.runId) return;

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
