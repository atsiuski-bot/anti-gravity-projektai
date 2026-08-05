import {
    breakDayBaseMinutes,
    clampSessionMinutes,
    formatMinutesToTimeString,
    getLithuanianDateString,
    isCreditableUntrackedGap,
    MIN_LOGGED_SESSION_MINUTES,
    TIMER_HEARTBEAT_CONTINUE_MS,
} from './timeUtils';
import { isManagerRole } from './formatters';
import { DEFAULT_PRIORITY } from './priority';
import { buildCallTitle } from './callContacts';
import { APP_INSTANCE_ID } from './appInstance';
import {
    evaluateSecondaryStart,
    isSecondarySessionType,
    pausedSessionStack,
} from './sessionNesting';

export const TIMER_ENGINE_VERSION = 2;
export const TIMER_ACTIVE_COLLECTION = 'active_sessions';
export const timerCommandPath = (userId, commandId) =>
    `users/${userId}/timer_commands/${commandId}`;

// Every ledger row this planner writes carries a DETERMINISTIC id that the server nets
// (functions/index.js: autoStopForgottenTimers / autoCloseForgottenSessions) can also mint for the
// same run — that shared id is what dedups the two independent closers. But the row is a plain
// document only until it exists: an onCreate trigger then denormalizes `teamManagerIds` onto it, and
// firestore.rules pins that field immutable on UPDATE. A bare `set` re-writes the whole document
// WITHOUT that field, so the moment a row already exists the write reads as "teamManagerIds
// cleared" and the rule denies it — taking the ENTIRE transition batch with it, including the
// active-session revision bump. The worker's stop then fails outright and they stay canonically
// live. Merging writes only the fields we actually own and leaves the server's stamp alone, which
// is what makes a replayed or server-raced close idempotent instead of fatal.
const MERGE_OVER_SERVER_STAMP = true;

const legacyRunId = (session) => {
    const startedAt = session?.startTime || '';
    const taskId = session?.taskId || 'unknown';
    return `legacy_${session?.type || 'session'}_${taskId}_${Date.parse(startedAt) || 0}`;
};

export function canonicalSessionState(record, userData = null) {
    if (record && Number.isInteger(record.revision) && record.revision > 0) {
        return record;
    }

    const legacy = userData?.activeSession;
    if (!legacy?.type || !legacy?.startTime) {
        return {
            userId: userData?.id || null,
            revision: 0,
            status: 'idle',
            run: null,
            source: 'legacy',
        };
    }

    return {
        userId: userData?.id || null,
        revision: 0,
        status: 'active',
        run: {
            runId: legacy.runId || legacyRunId(legacy),
            type: legacy.type,
            taskId: legacy.taskId || null,
            taskTitle: legacy.taskTitle || null,
            startedAt: legacy.startTime,
            pausedSession: legacy.pausedSession || null,
        },
        source: 'legacy',
    };
}

const commandWrite = (command, appliedRevision) => ({
    type: 'set',
    path: timerCommandPath(command.userId, command.commandId),
    data: {
        commandId: command.commandId,
        userId: command.userId,
        kind: command.kind,
        expectedRevision: command.expectedRevision,
        expectedRunId: command.expectedRunId,
        runId: command.runId,
        ...(command.actorId ? { actorId: command.actorId } : {}),
        appliedRevision,
        issuedAt: command.issuedAt,
        engineVersion: TIMER_ENGINE_VERSION,
    },
});

const activeRecord = ({ command, revision, status, run }) => ({
    userId: command.userId,
    revision,
    expectedRevision: command.expectedRevision,
    expectedRunId: command.expectedRunId,
    status,
    run,
    lastCommandId: command.commandId,
    updatedAt: command.issuedAt,
    engineVersion: TIMER_ENGINE_VERSION,
});

const legacyRunningProjection = (task, run, issuedAt) => ({
    activeSession: {
        type: 'task',
        startTime: run.startedAt,
        taskId: task.id,
        taskTitle: task.title || 'Užduotis',
        runId: run.runId,
        revision: run.revision,
    },
    workStatus: {
        isWorking: true,
        status: 'running',
        activeTaskId: task.id,
        lastUpdated: issuedAt,
    },
    'breakState.isTakingBreak': false,
    'callState.isCalling': false,
    'quickWorkState.isQuickWorking': false,
});

// The nesting rule lives in ONE place (sessionNesting.js) and is enforced twice on purpose: the
// buttons consult it so a control is never offered for a transition that will be rejected, and the
// planner re-checks it so a stale snapshot or a second device cannot commit a stack the rule forbids.
const isSecondaryRunType = isSecondarySessionType;

// The task (if any) sitting at the BOTTOM of the paused stack. The projection's
// workStatus.activeTaskId points at it, so "which task am I on" survives however many secondary
// sessions are stacked above it — previously this was hand-unrolled one level deep per call site,
// which silently reported "no task" as soon as a second secondary nested.
const pausedTaskIdOf = (pausedSession) => {
    let node = pausedSession;
    while (node) {
        if (node.type === 'task') return node.taskId || null;
        node = node.pausedSession || null;
    }
    return null;
};

const runToPausedSession = (run) => {
    if (!run) return null;
    const base = {
        type: run.type,
        startTime: run.startedAt || null,
        runId: run.runId || null,
        revision: run.revision || null,
    };
    if (run.type === 'task') {
        return {
            ...base,
            taskId: run.taskId || null,
            taskTitle: run.taskTitle || null,
        };
    }
    return {
        ...base,
        pausedSession: run.pausedSession || null,
    };
};

const secondaryFlagFor = (type) => {
    if (type === 'call') return 'isCalling';
    if (type === 'quickWork') return 'isQuickWorking';
    if (type === 'break') return 'isTakingBreak';
    return null;
};

const secondaryStateKeyFor = (type) => {
    if (type === 'call') return 'callState';
    if (type === 'quickWork') return 'quickWorkState';
    if (type === 'break') return 'breakState';
    return null;
};

const secondaryRunningProjection = (
    userData,
    run,
    issuedAt,
    closedBreakMinutes = 0,
) => {
    const stateKey = secondaryStateKeyFor(run.type);
    const flag = secondaryFlagFor(run.type);
    const pausedTaskId = pausedTaskIdOf(run.pausedSession);
    const projection = {
        activeSession: {
            type: run.type,
            startTime: run.startedAt,
            runId: run.runId,
            revision: run.revision,
            pausedSession: run.pausedSession || null,
        },
        breakState: {
            ...(userData?.breakState || {}),
            isTakingBreak: false,
            // The day total and the day it belongs to are written as ONE pair — see
            // breakDayBaseMinutes. Writing the number without re-dating it (or re-dating without
            // rebasing) is what let yesterday's total be read as today's.
            dailyAccumulatedMinutes:
                breakDayBaseMinutes(userData?.breakState, issuedAt) + closedBreakMinutes,
            lastDate: getLithuanianDateString(new Date(issuedAt)),
        },
        callState: {
            ...(userData?.callState || {}),
            isCalling: false,
        },
        quickWorkState: {
            ...(userData?.quickWorkState || {}),
            isQuickWorking: false,
        },
        workStatus: {
            ...(userData?.workStatus || {}),
            isWorking: false,
            status: 'paused',
            activeTaskId: pausedTaskId || userData?.workStatus?.activeTaskId || null,
            lastUpdated: issuedAt,
        },
    };
    if (stateKey && flag) {
        projection[stateKey] = {
            ...(projection[stateKey] || {}),
            [flag]: true,
            lastStartedAt: run.startedAt,
            resumableTaskIds: pausedTaskId ? [pausedTaskId] : (userData?.[stateKey]?.resumableTaskIds || []),
        };
    }
    return projection;
};

