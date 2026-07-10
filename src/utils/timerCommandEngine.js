import {
    doc,
    getDocFromCache,
    getDocFromServer,
} from 'firebase/firestore';
import { db } from '../firebase';
import { logError } from './errorLog';
import {
    enqueueTimerCommand,
    listQueuedTimerCommands,
    updateTimerCommandStatus,
} from './timerOutbox';
import { applyTimerTransitionPlan } from './timerTransitionExecutor';
import { timerCommandPath } from './timerTransitionPlan';

const inFlight = new Map();

async function commandExists(userId, commandId) {
    const ref = doc(db, timerCommandPath(userId, commandId));
    try {
        return (await getDocFromServer(ref)).exists();
    } catch {
        return (await getDocFromCache(ref)).exists();
    }
}

async function cachedCommandState(userId, commandId) {
    try {
        const snapshot = await getDocFromCache(doc(db, timerCommandPath(userId, commandId)));
        if (!snapshot.exists()) return 'missing';
        return snapshot.metadata.hasPendingWrites ? 'pending' : 'confirmed';
    } catch {
        return 'missing';
    }
}

async function settle(command, plan) {
    try {
        await applyTimerTransitionPlan(db, plan);
        await updateTimerCommandStatus(command.commandId, 'confirmed', {
            confirmedAt: new Date().toISOString(),
        });
        return { status: 'confirmed', commandId: command.commandId };
    } catch (error) {
        let applied = false;
        try {
            applied = await commandExists(command.userId, command.commandId);
        } catch {
            // The authoritative result cannot be read yet. Keep the command queued for boot replay.
            return { status: 'queued', commandId: command.commandId };
        }

        if (applied) {
            await updateTimerCommandStatus(command.commandId, 'confirmed', {
                confirmedAt: new Date().toISOString(),
                replayDetected: true,
            });
            return { status: 'confirmed', commandId: command.commandId };
        }

        let status = 'rejected';
        if (error?.code === 'permission-denied') {
            try {
                const active = await getDocFromServer(doc(db, 'active_sessions', command.userId));
                const live = active.exists() ? active.data() : null;
                if (
                    (live?.revision ?? 0) > command.expectedRevision
                    || (command.expectedRunId && live?.run?.runId !== command.expectedRunId)
                ) {
                    status = 'conflicted';
                }
            } catch {
                // A permission failure without a readable newer revision is a rejection, not a
                // fabricated multi-device conflict.
            }
        }
        await updateTimerCommandStatus(command.commandId, status, {
            errorCode: error?.code || 'unknown',
        });
        logError(error, {
            source: 'timerCommandEngine.settle',
            commandId: command.commandId,
            commandKind: command.kind,
            outcome: status,
        });
        return { status, commandId: command.commandId, error };
    } finally {
        inFlight.delete(command.commandId);
    }
}

export async function issueTimerCommand(plan) {
    const { command } = plan;
    await enqueueTimerCommand(command, plan);
    const settlement = settle(command, plan);
    inFlight.set(command.commandId, settlement);
    return {
        status: 'queued',
        commandId: command.commandId,
        settlement,
    };
}

async function reconcileCachedCommand(command, plan) {
    try {
        const marker = await getDocFromServer(doc(db, timerCommandPath(
            command.userId,
            command.commandId
        )));
        if (marker.exists()) {
            await updateTimerCommandStatus(command.commandId, 'confirmed', {
                confirmedAt: new Date().toISOString(),
                replayDetected: true,
            });
            return { status: 'confirmed', commandId: command.commandId };
        }
        return settle(command, plan);
    } catch {
        // Firestore already owns this locally-persisted batch. While offline there is no promise
        // from the previous process to await, so keep the outbox entry queued and reconcile again
        // on the next online event instead of issuing a duplicate revision.
        return { status: 'queued', commandId: command.commandId };
    } finally {
        inFlight.delete(command.commandId);
    }
}

export async function replayQueuedTimerCommands(userId) {
    const queued = await listQueuedTimerCommands(userId);
    const results = [];
    for (const entry of queued) {
        if (inFlight.has(entry.commandId)) {
            results.push({
                status: 'queued',
                commandId: entry.commandId,
                settlement: inFlight.get(entry.commandId),
            });
            continue;
        }
        const cachedState = await cachedCommandState(entry.userId, entry.commandId);
        if (cachedState === 'confirmed') {
            await updateTimerCommandStatus(entry.commandId, 'confirmed', {
                confirmedAt: new Date().toISOString(),
                replayDetected: true,
            });
            results.push({ status: 'confirmed', commandId: entry.commandId });
            continue;
        }
        const settlement = cachedState === 'pending'
            ? reconcileCachedCommand(entry, entry.plan)
            : settle(entry, entry.plan);
        inFlight.set(entry.commandId, settlement);
        results.push({
            status: 'queued',
            commandId: entry.commandId,
            settlement,
        });
    }
    return results;
}
