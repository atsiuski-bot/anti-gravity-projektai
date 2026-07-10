import {
    clampSessionMinutes,
    formatMinutesToTimeString,
    getLithuanianDateString,
    MIN_LOGGED_SESSION_MINUTES,
} from './timeUtils';
import { isManagerRole } from './formatters';
import { DEFAULT_PRIORITY } from './priority';
import { buildCallTitle } from './callContacts';

export const TIMER_ENGINE_VERSION = 2;
export const TIMER_ACTIVE_COLLECTION = 'active_sessions';
export const timerCommandPath = (userId, commandId) =>
    `users/${userId}/timer_commands/${commandId}`;

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

const taskPausedSession = (run) => {
    if (!run || run.type !== 'task') return null;
    return {
        type: 'task',
        taskId: run.taskId || null,
        taskTitle: run.taskTitle || null,
        runId: run.runId || null,
        startTime: run.startedAt || null,
    };
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
    const pausedTaskId = run.pausedSession?.type === 'task'
        ? run.pausedSession.taskId
        : (
            run.pausedSession?.type === 'break'
                ? run.pausedSession.pausedSession?.taskId || null
                : null
        );
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
            dailyAccumulatedMinutes:
                Number(userData?.breakState?.dailyAccumulatedMinutes || 0)
                + closedBreakMinutes,
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
        if (run.type === 'break') {
            projection[stateKey].lastDate = getLithuanianDateString(new Date(issuedAt));
        }
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
        });
    }
    return { durationMinutes, writes };
};

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
        dailyAccumulatedMinutes: Number(userData?.breakState?.dailyAccumulatedMinutes || 0),
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
        dailyAccumulatedMinutes:
            Number(userData?.breakState?.dailyAccumulatedMinutes || 0) + creditedMinutes,
    },
    workStatus: {
        ...(userData?.workStatus || {}),
        isWorking: false,
        status: 'idle',
        activeTaskId: null,
        lastUpdated: issuedAt,
    },
});