const closeBreakWrites = ({ userId, userData, run, endedAt }) => {
    if (!run?.runId || !run?.startedAt) {
        throw new Error('A running break and stable run are required to close a break');
    }
    const start = new Date(run.startedAt);
    const end = new Date(endedAt);
    const durationMinutes = clampSessionMinutes((end - start) / 60000);
    const writes = [];
    if (durationMinutes > MIN_LOGGED_SESSION_MINUTES) {
        writes.push({
            type: 'set',
            path: `break_sessions/sess_break_run_${run.runId}`,
            data: {
                userId,
                userName: userData?.displayName || null,
                runId: run.runId,
                startTime: start.toISOString(),
                endTime: end.toISOString(),
                durationMinutes,
                date: getLithuanianDateString(end),
                createdAt: endedAt,
                completedAt: end.toISOString(),
                isBreak: true,
                engineVersion: TIMER_ENGINE_VERSION,
            },
            merge: MERGE_OVER_SERVER_STAMP,
        });
    }
    return { durationMinutes, writes };
};

// Close the secondary run that a NEW transition interrupts, through the very same ledger writers a
// normal close uses.
//
// Canonical models an interruption as CLOSE-AND-REOPEN, never pause-and-continue: the interrupted
// stretch is banked as a self-contained record keyed to its OWN start, and the session later resumes
// as a NEW run with a NEW start. That is what makes a stack safe — two segments of one session can
// neither overlap in time nor collide on a ledger id, so no minute is ever credited twice however
// deep the sessions nest. (The break branch already worked this way; call and quick work were simply
// refused instead, which is why the UI offered switches the engine then rejected.)
//
// An interrupted call/quick work carries no classification yet, so it lands exactly as
// planManagerForceEnd leaves one: the call as a plain "Skambutis" record, the quick work as the
// auto-stopped placeholder the "describe later" banner already surfaces for retroactive naming.
function closeSecondaryWrites({ userId, userData, run, endedAt }) {
    if (!run?.runId || !run?.startedAt) {
        throw new Error('A running secondary session and a stable run are required to close it');
    }

    if (run.type === 'break') {
        const closed = closeBreakWrites({ userId, userData, run, endedAt });
        return { ...closed, breakMinutes: closed.durationMinutes };
    }

    const durationMinutes = clampSessionMinutes(
        (new Date(endedAt) - new Date(run.startedAt)) / 60000
    );

    if (run.type === 'call') {
        return {
            durationMinutes,
            breakMinutes: 0,
            writes: callLogWrites({
                userId,
                userData,
                run,
                endedAt,
                durationMinutes,
                contactType: null,
                callNotes: '',
            }),
        };
    }

    if (run.type === 'quickWork') {
        return {
            durationMinutes,
            breakMinutes: 0,
            // A sub-minute mis-tap is discarded rather than logged, matching the normal quick-work
            // close. A call is always logged (it has its own deliberate end gate), also matching.
            writes: durationMinutes > MIN_LOGGED_SESSION_MINUTES
                ? quickWorkLogWrites({
                    userId,
                    userData,
                    run,
                    endedAt,
                    durationMinutes,
                    customTitle: '',
                    customComment: '',
                    auditorManagerId: null,
                }).writes
                : [],
        };
    }

    throw new Error(`Unsupported secondary run type: ${run.type}`);
}

const clockTime = (date) =>
    date.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', hour12: false });

const breakRunningProjection = (userData, run, issuedAt, pausedTaskId = null) => ({
    activeSession: {
        type: 'break',
        startTime: run.startedAt,
        runId: run.runId,
        revision: run.revision,
        pausedSession: run.pausedSession || null,
    },
    breakState: {
        ...(userData?.breakState || {}),
        isTakingBreak: true,
        lastStartedAt: run.startedAt,
        // Rebase BEFORE re-dating. Stamping today's date onto yesterday's total is precisely how the
        // counter used to survive the day boundary (see breakDayBaseMinutes).
        dailyAccumulatedMinutes: breakDayBaseMinutes(userData?.breakState, issuedAt),
        lastDate: getLithuanianDateString(new Date(issuedAt)),
        resumableTaskIds: pausedTaskId ? [pausedTaskId] : (userData?.breakState?.resumableTaskIds || []),
    },
    callState: {
        ...(userData?.callState || {}),
        isCalling: false,
    },
    quickWorkState: {
        ...(userData?.quickWorkState || {}),
        isQuickWorking: false,
    },
    workStatus: {
        ...(userData?.workStatus || {}),
        isWorking: false,
        status: 'paused',
        activeTaskId: pausedTaskId || userData?.workStatus?.activeTaskId || null,
        lastUpdated: issuedAt,
    },
});

const idleProjectionAfterBreak = (userData, creditedMinutes, issuedAt) => ({
    activeSession: null,
    breakState: {
        ...(userData?.breakState || {}),
        isTakingBreak: false,
        // A break is bucketed by the day it ENDS — the same day its break_sessions row carries — so
        // one that runs past midnight lands wholly in the new day and re-dates the field with it.
        dailyAccumulatedMinutes:
            breakDayBaseMinutes(userData?.breakState, issuedAt) + creditedMinutes,
        lastDate: getLithuanianDateString(new Date(issuedAt)),
    },
    workStatus: {
        ...(userData?.workStatus || {}),
        isWorking: false,
        status: 'idle',
        activeTaskId: null,
        lastUpdated: issuedAt,
    },
});

// `task` may be NULL when the run's task document no longer exists (it was hard-deleted while the
// timer ran). That case must still be closeable: the ledger row is what carries the credited time,
// and the rules' taskCloseLedgerBound() REQUIRES work_sessions/sess_run_{runId} in the same batch
// for any task-run close — so an orphaned run without this row could never be settled by anyone, and
// the worker would stay permanently "live". We therefore write the ledger from the RUN itself (which
// carries taskId/taskTitle/startedAt) and simply skip the tasks/{id} projection update that has no
// target. Nothing else changes: a normal close still updates both.
function closeTaskWrites({ task, run, endedAt, userId }) {
    if (!run?.runId || !run?.startedAt || !(task?.id || run?.taskId)) {
        throw new Error('A stable run (and its task reference) is required to close a timer');
    }

    const start = new Date(run.startedAt);
    const end = new Date(endedAt);
    const durationMinutes = clampSessionMinutes((end - start) / 60000);
    const ledgerId = `sess_run_${run.runId}`;
    const taskId = task?.id || run.taskId;
    const writes = [];

    if (task?.id) {
        writes.push({
            type: 'update',
            path: `tasks/${task.id}`,
            data: {
                timerStatus: 'paused',
                timerStartedAt: null,
                timerMinutes: Number(task.timerMinutes || 0) + durationMinutes,
                manualMinutes: Number(task.manualMinutes || 0),
                updatedAt: endedAt,
                timerProjectionVersion: TIMER_ENGINE_VERSION,
            },
        });
    }

    writes.push({
        type: 'set',
        path: `work_sessions/${ledgerId}`,
        data: {
            taskId,
            taskTitle: task?.title || run.taskTitle || 'Nežinoma užduotis',
            userId,
            userName: task?.assignedUserName || null,
            runId: run.runId,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            durationMinutes,
            date: getLithuanianDateString(end),
            createdAt: endedAt,
            ...(task?.id ? {} : { orphanedTaskClose: true }),
            engineVersion: TIMER_ENGINE_VERSION,
        },
        merge: true,
    });

    return { durationMinutes, writes };
}

// Re-check the shared nesting rule at COMMIT time. The button that issued this command consulted the
// same rule, but against a snapshot another device may since have moved on from — so this is the
// guard that actually keeps a forbidden stack out of canonical state, not a duplicated policy.
function assertNestingAllowed(interrupted, nextType) {
    const verdict = evaluateSecondaryStart(interrupted, nextType);
    if (verdict.allowed) return;
    if (verdict.code === 'same-type') {
        throw Object.assign(new Error(`A ${nextType} session is already running`), {
            code: 'timer/already-running',
        });
    }
    if (verdict.code === 'stack-full') {
        throw Object.assign(new Error('Too many sessions are already stacked'), {
            code: 'timer/stack-full',
        });
    }
    throw Object.assign(new Error('This secondary switch is not supported yet'), {
        code: 'timer/conflict',
    });
}

function baseCommand({ kind, userId, base, commandId, runId, issuedAt }) {
    if (!userId || !commandId || !issuedAt) {
        throw new Error('Timer commands require userId, commandId, and issuedAt');
    }
    return {
        commandId,
        userId,
        kind,
        issuedAt,
        expectedRevision: base.revision,
        expectedRunId: base.run?.runId || null,
        runId: runId || base.run?.runId || null,
    };
}

