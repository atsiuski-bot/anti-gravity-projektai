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

// How old a QUEUED command may be before replay refuses to issue it.
//
// Replay is deliberately not gated on the engine flag: an intent can be persisted to the outbox and
// only then have its Firestore batch issued, so gating on the live flag stranded exactly the
// commands a rollback was supposed to protect. But "never gated" and "valid forever" are different
// claims. A command's expectedRevision/expectedRunId only reject it once the canonical record has
// MOVED — and after a rollback the worker goes back to the legacy writers, which never touch that
// record. A start queued on Friday could then land days later against an unmoved revision, succeed,
// and leave the worker canonically "live" on a run their legacy session closed long ago, crediting
// an ancient stretch nobody worked.
//
// The bound is the same 16h ceiling that defines the longest possible single run (MAX_SESSION_MINUTES
// mirrors it server-side): past that the intent describes a working day that is simply over. A stale
// command is marked rejected rather than dropped, so TimerSyncNotice tells the worker it did not
// happen instead of failing silently.
export const TIMER_COMMAND_MAX_REPLAY_AGE_MS = 16 * 60 * 60 * 1000;

export function isStaleForReplay(command, nowMs = Date.now()) {
    const issuedMs = Date.parse(command?.issuedAt || '');
    if (!Number.isFinite(issuedMs)) return false;   // unparseable → let the revision guards decide
    return nowMs - issuedMs > TIMER_COMMAND_MAX_REPLAY_AGE_MS;
}

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
        // Only a command we would RE-ISSUE ourselves can be refused for age. A 'pending' one is
        // already sitting in Firestore's own durable write queue and will commit on reconnect no
        // matter what this outbox says — calling it rejected there would be a lie to the worker.
        if (cachedState === 'missing' && isStaleForReplay(entry)) {
            await updateTimerCommandStatus(entry.commandId, 'rejected', {
                errorCode: 'timer/stale-replay',
            });
            results.push({ status: 'rejected', commandId: entry.commandId });
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
