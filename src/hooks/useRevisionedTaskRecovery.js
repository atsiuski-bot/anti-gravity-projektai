import { useEffect, useRef } from 'react';
import { useRevisionedTimerSession } from './useRevisionedTimerSession';
import {
    canonicalSessionState,
    planTaskRecover,
} from '../utils/timerTransitionPlan';
import { issueTimerCommand } from '../utils/timerCommandEngine';
import { addRecoveryNotice } from '../utils/recoveryNotice';
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
        const recoveredAt = new Date().toISOString();
        let plan;
        try {
            plan = planTaskRecover({
                task,
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
                if (outcome.status !== 'confirmed' || !plan.recoveredGap) return;
                addRecoveryNotice(currentUser.uid, {
                    kind: 'task-gap-credited',
                    taskId: task.id,
                    taskTitle: task.title || '',
                    gapMinutes: Math.round(plan.recoveredGap.gapMinutes),
                    sessionId: plan.recoveredGap.sessionId,
                });
            });
        }).catch((error) => {
            handledRuns.current.delete(base.run.runId);
            logError(error, {
                source: 'revisionedTaskRecovery.issue',
                taskId: task.id,
                runId: base.run.runId,
            });
        });
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