export function planTaskStart({
    task,
    userId,
    userData,
    activeRecord: currentRecord,
    previousTask = null,
    previousTaskMissing = false,
    commandId,
    runId,
    issuedAt,
}) {
    if (!task?.id || !runId) {
        throw new Error('Task start requires a task and a new runId');
    }

    const base = canonicalSessionState(currentRecord, { ...userData, id: userId });
    if (base.status === 'active' && base.run?.type !== 'task') {
        throw Object.assign(new Error('A secondary session is active'), { code: 'timer/conflict' });
    }
    // Switching tasks needs the outgoing task doc so its credited minutes can be updated in the same
    // batch — unless that document is PROVABLY gone (hard-deleted or archived mid-run), which the
    // caller signals explicitly. closeTaskWrites already reconstructs the ledger row from the run
    // itself in that case; refusing instead left the worker unable to start ANY task while the
    // orphaned run kept accruing, with no way out from the app.
    if (base.status === 'active' && base.run?.taskId !== task.id && !previousTask && !previousTaskMissing) {
        throw Object.assign(new Error('The active task must be supplied for an atomic switch'), {
            code: 'timer/missing-active-task',
        });
    }

    const command = baseCommand({
        kind: task.timerStatus === 'paused' ? 'resume-task' : 'start-task',
        userId,
        base,
        commandId,
        runId,
        issuedAt,
    });
    const revision = base.revision + 1;
    const run = {
        runId,
        type: 'task',
        taskId: task.id,
        taskTitle: task.title || 'Užduotis',
        startedAt: issuedAt,
        revision,
    };
    const writes = [];

    if (base.status === 'active' && base.run?.runId) {
        if (base.run.taskId === task.id) {
            throw Object.assign(new Error('This task is already running'), {
                code: 'timer/already-running',
            });
        }
        writes.push(...closeTaskWrites({
            task: previousTask,
            run: base.run,
            endedAt: issuedAt,
            userId,
        }).writes);
    }

    writes.push(
        {
            type: 'set',
            path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
            data: activeRecord({ command, revision, status: 'active', run }),
        },
        {
            type: 'update',
            path: `tasks/${task.id}`,
            data: {
                timerStatus: 'running',
                timerStartedAt: issuedAt,
                timerLastHeartbeat: issuedAt,
                // Claim the run for THIS app instance, exactly as the legacy startTask does. Without
                // it useTaskHeartbeat falls back to its pre-ownership proxy (start ≥ boot time),
                // which stops being true the moment the app reloads — the run then goes unbeaten,
                // reads as abandoned, and the nightly net credits only up to the last beat.
                timerOwnerInstance: APP_INSTANCE_ID,
                startedAt: task.startedAt || issuedAt,
                status: 'in-progress',
                updatedAt: issuedAt,
                timerRunId: runId,
                timerRevision: revision,
            },
        },
        {
            type: 'update',
            path: `users/${userId}`,
            data: legacyRunningProjection(task, run, issuedAt),
        },
        commandWrite(command, revision),
    );

    return { command, writes };
}

export function planTaskPause({
    task,
    userId,
    userData,
    activeRecord: currentRecord,
    commandId,
    issuedAt,
    taskUpdates = null,
}) {
    const base = canonicalSessionState(currentRecord, { ...userData, id: userId });
    if (
        base.status !== 'active'
        || base.run?.type !== 'task'
        || base.run?.taskId !== task?.id
    ) {
        throw Object.assign(new Error('The task run is no longer active'), {
            code: 'timer/conflict',
        });
    }

    const command = baseCommand({
        kind: 'pause-task',
        userId,
        base,
        commandId,
        issuedAt,
    });
    const revision = base.revision + 1;
    const closed = closeTaskWrites({
        task,
        run: base.run,
        endedAt: issuedAt,
        userId,
    });
    const closedWrites = closed.writes.map((write) => {
        if (taskUpdates && write.path === `tasks/${task.id}`) {
            return {
                ...write,
                data: {
                    ...write.data,
                    ...taskUpdates,
                },
            };
        }
        return write;
    });

    return {
        command,
        creditedMinutes: closed.durationMinutes,
        writes: [
            ...closedWrites,
            {
                type: 'set',
                path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
                data: activeRecord({ command, revision, status: 'idle', run: null }),
            },
            {
                type: 'update',
                path: `users/${userId}`,
                data: {
                    activeSession: null,
                    workStatus: {
                        isWorking: false,
                        status: 'paused',
                        activeTaskId: task.id,
                        lastUpdated: issuedAt,
                    },
                },
            },
            commandWrite(command, revision),
        ],
    };
}

export function planBreakStart({
    userId,
    userData,
    activeRecord: currentRecord,
    currentTask = null,
    currentTaskMissing = false,
    commandId,
    runId,
    issuedAt,
}) {
    if (!runId) throw new Error('Break start requires a new runId');

    const base = canonicalSessionState(currentRecord, { ...userData, id: userId });
    const interrupted = base.status === 'active' ? base.run : null;
    assertNestingAllowed(interrupted, 'break');
    // See planTaskStart: a PROVABLY deleted/archived task must not block the switch — the ledger row
    // is rebuilt from the run — while a merely unreadable one still must.
    if (interrupted?.type === 'task' && !currentTask && !currentTaskMissing) {
        throw Object.assign(new Error('The active task must be supplied for a break switch'), {
            code: 'timer/missing-active-task',
        });
    }

    const command = baseCommand({
        kind: 'start-break',
        userId,
        base,
        commandId,
        runId,
        issuedAt,
    });
    const revision = base.revision + 1;
    const pausedSession = interrupted ? runToPausedSession(interrupted) : null;
    const run = {
        runId,
        type: 'break',
        startedAt: issuedAt,
        revision,
        pausedSession,
    };
    const writes = [];

    // A break may now interrupt a CALL or QUICK WORK, not just a task. Whatever it interrupts is
    // banked through its own normal closer (closeSecondaryWrites) and nested underneath, so the
    // interrupted session resumes as a fresh run when the break ends.
    if (interrupted?.type === 'task') {
        writes.push(...closeTaskWrites({
            task: currentTask,
            run: interrupted,
            endedAt: issuedAt,
            userId,
        }).writes);
    } else if (interrupted) {
        writes.push(...closeSecondaryWrites({
            userId,
            userData,
            run: interrupted,
            endedAt: issuedAt,
        }).writes);
    }

    writes.push(
        {
            type: 'set',
            path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
            data: activeRecord({ command, revision, status: 'active', run }),
        },
        {
            type: 'update',
            path: `users/${userId}`,
            data: breakRunningProjection(userData, run, issuedAt, pausedTaskIdOf(pausedSession)),
        },
        commandWrite(command, revision),
    );

    return { command, writes };
}