function closeTaskWrites({ task, run, endedAt, userId }) {
    if (!task?.id || !run?.runId || !run?.startedAt) {
        throw new Error('A running task and stable run are required to close a timer');
    }

    const start = new Date(run.startedAt);
    const end = new Date(endedAt);
    const durationMinutes = clampSessionMinutes((end - start) / 60000);
    const timerMinutes = Number(task.timerMinutes || 0) + durationMinutes;
    const ledgerId = `sess_run_${run.runId}`;

    return {
        durationMinutes,
        writes: [
            {
                type: 'update',
                path: `tasks/${task.id}`,
                data: {
                    timerStatus: 'paused',
                    timerStartedAt: null,
                    timerMinutes,
                    manualMinutes: Number(task.manualMinutes || 0),
                    updatedAt: endedAt,
                    timerProjectionVersion: TIMER_ENGINE_VERSION,
                },
            },
            {
                type: 'set',
                path: `work_sessions/${ledgerId}`,
                data: {
                    taskId: task.id,
                    taskTitle: task.title || 'Nežinoma užduotis',
                    userId,
                    userName: task.assignedUserName || null,
                    runId: run.runId,
                    startTime: start.toISOString(),
                    endTime: end.toISOString(),
                    durationMinutes,
                    date: getLithuanianDateString(end),
                    createdAt: endedAt,
                    engineVersion: TIMER_ENGINE_VERSION,
                },
                merge: true,
            },
        ],
    };
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
    if (base.status === 'active' && base.run?.taskId !== task.id && !previousTask) {
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
    commandId,
    runId,
    issuedAt,
}) {
    if (!runId) throw new Error('Break start requires a new runId');

    const base = canonicalSessionState(currentRecord, { ...userData, id: userId });
    if (base.status === 'active' && base.run?.type !== 'task') {
        throw Object.assign(new Error('Another secondary session is active'), {
            code: 'timer/conflict',
        });
    }
    if (base.status === 'active' && !currentTask) {
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
    const pausedSession = base.status === 'active' ? taskPausedSession(base.run) : null;
    const run = {
        runId,
        type: 'break',
        startedAt: issuedAt,
        revision,
        pausedSession,
    };
    const writes = [];

    if (base.status === 'active') {
        writes.push(...closeTaskWrites({
            task: currentTask,
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
            path: `users/${userId}`,
            data: breakRunningProjection(userData, run, issuedAt, pausedSession?.taskId || null),
        },
        commandWrite(command, revision),
    );

    return { command, writes };
}

export function planBreakEnd({
    userId,
    userData,
    activeRecord: currentRecord,
    restoreTask = null,
    commandId,
    runId = null,
    issuedAt,
}) {
    const base = canonicalSessionState(currentRecord, { ...userData, id: userId });
    if (base.status !== 'active' || base.run?.type !== 'break') {
        throw Object.assign(new Error('The break run is no longer active'), {
            code: 'timer/conflict',
        });
    }

    if (restoreTask && !runId) {
        throw new Error('Restoring a task after break requires a new runId');
    }

    const startedAt = new Date(base.run.startedAt);
    const endedAt = new Date(issuedAt);
    const durationMinutes = clampSessionMinutes((endedAt - startedAt) / 60000);
    const pausedTask = base.run.pausedSession?.type === 'task'
        ? base.run.pausedSession
        : null;
    if (pausedTask?.taskId && restoreTask?.id !== pausedTask.taskId) {
        throw Object.assign(new Error('The task to restore does not match the paused session'), {
            code: 'timer/conflict',
        });
    }

    const command = baseCommand({
        kind: 'end-session',
        userId,
        base,
        commandId,
        runId: restoreTask ? runId : base.run.runId,
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
        });
    }

    if (restoreTask) {
        const nextRun = {
            runId,
            type: 'task',
            taskId: restoreTask.id,
            taskTitle: restoreTask.title || pausedTask?.taskTitle || 'Užduotis',
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
                            Number(userData?.breakState?.dailyAccumulatedMinutes || 0)
                            + durationMinutes,
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
        restoredTaskRunId: restoreTask ? runId : null,
        writes,
    };
}

export function planSecondaryStart({
    type,
    userId,
    userData,
    activeRecord: currentRecord,
    currentTask = null,
    commandId,
    runId,
    issuedAt,
}) {
    if (!['call', 'quickWork'].includes(type)) {
        throw new Error('Secondary start supports call and quickWork');
    }
    if (!runId) throw new Error('Secondary start requires a new runId');

    const base = canonicalSessionState(currentRecord, { ...userData, id: userId });
    if (
        base.status === 'active'
        && !['task', 'break'].includes(base.run?.type)
    ) {
        throw Object.assign(new Error('This secondary switch is not supported yet'), {
            code: 'timer/conflict',
        });
    }
    if (base.status === 'active' && base.run?.type === 'task' && !currentTask) {
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
    const pausedSession = base.status === 'active' ? runToPausedSession(base.run) : null;
    const run = {
        runId,
        type,
        startedAt: issuedAt,
        revision,
        pausedSession,
    };
    const writes = [];
    let closedBreakMinutes = 0;

    if (base.status === 'active' && base.run?.type === 'task') {
        writes.push(...closeTaskWrites({
            task: currentTask,
            run: base.run,
            endedAt: issuedAt,
            userId,
        }).writes);
    } else if (base.status === 'active' && base.run?.type === 'break') {
        const closedBreak = closeBreakWrites({
            userId,
            userData,
            run: base.run,
            endedAt: issuedAt,
        });
        closedBreakMinutes = closedBreak.durationMinutes;
        writes.push(...closedBreak.writes);
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

    const paused = base.run.pausedSession || null;
    const restoresTask = paused?.type === 'task';
    const restoresBreak = paused?.type === 'break';
    if (paused?.type && !['task', 'break'].includes(paused.type)) {
        throw Object.assign(new Error('This nested secondary restore is not supported yet'), {
            code: 'timer/conflict',
        });
    }
    if (restoresTask && restoreTask?.id !== paused.taskId) {
        throw Object.assign(new Error('The task to restore does not match the paused session'), {
            code: 'timer/conflict',
        });
    }
    if ((restoresTask || restoresBreak) && !runId) {
        throw new Error('Restoring a session requires a new runId');
    }

    const startedAt = new Date(base.run.startedAt);
    const endedAt = new Date(issuedAt);
    const durationMinutes = clampSessionMinutes((endedAt - startedAt) / 60000);
    const command = baseCommand({
        kind: 'end-session',
        userId,
        base,
        commandId,
        runId: (restoresTask || restoresBreak) ? runId : base.run.runId,
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
                endedAt: issuedAt,
                durationMinutes,
                contactType,
                callNotes,
            }));
        } else if (durationMinutes > MIN_LOGGED_SESSION_MINUTES) {
            loggedQuickWork = quickWorkLogWrites({
                userId,
                userData,
                run: base.run,
                endedAt: issuedAt,
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
    } else if (restoresBreak) {
        const nextRun = {
            runId,
            type: 'break',
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
        restoredRunId: (restoresTask || restoresBreak) ? runId : null,
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
    if (base.run?.type === 'task' && !activeTask) {
        throw Object.assign(new Error('The active task must be supplied for force-end'), {
            code: 'timer/missing-active-task',
        });
    }

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

    if (base.run?.type === 'task') {
        const closed = closeTaskWrites({
            task: activeTask,
            run: base.run,
            endedAt: issuedAt,
            userId: targetUser.id,
        });
        creditedMinutes = closed.durationMinutes;
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
    const provenEnd = new Date(hasUsableHeartbeat ? heartbeatMs : recoveryEnd.getTime());
    const provenMinutes = clampSessionMinutes((provenEnd - oldStart) / 60000);
    const gapMinutes = hasUsableHeartbeat
        ? clampSessionMinutes((recoveryEnd - provenEnd) / 60000)
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
        recoveredGap,
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
    if (
        base.status === 'active'
        && (
            base.run?.type !== 'task'
            || base.run?.taskId !== task.id
        )
    ) {
        throw Object.assign(new Error('Another run is active'), { code: 'timer/conflict' });
    }

    const command = baseCommand({
        kind: 'end-task',
        userId,
        base,
        commandId,
        issuedAt,
    });
    const revision = base.revision + 1;
    let finalTimerMinutes = Number(task.timerMinutes || 0);
    let closedSessionId = null;
    const writes = [];

    if (base.status === 'active') {
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
                timeLimitReached: false,
                updatedAt: issuedAt,
                timerProjectionVersion: TIMER_ENGINE_VERSION,
            },
        },
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
