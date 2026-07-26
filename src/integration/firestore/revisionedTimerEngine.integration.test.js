import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
    collection,
    disableNetwork,
    doc,
    enableNetwork,
    getDoc,
    getDocs,
    onSnapshot,
    setDoc,
} from 'firebase/firestore';
import { readFile } from 'node:fs/promises';
import {
    planBreakEnd,
    planBreakStart,
    planManagerForceEnd,
    planSecondaryEnd,
    planSecondaryStart,
    planTaskEnd,
    planTaskPause,
    planTaskRecover,
    planTaskStart,
} from '../../utils/timerTransitionPlan';
import { applyTimerTransitionPlan } from '../../utils/timerTransitionExecutor';

const PROJECT_ID = 'demo-workz-timer';
const USER_ID = 'timer-worker';
const MANAGER_ID = 'timer-manager';
const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describeEmulator = emulatorAvailable ? describe : describe.skip;

const task = (id, overrides = {}) => ({
    id,
    title: `Task ${id}`,
    assignedUserId: USER_ID,
    assignedUserName: 'Timer Worker',
    status: 'pending',
    timerStatus: null,
    timerStartedAt: null,
    timerMinutes: 0,
    manualMinutes: 0,
    ...overrides,
});

let testEnv;

async function seed(documents) {
    await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await Promise.all(
            Object.entries(documents).map(([path, data]) => setDoc(doc(db, path), data))
        );
    });
}

function workerDb() {
    return testEnv.authenticatedContext(USER_ID, {
        email: 'timer-worker@example.test',
    }).firestore();
}

function managerDb() {
    return testEnv.authenticatedContext(MANAGER_ID, {
        email: 'timer-manager@example.test',
    }).firestore();
}

async function adminRead(path) {
    let snapshot;
    await testEnv.withSecurityRulesDisabled(async (context) => {
        snapshot = await getDoc(doc(context.firestore(), path));
    });
    return snapshot;
}

async function adminCollection(path) {
    let snapshot;
    await testEnv.withSecurityRulesDisabled(async (context) => {
        snapshot = await getDocs(collection(context.firestore(), path));
    });
    return snapshot;
}

function userData(activeSession = null) {
    return {
        id: USER_ID,
        role: 'worker',
        isDisabled: false,
        activeSession,
        workStatus: activeSession
            ? { isWorking: true, status: 'running', activeTaskId: activeSession.taskId }
            : { isWorking: false, status: 'idle', activeTaskId: null },
    };
}

beforeAll(async () => {
    if (!emulatorAvailable) return;
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
            rules: await readFile(new URL('../../../firestore.rules', import.meta.url), 'utf8'),
        },
    });
}, 30_000);

beforeEach(async () => {
    if (!emulatorAvailable) return;
    await testEnv.clearFirestore();
    await seed({
        [`users/${USER_ID}`]: userData(),
        [`users/${MANAGER_ID}`]: {
            id: MANAGER_ID,
            role: 'manager',
            isDisabled: false,
            email: 'timer-manager@example.test',
        },
        'tasks/task-a': task('task-a'),
        'tasks/task-b': task('task-b'),
    });
});

afterAll(async () => {
    await testEnv?.cleanup();
});