// `creditUntil` separates WHEN the interval stopped from WHEN this command was issued. They are the
// same for a normal stop (the default), but crash recovery must credit only up to the session's last
// pre-boot proof of life while issuing the command NOW — otherwise reopening the app hours later
// credits the whole dead gap as break/call/work, the exact over-credit the legacy recovery path
// already avoids via its heartbeat lookup. Passing it keeps the revisioned engine from regressing
// that at cutover.
export function planBreakEnd({
    userId,
    userData,
    activeRecord: currentRecord,
    restoreTask = null,
    commandId,
    runId = null,
    issuedAt,
    creditUntil = null,
    skipRestore = false,
}) {
    const base = canonicalSessionState(currentRecord, { ...userData, id: userId });
    if (base.status !== 'active' || base.run?.type !== 'break') {
        throw Object.assign(new Error('The break run is no longer active'), {
            code: 'timer/conflict',
        });
    }

    // skipRestore: end straight to IDLE and leave whatever this break had paused alone — the same
    // contract planSecondaryEnd carries, and now REQUIRED here rather than merely symmetric: a break
    // can nest a call/quick work underneath, and crash recovery has no live worker at boot to hand a
    // resumed session back to, so restoring one would silently start a timer nobody is watching.
    const paused = skipRestore ? null : (base.run.pausedSession || null);
    const restoresTask = paused?.type === 'task';
    const restoresSecondary = isSecondaryRunType(paused?.type);
    if (paused?.type && !restoresTask && !restoresSecondary) {
        throw Object.assign(new Error('This nested break restore is not supported yet'), {
            code: 'timer/conflict',
        });
    }
    if (restoresTask && restoreTask?.id !== paused.taskId) {
        throw Object.assign(new Error('The task to restore does not match the paused session'), {
            code: 'timer/conflict',
        });
    }
    if ((restoresTask || restoresSecondary) && !runId) {
        throw new Error('Restoring a session after a break requires a new runId');
    }

    const startedAt = new Date(base.run.startedAt);
    const endedAt = new Date(creditUntil || issuedAt);
    const durationMinutes = clampSessionMinutes((endedAt - startedAt) / 60000);

    const command = baseCommand({
        kind: 'end-session',
        userId,
        base,
        commandId,
        runId: (restoresTask || restoresSecondary) ? runId : base.run.runId,
        issuedAt,
    });
    const revision = base.revision + 1;
    const writes = [];

    if (durationMinutes > MIN_LOGGED_SESSION_MINUTES) {
        writes.push({
            type: 'set',
            path: `break_sessions/sess_break_run_${base.run.runId}`,
            data: {
                userId,
                userName: userData?.displayName || null,
                runId: base.run.runId,
                startTime: startedAt.toISOString(),
                endTime: endedAt.toISOString(),
                durationMinutes,
                date: getLithuanianDateString(endedAt),
                createdAt: issuedAt,
                completedAt: endedAt.toISOString(),
                isBreak: true,
                engineVersion: TIMER_ENGINE_VERSION,
            },
            merge: MERGE_OVER_SERVER_STAMP,
        });
    }

    if (restoresTask) {
        const nextRun = {
            runId,
            type: 'task',
            taskId: restoreTask.id,
            taskTitle: restoreTask.title || paused?.taskTitle || 'Užduotis',
            startedAt: issuedAt,
            revision,
        };
        writes.push(
            {
                type: 'set',
                path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
                data: activeRecord({ command, revision, status: 'active', run: nextRun }),
            },
            {
                type: 'update',
                path: `tasks/${restoreTask.id}`,
                data: {
                    timerStatus: 'running',
                    timerStartedAt: issuedAt,
                    timerLastHeartbeat: issuedAt,
                    startedAt: restoreTask.startedAt || issuedAt,
                    status: 'in-progress',
                    updatedAt: issuedAt,
                    timerRunId: runId,
                    timerRevision: revision,
                },
            },
            {
                type: 'update',
                path: `users/${userId}`,
                data: {
                    activeSession: {
                        type: 'task',
                        startTime: nextRun.startedAt,
                        taskId: restoreTask.id,
                        taskTitle: restoreTask.title || 'Užduotis',
                        runId: nextRun.runId,
                        revision: nextRun.revision,
                    },
                    breakState: {
                        ...(userData?.breakState || {}),
                        isTakingBreak: false,
                        dailyAccumulatedMinutes:
                            breakDayBaseMinutes(userData?.breakState, issuedAt) + durationMinutes,
                        lastDate: getLithuanianDateString(new Date(issuedAt)),
                    },
                    callState: {
                        ...(userData?.callState || {}),
                        isCalling: false,
                    },
                    quickWorkState: {
                        ...(userData?.quickWorkState || {}),
                        isQuickWorking: false,
                    },
                    workStatus: {
                        isWorking: true,
                        status: 'running',
                        activeTaskId: restoreTask.id,
                        lastUpdated: issuedAt,
                    },
                },
            },
            commandWrite(command, revision),
        );
    } else if (restoresSecondary) {
        // Pop the call/quick work this break was taken on top of. It resumes as a FRESH run —
        // its pre-break stretch was already banked when the break started — and inherits whatever
        // it in turn had paused, so the task at the bottom of the stack is not lost.
        const nextRun = {
            runId,
            type: paused.type,
            startedAt: issuedAt,
            revision,
            pausedSession: paused.pausedSession || null,
        };
        writes.push(
            {
                type: 'set',
                path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
                data: activeRecord({ command, revision, status: 'active', run: nextRun }),
            },
            {
                type: 'update',
                path: `users/${userId}`,
                // The break just closed is folded into the day counter by the projection itself,
                // exactly as the idle path below does — a resumed session must not lose those
                // minutes just because it did not pass through idle.
                data: secondaryRunningProjection(userData, nextRun, issuedAt, durationMinutes),
            },
            commandWrite(command, revision),
        );
    } else {
        writes.push(
            {
                type: 'set',
                path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
                data: activeRecord({ command, revision, status: 'idle', run: null }),
            },
            {
                type: 'update',
                path: `users/${userId}`,
                data: idleProjectionAfterBreak(userData, durationMinutes, issuedAt),
            },
            commandWrite(command, revision),
        );
    }

    return {
        command,
        creditedMinutes: durationMinutes,
        restoredTaskRunId: restoresTask ? runId : null,
        restoredRunId: (restoresTask || restoresSecondary) ? runId : null,
        writes,
    };
}

export function planSecondaryStart({
    type,
    userId,
    userData,
    activeRecord: currentRecord,
    currentTask = null,
    currentTaskMissing = false,
    commandId,
    runId,
    issuedAt,
}) {
    if (!['call', 'quickWork'].includes(type)) {
        throw new Error('Secondary start supports call and quickWork');
    }
    if (!runId) throw new Error('Secondary start requires a new runId');

    const base = canonicalSessionState(currentRecord, { ...userData, id: userId });
    const interrupted = base.status === 'active' ? base.run : null;
    assertNestingAllowed(interrupted, type);
    // See planTaskStart: a PROVABLY deleted/archived task must not block the switch — the ledger row
    // is rebuilt from the run — while a merely unreadable one still must.
    if (interrupted?.type === 'task' && !currentTask && !currentTaskMissing) {
        throw Object.assign(new Error('The active task must be supplied for a secondary switch'), {
            code: 'timer/missing-active-task',
        });
    }

    const command = baseCommand({
        kind: type === 'call' ? 'start-call' : 'start-quick-work',
        userId,
        base,
        commandId,
        runId,
        issuedAt,
    });
    const revision = base.revision + 1;
    const pausedSession = interrupted ? runToPausedSession(interrupted) : null;
    const run = {
        runId,
        type,
        startedAt: issuedAt,
        revision,
        pausedSession,
    };
    const writes = [];
    let closedBreakMinutes = 0;

    // Any interrupted session — task, break, call or quick work — is banked through its own normal
    // closer and nested underneath. Only `break` contributes to the day's break counter, which is
    // why its minutes ride out separately into the projection below.
    if (interrupted?.type === 'task') {
        writes.push(...closeTaskWrites({
            task: currentTask,
            run: interrupted,
            endedAt: issuedAt,
            userId,
        }).writes);
    } else if (interrupted) {
        const closed = closeSecondaryWrites({
            userId,
            userData,
            run: interrupted,
            endedAt: issuedAt,
        });
        closedBreakMinutes = closed.breakMinutes;
        writes.push(...closed.writes);
    }

    writes.push(
        {
            type: 'set',
            path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
            data: activeRecord({ command, revision, status: 'active', run }),
        },
        {
            type: 'update',
            path: `users/${userId}`,
            data: secondaryRunningProjection(userData, run, issuedAt, closedBreakMinutes),
        },
        commandWrite(command, revision),
    );

    return { command, writes, closedBreakMinutes };
}

function callLogWrites({ userId, userData, run, endedAt, durationMinutes, contactType, callNotes }) {
    const start = new Date(run.startedAt);
    const end = new Date(endedAt);
    const startMs = start.getTime();
    const callTitle = buildCallTitle(contactType || null);
    const notes = (callNotes || '').trim();
    const description = notes ? `${notes}\n${clockTime(end)}` : clockTime(end);
    return [
        {
            type: 'set',
            path: `tasks/sess_call_task_${userId}_${startMs}`,
            data: {
                title: callTitle,
                description,
                contactType: contactType || null,
                status: 'confirmed',
                priority: DEFAULT_PRIORITY,
                assignedUserId: userId,
                assignedUserName: userData?.displayName || 'Nežinomas',
                createdBy: userId,
                creatorName: userData?.displayName || 'Nežinomas',
                createdAt: endedAt,
                completedAt: endedAt,
                completed: true,
                confirmedBy: userId,
                confirmedAt: endedAt,
                manualMinutes: durationMinutes,
                isSystemTask: true,
                engineVersion: TIMER_ENGINE_VERSION,
            },
            merge: MERGE_OVER_SERVER_STAMP,
        },
        {
            type: 'set',
            path: `work_sessions/sess_call_ws_${userId}_${startMs}`,
            data: {
                taskId: `call_${end.getTime()}`,
                taskTitle: callTitle,
                contactType: contactType || null,
                userId,
                userName: userData?.displayName || 'Nežinomas',
                startTime: start.toISOString(),
                endTime: end.toISOString(),
                durationMinutes,
                date: getLithuanianDateString(end),
                createdAt: endedAt,
                isSystemTask: true,
                engineVersion: TIMER_ENGINE_VERSION,
            },
            merge: MERGE_OVER_SERVER_STAMP,
        },
    ];
}

function quickWorkLogWrites({
    userId,
    userData,
    run,
    endedAt,
    durationMinutes,
    customTitle,
    customComment,
    auditorManagerId,
}) {
    const start = new Date(run.startedAt);
    const end = new Date(endedAt);
    const startMs = start.getTime();
    const autoStopped = !customTitle;
    const title = customTitle || 'Greita veikla (Automatiškai išsaugota)';
    const comment = (customComment || '').trim();
    const description = customTitle
        ? (comment ? `${comment}\n${clockTime(end)}` : clockTime(end))
        : `${clockTime(end)} (Automatiškai sukurtas)`;
    const manager = isManagerRole(userData?.role);
    const routedManagerId = manager
        ? null
        : (auditorManagerId || userData?.defaultManager || null);
    const taskId = `sess_qw_task_${userId}_${startMs}`;
    const sessionId = `sess_qw_ws_${userId}_${startMs}`;

    return {
        taskId,
        sessionId,
        routedManagerId,
        autoStopped,
        writes: [
            {
                type: 'set',
                path: `tasks/${taskId}`,
                data: {
                    title,
                    description,
                    status: manager ? 'confirmed' : 'completed',
                    priority: DEFAULT_PRIORITY,
                    assignedUserId: userId,
                    assignedUserName: userData?.displayName || 'Nežinomas',
                    createdBy: userId,
                    creatorName: userData?.displayName || 'Nežinomas',
                    createdAt: endedAt,
                    completedAt: endedAt,
                    completed: true,
                    confirmedBy: manager ? userId : null,
                    confirmedAt: manager ? endedAt : null,
                    taskAuditor: routedManagerId,
                    managerId: routedManagerId,
                    manualMinutes: durationMinutes,
                    isQuickWork: true,
                    autoStopped,
                    workSessionId: sessionId,
                    engineVersion: TIMER_ENGINE_VERSION,
                },
                merge: MERGE_OVER_SERVER_STAMP,
            },
            {
                type: 'set',
                path: `work_sessions/${sessionId}`,
                data: {
                    taskId: `quick_${end.getTime()}`,
                    taskTitle: title,
                    userId,
                    userName: userData?.displayName || 'Nežinomas',
                    startTime: start.toISOString(),
                    endTime: end.toISOString(),
                    durationMinutes,
                    date: getLithuanianDateString(end),
                    createdAt: endedAt,
                    isQuickWork: true,
                    engineVersion: TIMER_ENGINE_VERSION,
                },
                merge: MERGE_OVER_SERVER_STAMP,
            },
        ],
    };
}

const idleProjectionAfterSecondary = (userData, type, issuedAt) => ({
    activeSession: null,
    breakState: {
        ...(userData?.breakState || {}),
        isTakingBreak: false,
    },
    callState: {
        ...(userData?.callState || {}),
        isCalling: false,
    },
    quickWorkState: {
        ...(userData?.quickWorkState || {}),
        isQuickWorking: false,
    },
    workStatus: {
        ...(userData?.workStatus || {}),
        isWorking: false,
        status: 'idle',
        activeTaskId: null,
        lastUpdated: issuedAt,
    },
    [secondaryStateKeyFor(type)]: {
        ...(userData?.[secondaryStateKeyFor(type)] || {}),
        [secondaryFlagFor(type)]: false,
    },
});

export function planSecondaryEnd({
    type,
    userId,
    userData,
    activeRecord: currentRecord,
    restoreTask = null,
    commandId,
    runId = null,
    issuedAt,
    discard = false,
    contactType = null,
    callNotes = '',
    customTitle = '',
    customComment = '',
    auditorManagerId = null,
    creditUntil = null, // see planBreakEnd — credit boundary, distinct from the command's issuedAt
    skipRestore = false,
}) {
    if (!['call', 'quickWork'].includes(type)) {
        throw new Error('Secondary end supports call and quickWork');
    }

    const base = canonicalSessionState(currentRecord, { ...userData, id: userId });
    if (base.status !== 'active' || base.run?.type !== type) {
        throw Object.assign(new Error('The secondary run is no longer active'), {
            code: 'timer/conflict',
        });
    }

    // skipRestore: end straight to IDLE and leave whatever this session had paused alone. Crash
    // recovery needs it — there is no live worker at boot to hand a resumed task/break back to, so
    // restoring one would silently start a timer nobody is watching. Mirrors the legacy closer's
    // skipResume argument, which the revisioned path must match to avoid regressing at cutover.
    const paused = skipRestore ? null : (base.run.pausedSession || null);
    const restoresTask = paused?.type === 'task';
    const restoresSecondary = isSecondaryRunType(paused?.type);
    if (paused?.type && !restoresTask && !restoresSecondary) {
        throw Object.assign(new Error('This nested secondary restore is not supported yet'), {
            code: 'timer/conflict',
        });
    }
    if (restoresTask && restoreTask?.id !== paused.taskId) {
        throw Object.assign(new Error('The task to restore does not match the paused session'), {
            code: 'timer/conflict',
        });
    }
    if ((restoresTask || restoresSecondary) && !runId) {
        throw new Error('Restoring a session requires a new runId');
    }

    const startedAt = new Date(base.run.startedAt);
    const endedAt = new Date(creditUntil || issuedAt);
    const durationMinutes = clampSessionMinutes((endedAt - startedAt) / 60000);
    const command = baseCommand({
        kind: 'end-session',
        userId,
        base,
        commandId,
        runId: (restoresTask || restoresSecondary) ? runId : base.run.runId,
        issuedAt,
    });
    const revision = base.revision + 1;
    const writes = [];
    let loggedQuickWork = null;

    if (!discard) {
        if (type === 'call') {
            writes.push(...callLogWrites({
                userId,
                userData,
                run: base.run,
                endedAt: endedAt.toISOString(),
                durationMinutes,
                contactType,
                callNotes,
            }));
        } else if (durationMinutes > MIN_LOGGED_SESSION_MINUTES) {
            loggedQuickWork = quickWorkLogWrites({
                userId,
                userData,
                run: base.run,
                endedAt: endedAt.toISOString(),
                durationMinutes,
                customTitle,
                customComment,
                auditorManagerId,
            });
            writes.push(...loggedQuickWork.writes);
        }
    }

    if (restoresTask) {
        const nextRun = {
            runId,
            type: 'task',
            taskId: restoreTask.id,
            taskTitle: restoreTask.title || paused.taskTitle || 'Užduotis',
            startedAt: issuedAt,
            revision,
        };
        writes.push(
            {
                type: 'set',
                path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
                data: activeRecord({ command, revision, status: 'active', run: nextRun }),
            },
            {
                type: 'update',
                path: `tasks/${restoreTask.id}`,
                data: {
                    timerStatus: 'running',
                    timerStartedAt: issuedAt,
                    timerLastHeartbeat: issuedAt,
                    startedAt: restoreTask.startedAt || issuedAt,
                    status: 'in-progress',
                    updatedAt: issuedAt,
                    timerRunId: runId,
                    timerRevision: revision,
                },
            },
            {
                type: 'update',
                path: `users/${userId}`,
                data: {
                    activeSession: {
                        type: 'task',
                        startTime: nextRun.startedAt,
                        taskId: restoreTask.id,
                        taskTitle: restoreTask.title || 'Užduotis',
                        runId: nextRun.runId,
                        revision: nextRun.revision,
                    },
                    breakState: {
                        ...(userData?.breakState || {}),
                        isTakingBreak: false,
                    },
                    callState: {
                        ...(userData?.callState || {}),
                        isCalling: false,
                    },
                    quickWorkState: {
                        ...(userData?.quickWorkState || {}),
                        isQuickWorking: false,
                    },
                    workStatus: {
                        isWorking: true,
                        status: 'running',
                        activeTaskId: restoreTask.id,
                        lastUpdated: issuedAt,
                    },
                },
            },
            commandWrite(command, revision),
        );
    } else if (restoresSecondary) {
        // Pop whatever secondary sat underneath — break, call or quick work. It resumes as a FRESH
        // run (its pre-interruption stretch was banked when this session started) and inherits its
        // own paused stack, so nothing below is lost.
        const nextRun = {
            runId,
            type: paused.type,
            startedAt: issuedAt,
            revision,
            pausedSession: paused.pausedSession || null,
        };
        writes.push(
            {
                type: 'set',
                path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
                data: activeRecord({ command, revision, status: 'active', run: nextRun }),
            },
            {
                type: 'update',
                path: `users/${userId}`,
                data: secondaryRunningProjection(userData, nextRun, issuedAt, 0),
            },
            commandWrite(command, revision),
        );
    } else {
        writes.push(
            {
                type: 'set',
                path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
                data: activeRecord({ command, revision, status: 'idle', run: null }),
            },
            {
                type: 'update',
                path: `users/${userId}`,
                data: idleProjectionAfterSecondary(userData, type, issuedAt),
            },
            commandWrite(command, revision),
        );
    }

    return {
        command,
        creditedMinutes: durationMinutes,
        createdTaskId: loggedQuickWork?.taskId || (type === 'call'
            ? `sess_call_task_${userId}_${startedAt.getTime()}`
            : null),
        workSessionId: loggedQuickWork?.sessionId || (type === 'call'
            ? `sess_call_ws_${userId}_${startedAt.getTime()}`
            : null),
        quickWorkNotification: loggedQuickWork && loggedQuickWork.routedManagerId && !loggedQuickWork.autoStopped
            ? {
                recipientId: loggedQuickWork.routedManagerId,
                taskId: loggedQuickWork.taskId,
                taskTitle: customTitle,
                actualMinutes: durationMinutes,
            }
            : null,
        restoredRunId: (restoresTask || restoresSecondary) ? runId : null,
        writes,
    };
}