describeEmulator('revisioned offline timer engine', () => {
    it('queues start and stop while offline, then commits one exact ledger row on reconnect', async () => {
        const db = workerDb();
        const userRef = doc(db, 'users', USER_ID);
        const taskRef = doc(db, 'tasks', 'task-a');
        const activeRef = doc(db, 'active_sessions', USER_ID);

        await Promise.all([getDoc(userRef), getDoc(taskRef), getDoc(activeRef)]);
        let localActiveRecord = null;
        let resolveStartedOffline;
        let resolveStoppedOffline;
        const startedOfflineSnapshot = new Promise((resolve) => {
            resolveStartedOffline = resolve;
        });
        const offlineSnapshot = new Promise((resolve) => {
            resolveStoppedOffline = resolve;
        });
        const unsubscribe = onSnapshot(activeRef, { includeMetadataChanges: true }, (snapshot) => {
            if (snapshot.metadata.hasPendingWrites && snapshot.data()?.revision === 1) {
                localActiveRecord = snapshot.data();
                resolveStartedOffline();
            }
            if (snapshot.metadata.hasPendingWrites && snapshot.data()?.revision === 2) {
                resolveStoppedOffline();
            }
        });

        await disableNetwork(db);
        let startPromise;
        let pausePromise;
        try {
            const startPlan = planTaskStart({
                task: task('task-a'),
                userId: USER_ID,
                userData: userData(),
                activeRecord: null,
                commandId: 'cmd-offline-start',
                runId: 'run-offline',
                issuedAt: '2026-07-09T08:00:00.000Z',
            });
            startPromise = applyTimerTransitionPlan(db, startPlan);
            await startedOfflineSnapshot;

            expect(localActiveRecord.revision).toBe(1);

            const pausePlan = planTaskPause({
                task: task('task-a', {
                    timerStatus: 'running',
                    timerStartedAt: '2026-07-09T08:00:00.000Z',
                    timerRunId: 'run-offline',
                }),
                userId: USER_ID,
                userData: userData({
                    type: 'task',
                    taskId: 'task-a',
                    taskTitle: 'Task task-a',
                    runId: 'run-offline',
                    startTime: '2026-07-09T08:00:00.000Z',
                }),
                activeRecord: localActiveRecord,
                commandId: 'cmd-offline-pause',
                issuedAt: '2026-07-09T08:05:00.000Z',
            });
            pausePromise = applyTimerTransitionPlan(db, pausePlan);
            await offlineSnapshot;

            expect(localActiveRecord.revision).toBe(1);
        } finally {
            await enableNetwork(db);
            unsubscribe();
        }

        await Promise.all([
            assertSucceeds(startPromise),
            assertSucceeds(pausePromise),
        ]);

        const [activeAfter, taskAfter, ledgerAfter] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
            adminRead('work_sessions/sess_run_run-offline'),
        ]);
        expect(activeAfter.data()).toMatchObject({ status: 'idle', revision: 2 });
        expect(taskAfter.data()).toMatchObject({
            timerStatus: 'paused',
            timerMinutes: 5,
        });
        expect(ledgerAfter.data()).toMatchObject({
            runId: 'run-offline',
            durationMinutes: 5,
            startTime: '2026-07-09T08:00:00.000Z',
            endTime: '2026-07-09T08:05:00.000Z',
        });
        expect((await adminCollection('work_sessions')).size).toBe(1);
    }, 15_000);

    it('accepts one simultaneous start and rejects the stale device without overwriting the winner', async () => {
        const firstDb = workerDb();
        const secondDb = workerDb();
        const firstPlan = planTaskStart({
            task: task('task-a'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-device-a',
            runId: 'run-device-a',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        const secondPlan = planTaskStart({
            task: task('task-b'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-device-b',
            runId: 'run-device-b',
            issuedAt: '2026-07-09T08:00:00.001Z',
        });

        const outcomes = await Promise.all([
            applyTimerTransitionPlan(firstDb, firstPlan).then(
                () => ({ status: 'fulfilled' }),
                (error) => ({ status: 'rejected', error })
            ),
            applyTimerTransitionPlan(secondDb, secondPlan).then(
                () => ({ status: 'fulfilled' }),
                (error) => ({ status: 'rejected', error })
            ),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

        const active = await adminRead(`active_sessions/${USER_ID}`);
        const winner = active.data().run;
        expect(active.data().revision).toBe(1);
        expect(['run-device-a', 'run-device-b']).toContain(winner.runId);

        const losingTaskId = winner.taskId === 'task-a' ? 'task-b' : 'task-a';
        const losingTask = await adminRead(`tasks/${losingTaskId}`);
        expect(losingTask.data().timerStatus).toBeNull();
    });

    it('rejects the whole pause when the ledger row is invalid, leaving the run active', async () => {
        const db = workerDb();
        const startPlan = planTaskStart({
            task: task('task-a'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-atomic-start',
            runId: 'run-atomic',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startPlan));

        const active = await adminRead(`active_sessions/${USER_ID}`);
        const runningTask = await adminRead('tasks/task-a');
        const pausePlan = planTaskPause({
            task: { id: runningTask.id, ...runningTask.data() },
            userId: USER_ID,
            userData: userData({
                type: 'task',
                taskId: 'task-a',
                startTime: '2026-07-09T08:00:00.000Z',
            }),
            activeRecord: active.data(),
            commandId: 'cmd-invalid-ledger',
            issuedAt: '2026-07-09T08:05:00.000Z',
        });
        const ledgerWrite = pausePlan.writes.find((write) => write.path.startsWith('work_sessions/'));
        ledgerWrite.data.durationMinutes = 2040;

        await assertFails(applyTimerTransitionPlan(db, pausePlan));

        const [activeAfter, taskAfter, ledgerAfter] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
            adminRead('work_sessions/sess_run_run-atomic'),
        ]);
        expect(activeAfter.data()).toMatchObject({ status: 'active', revision: 1 });
        expect(taskAfter.data()).toMatchObject({
            timerStatus: 'running',
            timerStartedAt: '2026-07-09T08:00:00.000Z',
        });
        expect(ledgerAfter.exists()).toBe(false);
    });

    it('cannot duplicate credited time when the same pause command is replayed', async () => {
        const db = workerDb();
        const startPlan = planTaskStart({
            task: task('task-a'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-replay-start',
            runId: 'run-replay',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startPlan));

        const active = await adminRead(`active_sessions/${USER_ID}`);
        const runningTask = await adminRead('tasks/task-a');
        const pausePlan = planTaskPause({
            task: { id: runningTask.id, ...runningTask.data() },
            userId: USER_ID,
            userData: userData({
                type: 'task',
                taskId: 'task-a',
                startTime: '2026-07-09T08:00:00.000Z',
            }),
            activeRecord: active.data(),
            commandId: 'cmd-replay-pause',
            issuedAt: '2026-07-09T08:07:00.000Z',
        });

        await assertSucceeds(applyTimerTransitionPlan(db, pausePlan));
        await assertFails(applyTimerTransitionPlan(db, pausePlan));

        const ledger = await adminRead('work_sessions/sess_run_run-replay');
        expect(ledger.data().durationMinutes).toBe(7);
        expect((await adminCollection('work_sessions')).size).toBe(1);
    });

    it('finishes an active task by closing the run, completing the task, and clearing canonical active state', async () => {
        const db = workerDb();
        const startPlan = planTaskStart({
            task: task('task-a'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-finish-start',
            runId: 'run-finish',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startPlan));

        const [active, runningTask] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
        ]);
        const finishPlan = planTaskEnd({
            task: { id: runningTask.id, ...runningTask.data() },
            userId: USER_ID,
            userData: userData({
                type: 'task',
                taskId: 'task-a',
                runId: 'run-finish',
                startTime: '2026-07-09T08:00:00.000Z',
            }),
            activeRecord: active.data(),
            commandId: 'cmd-finish-active',
            issuedAt: '2026-07-09T08:05:00.000Z',
        });

        await assertSucceeds(applyTimerTransitionPlan(db, finishPlan));

        const [activeAfter, taskAfter, ledgerAfter, commandAfter] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
            adminRead('work_sessions/sess_run_run-finish'),
            adminRead(`users/${USER_ID}/timer_commands/cmd-finish-active`),
        ]);
        expect(activeAfter.data()).toMatchObject({ status: 'idle', revision: 2 });
        expect(taskAfter.data()).toMatchObject({
            completed: true,
            status: 'completed',
            timerStatus: 'paused',
            timerStartedAt: null,
            timerMinutes: 5,
            actualTime: '5m',
        });
        expect(ledgerAfter.data()).toMatchObject({
            runId: 'run-finish',
            durationMinutes: 5,
            startTime: '2026-07-09T08:00:00.000Z',
            endTime: '2026-07-09T08:05:00.000Z',
        });
        expect(commandAfter.data()).toMatchObject({
            kind: 'end-task',
            expectedRevision: 1,
            appliedRevision: 2,
        });
        expect((await adminCollection('work_sessions')).size).toBe(1);
    });

    it('allows a manager to force-end a canonical running task without bypassing the revision guard', async () => {
        const db = workerDb();
        const startPlan = planTaskStart({
            task: task('task-a'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-manager-force-start',
            runId: 'run-manager-force',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startPlan));

        const [active, runningTask, targetUser] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
            adminRead(`users/${USER_ID}`),
        ]);
        const forcePlan = planManagerForceEnd({
            targetUser: { id: targetUser.id, ...targetUser.data() },
            actorId: MANAGER_ID,
            activeRecord: active.data(),
            activeTask: { id: runningTask.id, ...runningTask.data() },
            commandId: 'cmd-manager-force-end',
            issuedAt: '2026-07-09T08:12:00.000Z',
        });

        await assertSucceeds(applyTimerTransitionPlan(managerDb(), forcePlan));

        const [activeAfter, taskAfter, ledgerAfter, commandAfter] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
            adminRead('work_sessions/sess_run_run-manager-force'),
            adminRead(`users/${USER_ID}/timer_commands/cmd-manager-force-end`),
        ]);
        expect(activeAfter.data()).toMatchObject({ status: 'idle', revision: 2 });
        expect(taskAfter.data()).toMatchObject({
            timerStatus: 'paused',
            timerStartedAt: null,
            timerMinutes: 12,
        });
        expect(ledgerAfter.data()).toMatchObject({
            runId: 'run-manager-force',
            durationMinutes: 12,
        });
        expect(commandAfter.data()).toMatchObject({
            kind: 'force-end-session',
            actorId: MANAGER_ID,
            expectedRevision: 1,
            appliedRevision: 2,
        });
    });

    // A stack two secondaries deep (call <- break <- task) run against the REAL rules file, not
    // reasoned about. Three things are only provable here: that validActiveSessionRecord accepts a
    // nested pausedSession chain at all, that taskCloseLedgerBound does NOT fire on a secondary
    // close (it binds only a task run, so a call/quick-work close carries no sess_run_ row), and
    // that unwinding the stack step by step lands the worker back on the original task.
    it('unwinds a two-deep stack: call over break over task, back down to the task', async () => {
        const db = workerDb();

        const startTaskPlan = planTaskStart({
            task: task('task-a'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-stack-task-start',
            runId: 'run-task-bottom',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startTaskPlan));

        // Layer 1 — a break interrupts the task. The task's minutes are banked on the way down.
        const [activeAfterTask, runningTask] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
        ]);
        const startBreakPlan = planBreakStart({
            userId: USER_ID,
            userData: userData({ type: 'task', taskId: 'task-a', runId: 'run-task-bottom' }),
            activeRecord: activeAfterTask.data(),
            currentTask: { id: runningTask.id, ...runningTask.data() },
            commandId: 'cmd-stack-break-start',
            runId: 'run-break-middle',
            issuedAt: '2026-07-09T08:10:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startBreakPlan));

        // Layer 2 — a call interrupts the break. THIS is the transition the engine used to refuse.
        const activeAfterBreak = await adminRead(`active_sessions/${USER_ID}`);
        const startCallPlan = planSecondaryStart({
            type: 'call',
            userId: USER_ID,
            userData: {
                ...userData({ type: 'break', runId: 'run-break-middle' }),
                breakState: { isTakingBreak: true, dailyAccumulatedMinutes: 0 },
            },
            activeRecord: activeAfterBreak.data(),
            commandId: 'cmd-stack-call-start',
            runId: 'run-call-top',
            issuedAt: '2026-07-09T08:20:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startCallPlan));

        const [activeStacked, bankedBreak] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('break_sessions/sess_break_run_run-break-middle'),
        ]);
        // The rules accepted a run whose pausedSession is itself a session with a pausedSession.
        expect(activeStacked.data()).toMatchObject({
            status: 'active',
            run: {
                runId: 'run-call-top',
                type: 'call',
                pausedSession: {
                    type: 'break',
                    pausedSession: { type: 'task', taskId: 'task-a' },
                },
            },
        });
        // The interrupted break was banked, so nothing underneath is still accruing.
        expect(bankedBreak.data()).toMatchObject({ runId: 'run-break-middle', durationMinutes: 10 });

        // Unwind 1 — ending the call pops the break back as a FRESH run.
        const endCallPlan = planSecondaryEnd({
            type: 'call',
            userId: USER_ID,
            userData: {
                ...userData({ type: 'call', runId: 'run-call-top' }),
                breakState: { isTakingBreak: false, dailyAccumulatedMinutes: 10 },
            },
            activeRecord: activeStacked.data(),
            commandId: 'cmd-stack-call-end',
            runId: 'run-break-resumed',
            issuedAt: '2026-07-09T08:35:00.000Z',
            contactType: 'client',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, endCallPlan));

        const [activeAfterCall, callSession] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead(`work_sessions/sess_call_ws_${USER_ID}_${new Date('2026-07-09T08:20:00.000Z').getTime()}`),
        ]);
        expect(activeAfterCall.data()).toMatchObject({
            status: 'active',
            run: {
                runId: 'run-break-resumed',
                type: 'break',
                startedAt: '2026-07-09T08:35:00.000Z',
                pausedSession: { type: 'task', taskId: 'task-a' },
            },
        });
        expect(callSession.data()).toMatchObject({ durationMinutes: 15 });

        // Unwind 2 — ending the resumed break restores the original task.
        const resumedTaskDoc = await adminRead('tasks/task-a');
        const endBreakPlan = planBreakEnd({
            userId: USER_ID,
            userData: {
                ...userData({ type: 'break', runId: 'run-break-resumed' }),
                breakState: { isTakingBreak: true, dailyAccumulatedMinutes: 10 },
            },
            activeRecord: activeAfterCall.data(),
            restoreTask: { id: resumedTaskDoc.id, ...resumedTaskDoc.data() },
            commandId: 'cmd-stack-break-end',
            runId: 'run-task-restored',
            issuedAt: '2026-07-09T08:40:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, endBreakPlan));

        const [activeFinal, finalTask] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
        ]);
        expect(activeFinal.data()).toMatchObject({
            status: 'active',
            run: { runId: 'run-task-restored', type: 'task', taskId: 'task-a' },
        });
        // 10 minutes credited on the way down, and the task is live again — the worker is back
        // exactly where they started, with no minute counted twice anywhere in the stack.
        expect(finalTask.data()).toMatchObject({
            timerStatus: 'running',
            timerMinutes: 10,
            timerRunId: 'run-task-restored',
        });
    });

    it('lets a manager force-end a two-deep stack in one write', async () => {
        const db = workerDb();
        const startTaskPlan = planTaskStart({
            task: task('task-a'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-force-stack-task',
            runId: 'run-task-bottom',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startTaskPlan));

        const [activeAfterTask, runningTask] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
        ]);
        const startBreakPlan = planBreakStart({
            userId: USER_ID,
            userData: userData({ type: 'task', taskId: 'task-a', runId: 'run-task-bottom' }),
            activeRecord: activeAfterTask.data(),
            currentTask: { id: runningTask.id, ...runningTask.data() },
            commandId: 'cmd-force-stack-break',
            runId: 'run-break-middle',
            issuedAt: '2026-07-09T08:10:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startBreakPlan));

        const activeStacked = await adminRead(`active_sessions/${USER_ID}`);
        const forcePlan = planManagerForceEnd({
            targetUser: { id: USER_ID, displayName: 'Timer Worker' },
            actorId: MANAGER_ID,
            activeRecord: activeStacked.data(),
            activeTask: null,
            commandId: 'cmd-force-stack',
            issuedAt: '2026-07-09T08:25:00.000Z',
        });
        // The manager force-idle branch of the active_sessions rule must accept a stacked run.
        await assertSucceeds(applyTimerTransitionPlan(managerDb(), forcePlan));

        const activeAfterForce = await adminRead(`active_sessions/${USER_ID}`);
        expect(activeAfterForce.data()).toMatchObject({ status: 'idle', run: null });
        // The whole stack is settled, and the caller is told what the worker lost so it can say so.
        expect(forcePlan.discardedStack).toEqual([
            { type: 'task', taskId: 'task-a', taskTitle: 'Task task-a' },
        ]);
    });

    it('starts a break over an active task and later restores the task with a fresh run', async () => {
        const db = workerDb();
        const startTaskPlan = planTaskStart({
            task: task('task-a'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-break-task-start',
            runId: 'run-task-before-break',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startTaskPlan));

        const [activeBeforeBreak, runningTask] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
        ]);
        const startBreakPlan = planBreakStart({
            userId: USER_ID,
            userData: userData({
                type: 'task',
                taskId: 'task-a',
                runId: 'run-task-before-break',
                startTime: '2026-07-09T08:00:00.000Z',
            }),
            activeRecord: activeBeforeBreak.data(),
            currentTask: { id: runningTask.id, ...runningTask.data() },
            commandId: 'cmd-start-break-over-task',
            runId: 'run-break-over-task',
            issuedAt: '2026-07-09T08:05:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startBreakPlan));

        const [activeBreak, pausedTask, taskSession] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
            adminRead('work_sessions/sess_run_run-task-before-break'),
        ]);
        expect(activeBreak.data()).toMatchObject({
            status: 'active',
            revision: 2,
            run: {
                runId: 'run-break-over-task',
                type: 'break',
                pausedSession: { type: 'task', taskId: 'task-a' },
            },
        });
        expect(pausedTask.data()).toMatchObject({
            timerStatus: 'paused',
            timerStartedAt: null,
            timerMinutes: 5,
        });
        expect(taskSession.data()).toMatchObject({
            runId: 'run-task-before-break',
            durationMinutes: 5,
        });

        const endBreakPlan = planBreakEnd({
            userId: USER_ID,
            userData: {
                ...userData({
                    type: 'break',
                    runId: 'run-break-over-task',
                    startTime: '2026-07-09T08:05:00.000Z',
                }),
                breakState: { isTakingBreak: true, dailyAccumulatedMinutes: 0 },
            },
            activeRecord: activeBreak.data(),
            restoreTask: { id: pausedTask.id, ...pausedTask.data() },
            commandId: 'cmd-end-break-restore-task',
            runId: 'run-task-after-break',
            issuedAt: '2026-07-09T08:15:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, endBreakPlan));

        const [activeAfterBreak, resumedTask, breakSession, userAfter] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
            adminRead('break_sessions/sess_break_run_run-break-over-task'),
            adminRead(`users/${USER_ID}`),
        ]);
        expect(activeAfterBreak.data()).toMatchObject({
            status: 'active',
            revision: 3,
            run: {
                runId: 'run-task-after-break',
                type: 'task',
                taskId: 'task-a',
            },
        });
        expect(resumedTask.data()).toMatchObject({
            timerStatus: 'running',
            timerStartedAt: '2026-07-09T08:15:00.000Z',
            timerMinutes: 5,
            timerRunId: 'run-task-after-break',
        });
        expect(breakSession.data()).toMatchObject({
            runId: 'run-break-over-task',
            durationMinutes: 10,
            isBreak: true,
        });
        expect(userAfter.data()).toMatchObject({
            activeSession: {
                type: 'task',
                taskId: 'task-a',
                runId: 'run-task-after-break',
            },
            breakState: {
                isTakingBreak: false,
                dailyAccumulatedMinutes: 10,
            },
            workStatus: {
                isWorking: true,
                status: 'running',
                activeTaskId: 'task-a',
            },
        });
        expect((await adminCollection('work_sessions')).size).toBe(1);
        expect((await adminCollection('break_sessions')).size).toBe(1);
    });

    it('starts a call over an active task, logs the call, and restores the task run', async () => {
        const db = workerDb();
        const startTaskPlan = planTaskStart({
            task: task('task-a'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-call-task-start',
            runId: 'run-task-before-call',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startTaskPlan));

        const [activeBeforeCall, runningTask] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
        ]);
        const startCallPlan = planSecondaryStart({
            type: 'call',
            userId: USER_ID,
            userData: userData({
                type: 'task',
                taskId: 'task-a',
                runId: 'run-task-before-call',
                startTime: '2026-07-09T08:00:00.000Z',
            }),
            activeRecord: activeBeforeCall.data(),
            currentTask: { id: runningTask.id, ...runningTask.data() },
            commandId: 'cmd-start-call-over-task',
            runId: 'run-call-over-task',
            issuedAt: '2026-07-09T08:05:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startCallPlan));

        const [activeCall, pausedTask] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
        ]);
        const endCallPlan = planSecondaryEnd({
            type: 'call',
            userId: USER_ID,
            userData: {
                ...userData({
                    type: 'call',
                    runId: 'run-call-over-task',
                    startTime: '2026-07-09T08:05:00.000Z',
                }),
                displayName: 'Timer Worker',
                callState: { isCalling: true },
            },
            activeRecord: activeCall.data(),
            restoreTask: { id: pausedTask.id, ...pausedTask.data() },
            commandId: 'cmd-end-call-restore-task',
            runId: 'run-task-after-call',
            issuedAt: '2026-07-09T08:15:00.000Z',
            contactType: 'client',
            callNotes: 'Delivery',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, endCallPlan));

        const [activeAfterCall, resumedTask, callTask, callSession] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
            adminRead(`tasks/${endCallPlan.createdTaskId}`),
            adminRead(`work_sessions/${endCallPlan.workSessionId}`),
        ]);
        expect(activeAfterCall.data()).toMatchObject({
            status: 'active',
            revision: 3,
            run: {
                runId: 'run-task-after-call',
                type: 'task',
                taskId: 'task-a',
            },
        });
        expect(resumedTask.data()).toMatchObject({
            timerStatus: 'running',
            timerStartedAt: '2026-07-09T08:15:00.000Z',
            timerMinutes: 5,
        });
        expect(callTask.data()).toMatchObject({
            assignedUserId: USER_ID,
            status: 'confirmed',
            contactType: 'client',
            manualMinutes: 10,
            isSystemTask: true,
        });
        expect(callSession.data()).toMatchObject({
            userId: USER_ID,
            contactType: 'client',
            durationMinutes: 10,
            isSystemTask: true,
        });
        expect((await adminCollection('work_sessions')).size).toBe(2);
    });

    it('logs described quick work through the revisioned engine and leaves the worker idle', async () => {
        const db = workerDb();
        const startQuickPlan = planSecondaryStart({
            type: 'quickWork',
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-start-quick',
            runId: 'run-quick',
            issuedAt: '2026-07-09T09:00:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startQuickPlan));

        const activeQuick = await adminRead(`active_sessions/${USER_ID}`);
        const endQuickPlan = planSecondaryEnd({
            type: 'quickWork',
            userId: USER_ID,
            userData: {
                ...userData({
                    type: 'quickWork',
                    runId: 'run-quick',
                    startTime: '2026-07-09T09:00:00.000Z',
                }),
                displayName: 'Timer Worker',
                role: 'worker',
                defaultManager: 'manager-a',
                quickWorkState: { isQuickWorking: true },
            },
            activeRecord: activeQuick.data(),
            commandId: 'cmd-end-quick-described',
            issuedAt: '2026-07-09T09:08:00.000Z',
            customTitle: 'Tvarka',
            customComment: 'Sutvarkytos lentynos',
            auditorManagerId: 'manager-a',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, endQuickPlan));

        const [activeAfterQuick, quickTask, quickSession, userAfter] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead(`tasks/${endQuickPlan.createdTaskId}`),
            adminRead(`work_sessions/${endQuickPlan.workSessionId}`),
            adminRead(`users/${USER_ID}`),
        ]);
        expect(activeAfterQuick.data()).toMatchObject({ status: 'idle', revision: 2 });
        expect(quickTask.data()).toMatchObject({
            assignedUserId: USER_ID,
            status: 'completed',
            managerId: 'manager-a',
            manualMinutes: 8,
            isQuickWork: true,
            workSessionId: endQuickPlan.workSessionId,
        });
        expect(quickSession.data()).toMatchObject({
            userId: USER_ID,
            taskTitle: 'Tvarka',
            durationMinutes: 8,
            isQuickWork: true,
        });
        expect(userAfter.data()).toMatchObject({
            activeSession: null,
            quickWorkState: { isQuickWorking: false },
            workStatus: { isWorking: false, status: 'idle', activeTaskId: null },
        });
    });

    // A 2h silence is NOT a reload the worker survived — it is a genuinely abandoned run. Recovery
    // credits the proven stretch plus the plausible untracked gap, then comes back PAUSED, exactly
    // as the legacy path does. Re-anchoring it instead would leave an unattended timer running on a
    // device nobody is holding, which is the runaway the 16h ceiling exists to bound.
    it('recovers a killed PWA by crediting the gap and coming back PAUSED in one atomic transition', async () => {
        const db = workerDb();
        const startPlan = planTaskStart({
            task: task('task-a'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-recovery-start',
            runId: 'run-before-process-death',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startPlan));

        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'tasks', 'task-a'), {
                timerLastHeartbeat: '2026-07-09T08:01:00.000Z',
            }, { merge: true });
        });

        const [active, runningTask] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
        ]);
        const recoveredAt = '2026-07-09T10:00:00.000Z';
        const recoveryPlan = planTaskRecover({
            task: { id: runningTask.id, ...runningTask.data() },
            userId: USER_ID,
            userData: userData({
                type: 'task',
                taskId: 'task-a',
                runId: 'run-before-process-death',
                startTime: '2026-07-09T08:00:00.000Z',
            }),
            activeRecord: active.data(),
            commandId: 'cmd-recover-process-death',
            runId: 'run-after-process-death',
            issuedAt: recoveredAt,
            recoveredAt,
        });

        await assertSucceeds(applyTimerTransitionPlan(db, recoveryPlan));

        const [activeAfter, taskAfter, provenSession, recoveredGap] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
            adminRead('work_sessions/sess_run_run-before-process-death'),
            adminRead('work_sessions/sess_gap_run_run-before-process-death'),
        ]);
        expect(activeAfter.data()).toMatchObject({
            status: 'idle',
            revision: 2,
            run: null,
        });
        expect(taskAfter.data()).toMatchObject({
            timerStatus: 'paused',
            timerStartedAt: null,
            timerMinutes: 120,
        });
        expect(provenSession.data()).toMatchObject({
            runId: 'run-before-process-death',
            durationMinutes: 1,
        });
        expect(recoveredGap.data()).toMatchObject({
            recoveredFromRunId: 'run-before-process-death',
            durationMinutes: 119,
            isRecoveredGap: true,
        });
    });

    // The other half of the same branch: an ordinary mid-shift reload (PWA update, tab eviction)
    // that the worker demonstrably came back from. The whole run is real continuous work, so it is
    // credited in ONE row up to the reload instant, the timer keeps running, and the re-anchored run
    // is claimed for this app instance — without which the heartbeat refuses to beat it and the run
    // looks dead a minute later. This is the path the rules must accept while a run stays ACTIVE, so
    // it also proves the ledger-binding rule (taskCloseLedgerBound) does not reject a live re-anchor.
    it('continues a brief reload as one run, re-anchored and owned by this app instance', async () => {
        const db = workerDb();
        const startPlan = planTaskStart({
            task: task('task-a'),
            userId: USER_ID,
            userData: userData(),
            activeRecord: null,
            commandId: 'cmd-reload-start',
            runId: 'run-before-reload',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        await assertSucceeds(applyTimerTransitionPlan(db, startPlan));

        // Heartbeat 30 s before the reload — well inside the continue window.
        await testEnv.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), 'tasks', 'task-a'), {
                timerLastHeartbeat: '2026-07-09T08:29:30.000Z',
            }, { merge: true });
        });

        const [active, runningTask] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
        ]);
        const recoveredAt = '2026-07-09T08:30:00.000Z';
        const recoveryPlan = planTaskRecover({
            task: { id: runningTask.id, ...runningTask.data() },
            userId: USER_ID,
            userData: userData({
                type: 'task',
                taskId: 'task-a',
                runId: 'run-before-reload',
                startTime: '2026-07-09T08:00:00.000Z',
            }),
            activeRecord: active.data(),
            commandId: 'cmd-recover-reload',
            runId: 'run-after-reload',
            issuedAt: recoveredAt,
            recoveredAt,
        });

        await assertSucceeds(applyTimerTransitionPlan(db, recoveryPlan));

        const [activeAfter, taskAfter, provenSession, gap] = await Promise.all([
            adminRead(`active_sessions/${USER_ID}`),
            adminRead('tasks/task-a'),
            adminRead('work_sessions/sess_run_run-before-reload'),
            adminRead('work_sessions/sess_gap_run_run-before-reload'),
        ]);
        expect(activeAfter.data()).toMatchObject({
            status: 'active',
            revision: 2,
            run: { runId: 'run-after-reload', startedAt: recoveredAt },
        });
        expect(taskAfter.data()).toMatchObject({
            timerStatus: 'running',
            timerStartedAt: recoveredAt,
            timerMinutes: 30,
        });
        expect(taskAfter.data().timerOwnerInstance, 'an unowned re-anchored run stops being beaten')
            .toBeTruthy();
        expect(provenSession.data()).toMatchObject({
            runId: 'run-before-reload',
            durationMinutes: 30,
        });
        // ONE row, not a proven row plus a "manual correction" the worker never made.
        expect(gap.exists()).toBe(false);
    });
});