export function planManagerForceEnd({
    targetUser,
    actorId,
    activeRecord: currentRecord,
    activeTask = null,
    commandId,
    issuedAt,
}) {
    if (!targetUser?.id || !actorId) {
        throw new Error('Manager force-end requires a target user and actor');
    }

    const base = canonicalSessionState(currentRecord, { ...targetUser, id: targetUser.id });
    if (base.status !== 'active') {
        throw Object.assign(new Error('No canonical session is active'), {
            code: 'timer/no-active-session',
        });
    }
    // A task run whose task document is GONE is precisely the state a manager force-end must be able
    // to clear (see closeTaskWrites): refusing it here left the worker permanently live with no
    // route out of any UI. The run itself still carries taskId/taskTitle/startedAt, which is all the
    // ledger row needs. `activeTask` therefore stays OPTIONAL — supplied for a normal force-end,
    // null for an orphaned one.
    if (base.run?.type === 'task' && !activeTask && !base.run?.taskId) {
        throw Object.assign(new Error('The active task run carries no task reference'), {
            code: 'timer/missing-active-task',
        });
    }

    // What this force-end DISCARDS. A session can now be a stack (call ← break ← task), and this
    // control deliberately ends the whole thing to idle rather than unwinding one layer: its entire
    // purpose is to settle a worker who is stuck live, and popping one layer would leave them still
    // live — now on a break nobody is watching, which is exactly the unattended-timer failure
    // `skipRestore` exists to prevent on the recovery path.
    //
    // No TIME is lost by discarding: every session below the top run was banked and credited the
    // moment it was interrupted, so nothing underneath is accruing. What is lost is the worker's
    // RETURN PATH — their break and their task simply vanish from the app. So the planner reports
    // what it dropped, and the caller tells the worker (sessionAdmin.endSessionForUser). It cannot
    // be told here: this is a pure planner, and a recovery notice would be the wrong carrier anyway
    // — those are localStorage, written on the device where recovery ran, and a force-end runs on
    // the MANAGER's device.
    const discardedStack = pausedSessionStack(base.run).map((node) => ({
        type: node.type,
        ...(node.taskId ? { taskId: node.taskId } : {}),
        ...(node.taskTitle ? { taskTitle: node.taskTitle } : {}),
    }));

    const command = {
        ...baseCommand({
            kind: 'force-end-session',
            userId: targetUser.id,
            base,
            commandId,
            issuedAt,
        }),
        actorId,
    };
    const revision = base.revision + 1;
    const writes = [];
    let creditedMinutes = 0;
    // null = this force-end closed no break, so the day counter must be left ALONE. 0 is a real
    // value (a sub-minute break still re-dates the counter), which is why this is not initialised to 0.
    let closedBreakMinutes = null;

    // EVERY run type must leave a record of the interval the manager just closed. Only the task
    // branch used to write one: a force-ended call or quick-work moved canonical state straight to
    // idle and cleared the projections, so the worker's payable minutes vanished with no trace
    // anywhere — a manager's *recovery* action silently destroying pay (audit T-18). Call and
    // quick-work reuse the SAME deterministic ledger writers the normal close uses, so a force-ended
    // session is indistinguishable downstream from a worker-ended one. Quick work has no title at
    // force-end time, so quickWorkLogWrites' auto-stopped placeholder is used and the worker can
    // describe it afterwards — exactly how their own auto-stop already behaves.
    if (base.run?.type === 'task') {
        const closed = closeTaskWrites({
            task: activeTask,
            run: base.run,
            endedAt: issuedAt,
            userId: targetUser.id,
        });
        creditedMinutes = closed.durationMinutes;
        writes.push(...closed.writes);
    } else if (base.run?.type === 'call' || base.run?.type === 'quickWork') {
        const startedAt = new Date(base.run.startedAt);
        const endedAt = new Date(issuedAt);
        creditedMinutes = clampSessionMinutes((endedAt - startedAt) / 60000);
        if (base.run.type === 'call') {
            writes.push(...callLogWrites({
                userId: targetUser.id,
                userData: targetUser,
                run: base.run,
                endedAt: issuedAt,
                durationMinutes: creditedMinutes,
                contactType: null,
                callNotes: '',
            }));
        } else if (creditedMinutes > MIN_LOGGED_SESSION_MINUTES) {
            writes.push(...quickWorkLogWrites({
                userId: targetUser.id,
                userData: targetUser,
                run: base.run,
                endedAt: issuedAt,
                durationMinutes: creditedMinutes,
                customTitle: '',
                customComment: '',
                auditorManagerId: null,
            }).writes);
        }
    } else if (base.run?.type === 'break') {
        // The break arm of T-18, unblocked by the matching firestore.rules change (break_sessions
        // create now carries the same manager branches work_sessions has). It writes through the very
        // same closeBreakWrites the worker's own end uses, so a force-ended break is indistinguishable
        // downstream from a self-ended one — same deterministic `sess_break_run_` id, so a replay or a
        // nightly net closing the same run can never mint a second row.
        const closed = closeBreakWrites({
            userId: targetUser.id,
            userData: targetUser,
            run: base.run,
            endedAt: issuedAt,
        });
        // NOT added to creditedMinutes: that number is the PAYABLE time this settle credited, and a
        // break is unpaid. It is banked into the day's break counter below instead.
        closedBreakMinutes = closed.durationMinutes;
        writes.push(...closed.writes);
    }

    writes.push(
        {
            type: 'set',
            path: `${TIMER_ACTIVE_COLLECTION}/${targetUser.id}`,
            data: activeRecord({ command, revision, status: 'idle', run: null }),
        },
        {
            type: 'update',
            path: `users/${targetUser.id}`,
            data: {
                activeSession: null,
                workStatus: {
                    ...(targetUser.workStatus || {}),
                    isWorking: false,
                    status: 'idle',
                    activeTaskId: null,
                    lastUpdated: issuedAt,
                },
                breakState: {
                    ...(targetUser.breakState || {}),
                    isTakingBreak: false,
                    // Bank the force-ended break into the day total, exactly as the worker's own end
                    // does (idleProjectionAfterBreak). Without this the row existed but the allowance
                    // the app reads never saw those minutes, so the same break was silently free.
                    // Total and date are written as ONE pair — see breakDayBaseMinutes.
                    ...(closedBreakMinutes === null ? {} : {
                        dailyAccumulatedMinutes:
                            breakDayBaseMinutes(targetUser.breakState, issuedAt) + closedBreakMinutes,
                        lastDate: getLithuanianDateString(new Date(issuedAt)),
                    }),
                },
                callState: {
                    ...(targetUser.callState || {}),
                    isCalling: false,
                },
                quickWorkState: {
                    ...(targetUser.quickWorkState || {}),
                    isQuickWorking: false,
                },
            },
        },
        commandWrite(command, revision),
    );

    return {
        command,
        creditedMinutes,
        discardedStack,
        writes,
    };
}

export function planTaskRecover({
    task,
    userId,
    userData,
    activeRecord: currentRecord,
    commandId,
    runId,
    issuedAt,
    recoveredAt = issuedAt,
}) {
    if (!task?.id || !runId) {
        throw new Error('Task recovery requires a task and a new runId');
    }

    const base = canonicalSessionState(currentRecord, { ...userData, id: userId });
    if (
        base.status !== 'active'
        || base.run?.type !== 'task'
        || base.run?.taskId !== task.id
    ) {
        throw Object.assign(new Error('The task run is no longer active'), {
            code: 'timer/conflict',
        });
    }

    const oldStart = new Date(base.run.startedAt);
    const recoveryEnd = new Date(recoveredAt);
    if (!Number.isFinite(oldStart.getTime()) || !Number.isFinite(recoveryEnd.getTime())) {
        throw new Error('Task recovery requires valid run boundaries');
    }

    const heartbeatMs = new Date(task.timerLastHeartbeat || '').getTime();
    const hasUsableHeartbeat = Number.isFinite(heartbeatMs)
        && heartbeatMs >= oldStart.getTime()
        && heartbeatMs < recoveryEnd.getTime();
    // How long has this run been UNPROVEN — i.e. how much of it has no heartbeat behind it? This is
    // the same question decideOrphanTaskRecovery asks on the legacy path, and it must get the same
    // answer, because the two engines are crediting the same physical event.
    const unprovenTailMs = hasUsableHeartbeat
        ? recoveryEnd.getTime() - heartbeatMs
        : Number.POSITIVE_INFINITY;

    // A brief interruption: the app reloaded (PWA update, tab eviction, memory pressure) while the
    // worker kept working, and it is demonstrably back now. The whole run is real continuous work,
    // so it is credited in ONE row up to the reload instant and the timer keeps running. Legacy
    // does exactly this (mode 'resume'), and matching matters: canonical previously split every
    // ordinary mid-shift reload into a proven row PLUS a gap row flagged isManualSession — a
    // "manual correction" the worker never made, minted on every reload.
    const briefInterruption = unprovenTailMs <= TIMER_HEARTBEAT_CONTINUE_MS;
    const provenEnd = briefInterruption || !hasUsableHeartbeat
        ? recoveryEnd
        : new Date(heartbeatMs);

    // Clamp the ENTIRE orphaned run (oldStart → recoveryEnd) to ONE MAX_SESSION_MINUTES
    // budget, then PARTITION that single budget between the heartbeat-proven segment and the
    // post-heartbeat gap. Clamping each segment independently (the previous behaviour) let one
    // run credit up to 2×MAX_SESSION_MINUTES — e.g. a heartbeat at 15h and recovery at 30h
    // credited 15h + 15h = 30h, doubling the 16h safety ceiling (audit R-03). The proven segment
    // is credited first (it is the observed-alive portion) and the gap takes only the remainder.
    const totalBudgetMinutes = clampSessionMinutes((recoveryEnd - oldStart) / 60000);
    const provenMinutes = Math.min(
        clampSessionMinutes((provenEnd - oldStart) / 60000),
        totalBudgetMinutes,
    );

    // The gap is measured in REAL WALL CLOCK, then admitted only if it is plausibly one missed
    // stretch of work — the identical test resolveUntrackedGap applies on the legacy path.
    //
    // It used to be `totalBudget - proven`, i.e. whatever was LEFT of the 16h ceiling. That turned
    // every forgotten timer into a maximum payday: start Friday 17:00, heartbeat dies 17:02, worker
    // opens the app Monday 08:00 — a 63-hour absence — and the leftover-budget rule credited 958
    // minutes of "untracked work" nobody did, in a row whose own startTime→endTime span was 63h.
    // Legacy refused that gap outright. Measuring the gap for what it is, and refusing an
    // implausible one, is what makes the two engines agree. The budget cap still applies on top, so
    // the R-03 ceiling above is preserved.
    //
    // "Plausible" is isCreditableUntrackedGap's question, not MAX_SESSION_MINUTES'. Bounding it by
    // the 16h SESSION ceiling meant a timer left running overnight came back crediting 623 minutes
    // of sleep as work (production, 2026-07-27) — under 16h, so it passed. A refusal here is not a
    // discard: `refusedGap` below hands the interval to the opt-IN claim offer instead.
    const realGapMinutes = (recoveryEnd - provenEnd) / 60000;
    const gapIsPlausible = !briefInterruption
        && hasUsableHeartbeat
        && isCreditableUntrackedGap(provenEnd, recoveryEnd);
    const gapMinutes = gapIsPlausible
        ? Math.min(realGapMinutes, Math.max(0, totalBudgetMinutes - provenMinutes))
        : 0;
    const timerMinutes = Number(task.timerMinutes || 0) + provenMinutes + gapMinutes;


    const command = baseCommand({
        kind: 'recover',
        userId,
        base,
        commandId,
        runId,
        issuedAt,
    });
    const revision = base.revision + 1;
    const nextRun = {
        runId,
        type: 'task',
        taskId: task.id,
        taskTitle: task.title || 'Užduotis',
        startedAt: recoveryEnd.toISOString(),
        revision,
    };
    const writes = [
        {
            type: 'set',
            path: `work_sessions/sess_run_${base.run.runId}`,
            data: {
                taskId: task.id,
                taskTitle: task.title || 'Nežinoma užduotis',
                userId,
                userName: task.assignedUserName || null,
                runId: base.run.runId,
                startTime: oldStart.toISOString(),
                endTime: provenEnd.toISOString(),
                durationMinutes: provenMinutes,
                date: getLithuanianDateString(provenEnd),
                createdAt: issuedAt,
                recoveredAt: recoveryEnd.toISOString(),
                engineVersion: TIMER_ENGINE_VERSION,
            },
            merge: true,
        },
    ];

    let recoveredGap = null;
    if (gapMinutes > 0) {
        const sessionId = `sess_gap_run_${base.run.runId}`;
        writes.push({
            type: 'set',
            path: `work_sessions/${sessionId}`,
            data: {
                taskId: task.id,
                taskTitle: task.title || 'Nežinoma užduotis',
                userId,
                userName: task.assignedUserName || null,
                startTime: provenEnd.toISOString(),
                endTime: recoveryEnd.toISOString(),
                durationMinutes: gapMinutes,
                date: getLithuanianDateString(recoveryEnd),
                createdAt: issuedAt,
                createdBy: userId,
                createdByName: task.assignedUserName || null,
                editReason: 'Recovered untracked work after app process termination',
                isManualSession: true,
                isRecoveredGap: true,
                recoveredFromRunId: base.run.runId,
                engineVersion: TIMER_ENGINE_VERSION,
            },
            merge: true,
        });
        recoveredGap = {
            sessionId,
            gapMinutes,
            fromIso: provenEnd.toISOString(),
            toIso: recoveryEnd.toISOString(),
        };
    }

    // A gap we declined to auto-credit is NOT nothing — it is an interval the worker may genuinely
    // have worked through, and dropping it silently is the failure mode this whole recovery path
    // exists to prevent. Report it so the caller can offer the opt-IN claim, exactly as legacy's
    // resolveUntrackedGap does via offerManualClaim. Only a real, measurable interval qualifies:
    // a brief interruption has no gap by definition, and with no usable heartbeat there is no
    // boundary to claim from.
    const refusedGap = (!gapIsPlausible && !briefInterruption && hasUsableHeartbeat
        && realGapMinutes >= MIN_LOGGED_SESSION_MINUTES)
        ? {
            gapMinutes: realGapMinutes,
            fromIso: provenEnd.toISOString(),
            toIso: recoveryEnd.toISOString(),
        }
        : null;

    // Recovery NEVER leaves the timer stopped (ADR 0027). It closes the old run so the proven stretch
    // and any admitted gap are credited, then re-anchors a fresh run from this instant.
    //
    // Why it used to stop, and why that was wrong. The rule was "only a brief interruption keeps
    // running" — three minutes, calibrated for a page reload. But the heartbeat only ticks in the
    // FOREGROUND and iOS discards a backgrounded PWA, so on a phone every return to the app is a cold
    // boot with a beat older than that window. The worker's timer was therefore stopped on EVERY
    // re-open and they had to press start again each time (reported 2026-08-05). Worse, nothing
    // announced the stop, so a worker who did not notice kept working untracked.
    //
    // The app cannot tell "pocketed but working" from "stopped working" — both are just a quiet
    // heartbeat — so it no longer guesses. A running timer means work until the worker stops it; that
    // is the one signal that is unambiguous, and it is theirs to give.
    //
    // Continuing is NOT the same as paying. What may be CREDITED is decided separately and is
    // unchanged: only a gap `isCreditableUntrackedGap` admits (≥1 min, ≤4h, one work day) is
    // auto-credited, everything longer becomes `refusedGap` → the manager's decision (ADR 0025), and
    // the whole run stays under one 16h budget. A forgotten timer therefore still cannot pay itself;
    // it only stays visibly running, where the worker and the server's nets can see it.
    writes.push(
        {
            type: 'set',
            path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
            data: activeRecord({ command, revision, status: 'active', run: nextRun }),
        },
        {
            type: 'update',
            path: `tasks/${task.id}`,
            data: {
                timerStatus: 'running',
                timerStartedAt: recoveryEnd.toISOString(),
                timerLastHeartbeat: recoveryEnd.toISOString(),
                // Claim the re-anchored run for THIS app instance, or the ownership rule in
                // useTaskHeartbeat refuses to beat it and the run looks dead a minute later.
                timerOwnerInstance: APP_INSTANCE_ID,
                timerMinutes,
                manualMinutes: Number(task.manualMinutes || 0),
                status: 'in-progress',
                updatedAt: issuedAt,
                timerRunId: runId,
                timerRevision: revision,
                timerProjectionVersion: TIMER_ENGINE_VERSION,
            },
        },
        {
            type: 'update',
            path: `users/${userId}`,
            data: legacyRunningProjection(task, nextRun, issuedAt),
        },
        commandWrite(command, revision),
    );

    return {
        command,
        creditedMinutes: provenMinutes + gapMinutes,
        resumed: true,
        recoveredGap,
        refusedGap,
        writes,
    };
}

export function planTaskEnd({
    task,
    userId,
    userData,
    activeRecord: currentRecord,
    commandId,
    issuedAt,
    completionStatus = 'completed',
    confirmedBy = null,
}) {
    if (!task?.id) throw new Error('Task end requires a task');

    const base = canonicalSessionState(currentRecord, { ...userData, id: userId });
    // Does the canonical live run belong to THIS task? Only then is finishing a session transition:
    // it closes the run, files its ledger row and hands the worker back to idle.
    //
    // Finishing any OTHER task is pure bookkeeping — the work was done and paused earlier, and the
    // job is only now being handed in. That must NOT disturb whatever is running now (another task's
    // timer, or a break/call/quick-work). This used to throw timer/conflict outright, so a worker with
    // one timer ticking could not hand in a single job they had finished earlier: they had to stop the
    // live timer first — losing time or re-ordering their day around the app (reported 2026-08-04).
    const endsTheLiveRun = base.status === 'active'
        && base.run?.type === 'task'
        && base.run?.taskId === task.id;
    // Something else is live and stays live: leave the canonical record (and its revision) untouched,
    // so this batch can never be read as "the worker stopped working".
    const otherRunStaysLive = base.status === 'active' && !endsTheLiveRun;

    const command = baseCommand({
        kind: 'end-task',
        userId,
        base,
        commandId,
        issuedAt,
    });
    const revision = otherRunStaysLive ? base.revision : base.revision + 1;
    let finalTimerMinutes = Number(task.timerMinutes || 0);
    let closedSessionId = null;
    const writes = [];

    if (endsTheLiveRun) {
        const closed = closeTaskWrites({
            task,
            run: base.run,
            endedAt: issuedAt,
            userId,
        });
        finalTimerMinutes += closed.durationMinutes;
        const ledgerWrite = closed.writes.find((write) =>
            write.path.startsWith('work_sessions/')
        );
        writes.push(ledgerWrite);
        closedSessionId = ledgerWrite.path.split('/')[1];
    }

    const manualMinutes = Number(task.manualMinutes || 0);
    writes.push(
        {
            type: 'update',
            path: `tasks/${task.id}`,
            data: {
                timerStatus: 'paused',
                timerStartedAt: null,
                timerMinutes: finalTimerMinutes,
                manualMinutes,
                actualTime: formatMinutesToTimeString(finalTimerMinutes + manualMinutes),
                status: completionStatus,
                completed: true,
                completedAt: issuedAt,
                confirmedBy,
                confirmedAt: confirmedBy ? issuedAt : null,
                // `timeLimitReached` is deliberately NOT cleared here. It is the flag
                // onTaskFinishedBadge reads on the completed false→true edge to withhold the
                // on_estimate badge from a task that blew its estimate — and this batch IS that
                // edge, so clearing it in the same write made the trigger's `after` never see the
                // limit and granted the badge to every forced limit-popup finish (confirmed live
                // 2026-07-26). The legacy path only got this right by accident: it clears the flag
                // in a SEPARATE later write, after the trigger has already read `true`.
                // Leaving it set is also the honest end state — the limit really was reached — and
                // matches its sibling latch `warningShown70`, which no finish path clears either.
                // Nothing else needs it cleared: useTaskTimeMonitor only evaluates the RUNNING
                // active task (and re-arms the flag itself when time is manually cut), while
                // extendTaskTime and a TaskModal estimate edit both clear it when a grant of more
                // time genuinely re-opens the budget.
                updatedAt: issuedAt,
                timerProjectionVersion: TIMER_ENGINE_VERSION,
            },
        },
        // Idle projections belong ONLY to the finish that actually ends the live run. When another
        // activity keeps running, writing them would stop that activity's clock in the projections
        // while the canonical record still says active — the exact split-brain the engine exists to
        // prevent. The command marker is still written, so the batch stays replay-idempotent.
        ...(otherRunStaysLive ? [] : [
            {
                type: 'set',
                path: `${TIMER_ACTIVE_COLLECTION}/${userId}`,
                data: activeRecord({ command, revision, status: 'idle', run: null }),
            },
            {
                type: 'update',
                path: `users/${userId}`,
                data: {
                    activeSession: null,
                    workStatus: {
                        isWorking: false,
                        status: 'idle',
                        activeTaskId: null,
                        lastUpdated: issuedAt,
                    },
                },
            },
        ]),
        commandWrite(command, revision),
    );

    return {
        command,
        closedSessionId,
        finalTimerMinutes,
        totalMinutes: finalTimerMinutes + manualMinutes,
        writes,
    };
}
