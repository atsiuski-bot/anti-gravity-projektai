import { describe, expect, it } from 'vitest';
import {
    canonicalSessionState,
    planBreakEnd,
    planBreakStart,
    planSecondaryEnd,
    planSecondaryStart,
    planTaskEnd,
    planTaskPause,
    planTaskRecover,
    planTaskStart,
} from './timerTransitionPlan';

const userId = 'worker-a';
const baseTask = {
    id: 'task-a',
    title: 'Task A',
    assignedUserId: userId,
    assignedUserName: 'Worker A',
    timerStatus: null,
    timerStartedAt: null,
    timerMinutes: 0,
    manualMinutes: 0,
};

const idleUser = {
    id: userId,
    activeSession: null,
    workStatus: { isWorking: false, status: 'idle', activeTaskId: null },
};

describe('revisioned timer transition plans', () => {
    it('starts revision 1 with one stable run and an atomic command marker', () => {
        const plan = planTaskStart({
            task: baseTask,
            userId,
            userData: idleUser,
            activeRecord: null,
            commandId: 'cmd-start',
            runId: 'run-a',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });

        expect(plan.command).toMatchObject({
            commandId: 'cmd-start',
            kind: 'start-task',
            expectedRevision: 0,
            expectedRunId: null,
            runId: 'run-a',
        });
        expect(plan.writes.find((write) => write.path === `active_sessions/${userId}`).data)
            .toMatchObject({
                revision: 1,
                expectedRevision: 0,
                status: 'active',
                run: {
                    runId: 'run-a',
                    taskId: 'task-a',
                    startedAt: '2026-07-09T08:00:00.000Z',
                },
            });
        expect(plan.writes.some((write) =>
            write.path === `users/${userId}/timer_commands/cmd-start`
        )).toBe(true);
    });

    it('pauses one run into one deterministic ledger row', () => {
        const activeRecord = {
            userId,
            revision: 4,
            status: 'active',
            run: {
                runId: 'run-a',
                type: 'task',
                taskId: 'task-a',
                taskTitle: 'Task A',
                startedAt: '2026-07-09T08:00:00.000Z',
                revision: 4,
            },
        };
        const plan = planTaskPause({
            task: {
                ...baseTask,
                timerStatus: 'running',
                timerStartedAt: '2026-07-09T08:00:00.000Z',
                timerMinutes: 12,
            },
            userId,
            userData: idleUser,
            activeRecord,
            commandId: 'cmd-pause',
            issuedAt: '2026-07-09T08:05:00.000Z',
        });

        expect(plan.command).toMatchObject({
            expectedRevision: 4,
            expectedRunId: 'run-a',
        });
        expect(plan.creditedMinutes).toBe(5);
        expect(plan.writes.find((write) => write.path === 'work_sessions/sess_run_run-a').data)
            .toMatchObject({
                runId: 'run-a',
                durationMinutes: 5,
            });
        expect(plan.writes.find((write) => write.path === 'tasks/task-a').data.timerMinutes)
            .toBe(17);
    });

    it('can fold limit metadata into the same atomic pause task update', () => {
        const activeRecord = {
            userId,
            revision: 1,
            status: 'active',
            run: {
                runId: 'run-limit',
                type: 'task',
                taskId: 'task-a',
                taskTitle: 'Task A',
                startedAt: '2026-07-09T08:00:00.000Z',
                revision: 1,
            },
        };
        const plan = planTaskPause({
            task: {
                ...baseTask,
                timerStatus: 'running',
                timerStartedAt: '2026-07-09T08:00:00.000Z',
            },
            userId,
            userData: idleUser,
            activeRecord,
            commandId: 'cmd-limit-pause',
            issuedAt: '2026-07-09T08:05:00.000Z',
            taskUpdates: { timeLimitReached: true },
        });

        expect(plan.writes.find((write) => write.path === 'tasks/task-a').data)
            .toMatchObject({
                timerStatus: 'paused',
                timerMinutes: 5,
                timeLimitReached: true,
            });
    });

    it('switches tasks by closing the old run and opening the new run in one plan', () => {
        const activeRecord = {
            userId,
            revision: 2,
            status: 'active',
            run: {
                runId: 'run-old',
                type: 'task',
                taskId: 'task-old',
                taskTitle: 'Old',
                startedAt: '2026-07-09T08:00:00.000Z',
                revision: 2,
            },
        };
        const previousTask = {
            ...baseTask,
            id: 'task-old',
            title: 'Old',
            timerStatus: 'running',
            timerStartedAt: '2026-07-09T08:00:00.000Z',
        };
        const plan = planTaskStart({
            task: baseTask,
            userId,
            userData: idleUser,
            activeRecord,
            previousTask,
            commandId: 'cmd-switch',
            runId: 'run-new',
            issuedAt: '2026-07-09T08:10:00.000Z',
        });

        expect(plan.command.expectedRunId).toBe('run-old');
        expect(plan.writes.find((write) => write.path === 'tasks/task-old').data.timerStatus)
            .toBe('paused');
        expect(plan.writes.find((write) => write.path === 'work_sessions/sess_run_run-old').data
            .durationMinutes).toBe(10);
        expect(plan.writes.find((write) => write.path === 'tasks/task-a').data.timerStatus)
            .toBe('running');
        expect(plan.writes.find((write) => write.path === `active_sessions/${userId}`).data.run.runId)
            .toBe('run-new');
    });

    it('starts a break by closing the active task run and preserving it as the paused session', () => {
        const plan = planBreakStart({
            userId,
            userData: {
                ...idleUser,
                displayName: 'Worker A',
                workStatus: { isWorking: true, status: 'running', activeTaskId: 'task-a' },
            },
            activeRecord: {
                userId,
                revision: 5,
                status: 'active',
                run: {
                    runId: 'run-before-break',
                    type: 'task',
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    startedAt: '2026-07-09T08:00:00.000Z',
                    revision: 5,
                },
            },
            currentTask: {
                ...baseTask,
                timerStatus: 'running',
                timerStartedAt: '2026-07-09T08:00:00.000Z',
                timerMinutes: 7,
            },
            commandId: 'cmd-start-break',
            runId: 'run-break',
            issuedAt: '2026-07-09T08:05:00.000Z',
        });

        expect(plan.command).toMatchObject({
            kind: 'start-break',
            expectedRevision: 5,
            expectedRunId: 'run-before-break',
            runId: 'run-break',
        });
        expect(plan.writes.find((write) => write.path === 'work_sessions/sess_run_run-before-break').data)
            .toMatchObject({ durationMinutes: 5, runId: 'run-before-break' });
        expect(plan.writes.find((write) => write.path === `active_sessions/${userId}`).data)
            .toMatchObject({
                status: 'active',
                revision: 6,
                run: {
                    runId: 'run-break',
                    type: 'break',
                    pausedSession: {
                        type: 'task',
                        taskId: 'task-a',
                        runId: 'run-before-break',
                    },
                },
            });
        expect(plan.writes.find((write) => write.path === `users/${userId}`).data)
            .toMatchObject({
                activeSession: {
                    type: 'break',
                    runId: 'run-break',
                    pausedSession: { type: 'task', taskId: 'task-a' },
                },
                breakState: {
                    isTakingBreak: true,
                    resumableTaskIds: ['task-a'],
                },
                workStatus: {
                    isWorking: false,
                    status: 'paused',
                    activeTaskId: 'task-a',
                },
            });
    });

    it('ends a break by logging it and restoring the paused task as a fresh run', () => {
        const plan = planBreakEnd({
            userId,
            userData: {
                ...idleUser,
                displayName: 'Worker A',
                breakState: { isTakingBreak: true, dailyAccumulatedMinutes: 3 },
            },
            activeRecord: {
                userId,
                revision: 6,
                status: 'active',
                run: {
                    runId: 'run-break',
                    type: 'break',
                    startedAt: '2026-07-09T08:05:00.000Z',
                    revision: 6,
                    pausedSession: {
                        type: 'task',
                        taskId: 'task-a',
                        taskTitle: 'Task A',
                        runId: 'run-before-break',
                    },
                },
            },
            restoreTask: { ...baseTask, timerStatus: 'paused', timerMinutes: 12 },
            commandId: 'cmd-end-break',
            runId: 'run-after-break',
            issuedAt: '2026-07-09T08:15:00.000Z',
        });

        expect(plan.command).toMatchObject({
            kind: 'end-session',
            expectedRevision: 6,
            expectedRunId: 'run-break',
            runId: 'run-after-break',
        });
        expect(plan.creditedMinutes).toBe(10);
        expect(plan.writes.find((write) => write.path === 'break_sessions/sess_break_run_run-break').data)
            .toMatchObject({
                runId: 'run-break',
                durationMinutes: 10,
                isBreak: true,
            });
        expect(plan.writes.find((write) => write.path === `active_sessions/${userId}`).data)
            .toMatchObject({
                status: 'active',
                revision: 7,
                run: {
                    runId: 'run-after-break',
                    type: 'task',
                    taskId: 'task-a',
                },
            });
        expect(plan.writes.find((write) => write.path === 'tasks/task-a').data)
            .toMatchObject({
                timerStatus: 'running',
                timerStartedAt: '2026-07-09T08:15:00.000Z',
                timerRunId: 'run-after-break',
            });
        expect(plan.writes.find((write) => write.path === `users/${userId}`).data)
            .toMatchObject({
                activeSession: {
                    type: 'task',
                    taskId: 'task-a',
                    runId: 'run-after-break',
                },
                breakState: {
                    isTakingBreak: false,
                    dailyAccumulatedMinutes: 13,
                },
                workStatus: {
                    isWorking: true,
                    status: 'running',
                    activeTaskId: 'task-a',
                },
            });
    });

    it('starts a call by closing the active task and preserving it as the paused session', () => {
        const plan = planSecondaryStart({
            type: 'call',
            userId,
            userData: {
                ...idleUser,
                displayName: 'Worker A',
                workStatus: { isWorking: true, status: 'running', activeTaskId: 'task-a' },
            },
            activeRecord: {
                userId,
                revision: 10,
                status: 'active',
                run: {
                    runId: 'run-task-before-call',
                    type: 'task',
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    startedAt: '2026-07-09T08:00:00.000Z',
                    revision: 10,
                },
            },
            currentTask: {
                ...baseTask,
                timerStatus: 'running',
                timerStartedAt: '2026-07-09T08:00:00.000Z',
            },
            commandId: 'cmd-start-call',
            runId: 'run-call',
            issuedAt: '2026-07-09T08:05:00.000Z',
        });

        expect(plan.command).toMatchObject({
            kind: 'start-call',
            expectedRevision: 10,
            expectedRunId: 'run-task-before-call',
        });
        expect(plan.writes.find((write) => write.path === 'work_sessions/sess_run_run-task-before-call').data)
            .toMatchObject({ durationMinutes: 5 });
        expect(plan.writes.find((write) => write.path === `active_sessions/${userId}`).data)
            .toMatchObject({
                status: 'active',
                revision: 11,
                run: {
                    type: 'call',
                    runId: 'run-call',
                    pausedSession: { type: 'task', taskId: 'task-a' },
                },
            });
        expect(plan.writes.find((write) => write.path === `users/${userId}`).data)
            .toMatchObject({
                activeSession: {
                    type: 'call',
                    runId: 'run-call',
                    pausedSession: { type: 'task', taskId: 'task-a' },
                },
                callState: { isCalling: true },
                workStatus: { status: 'paused', activeTaskId: 'task-a' },
            });
    });

    it('ends a classified call and restores the paused task as a fresh run', () => {
        const plan = planSecondaryEnd({
            type: 'call',
            userId,
            userData: { ...idleUser, displayName: 'Worker A', callState: { isCalling: true } },
            activeRecord: {
                userId,
                revision: 11,
                status: 'active',
                run: {
                    runId: 'run-call',
                    type: 'call',
                    startedAt: '2026-07-09T08:05:00.000Z',
                    revision: 11,
                    pausedSession: {
                        type: 'task',
                        taskId: 'task-a',
                        taskTitle: 'Task A',
                        runId: 'run-task-before-call',
                    },
                },
            },
            restoreTask: { ...baseTask, timerStatus: 'paused', timerMinutes: 5 },
            commandId: 'cmd-end-call',
            runId: 'run-task-after-call',
            issuedAt: '2026-07-09T08:15:00.000Z',
            contactType: 'client',
            callNotes: 'Discussed delivery',
        });

        expect(plan.creditedMinutes).toBe(10);
        expect(plan.writes.find((write) => write.path === `tasks/${plan.createdTaskId}`).data)
            .toMatchObject({
                contactType: 'client',
                status: 'confirmed',
                manualMinutes: 10,
                isSystemTask: true,
            });
        expect(plan.writes.find((write) => write.path === `work_sessions/${plan.workSessionId}`).data)
            .toMatchObject({
                contactType: 'client',
                durationMinutes: 10,
                isSystemTask: true,
            });
        expect(plan.writes.find((write) => write.path === 'tasks/task-a').data)
            .toMatchObject({
                timerStatus: 'running',
                timerRunId: 'run-task-after-call',
            });
    });

    it('starts quick work over a break by banking the break and nesting it for restore', () => {
        const plan = planSecondaryStart({
            type: 'quickWork',
            userId,
            userData: {
                ...idleUser,
                displayName: 'Worker A',
                breakState: { isTakingBreak: true, dailyAccumulatedMinutes: 4 },
            },
            activeRecord: {
                userId,
                revision: 2,
                status: 'active',
                run: {
                    runId: 'run-break-before-quick',
                    type: 'break',
                    startedAt: '2026-07-09T08:00:00.000Z',
                    revision: 2,
                    pausedSession: { type: 'task', taskId: 'task-a' },
                },
            },
            commandId: 'cmd-start-quick-over-break',
            runId: 'run-quick',
            issuedAt: '2026-07-09T08:05:00.000Z',
        });

        expect(plan.closedBreakMinutes).toBe(5);
        expect(plan.writes.find((write) => write.path === 'break_sessions/sess_break_run_run-break-before-quick').data)
            .toMatchObject({ durationMinutes: 5 });
        expect(plan.writes.find((write) => write.path === `active_sessions/${userId}`).data.run)
            .toMatchObject({
                type: 'quickWork',
                pausedSession: {
                    type: 'break',
                    pausedSession: { type: 'task', taskId: 'task-a' },
                },
            });
        expect(plan.writes.find((write) => write.path === `users/${userId}`).data)
            .toMatchObject({
                quickWorkState: { isQuickWorking: true },
                breakState: {
                    isTakingBreak: false,
                    dailyAccumulatedMinutes: 9,
                },
            });
    });

    it('ends described quick work, writes its task/session pair, and returns manager notification metadata', () => {
        const plan = planSecondaryEnd({
            type: 'quickWork',
            userId,
            userData: {
                ...idleUser,
                displayName: 'Worker A',
                role: 'worker',
                defaultManager: 'manager-a',
                quickWorkState: { isQuickWorking: true },
            },
            activeRecord: {
                userId,
                revision: 1,
                status: 'active',
                run: {
                    runId: 'run-quick',
                    type: 'quickWork',
                    startedAt: '2026-07-09T08:00:00.000Z',
                    revision: 1,
                    pausedSession: null,
                },
            },
            commandId: 'cmd-end-quick',
            issuedAt: '2026-07-09T08:08:00.000Z',
            customTitle: 'Tvarka',
            customComment: 'Sutvarkiau lentynas',
            auditorManagerId: 'manager-a',
        });

        expect(plan.creditedMinutes).toBe(8);
        expect(plan.quickWorkNotification).toMatchObject({
            recipientId: 'manager-a',
            taskTitle: 'Tvarka',
            actualMinutes: 8,
        });
        expect(plan.writes.find((write) => write.path === `tasks/${plan.createdTaskId}`).data)
            .toMatchObject({
                title: 'Tvarka',
                status: 'completed',
                managerId: 'manager-a',
                manualMinutes: 8,
                isQuickWork: true,
                workSessionId: plan.workSessionId,
            });
        expect(plan.writes.find((write) => write.path === `work_sessions/${plan.workSessionId}`).data)
            .toMatchObject({
                taskTitle: 'Tvarka',
                durationMinutes: 8,
                isQuickWork: true,
            });
        expect(plan.writes.find((write) => write.path === `active_sessions/${userId}`).data)
            .toMatchObject({ status: 'idle', revision: 2 });
    });

    it('synthesizes a stable revision-0 compatibility run from a legacy session', () => {
        const legacy = canonicalSessionState(null, {
            id: userId,
            activeSession: {
                type: 'task',
                taskId: 'task-a',
                taskTitle: 'Task A',
                startTime: '2026-07-09T08:00:00.000Z',
            },
        });

        expect(legacy).toMatchObject({
            revision: 0,
            status: 'active',
            run: {
                type: 'task',
                taskId: 'task-a',
                startedAt: '2026-07-09T08:00:00.000Z',
            },
        });
        expect(legacy.run.runId).toBe('legacy_task_task-a_1783584000000');
    });

    it.each([1, 5, 120])(
        'recovers after %i minutes by crediting the old run and opening a fresh running segment',
        (minutes) => {
            const startedAt = '2026-07-09T08:00:00.000Z';
            const recoveredAt = new Date(
                new Date(startedAt).getTime() + minutes * 60000
            ).toISOString();
            const plan = planTaskRecover({
                task: {
                    ...baseTask,
                    timerStatus: 'running',
                    timerStartedAt: startedAt,
                    timerLastHeartbeat: startedAt,
                },
                userId,
                userData: idleUser,
                activeRecord: {
                    userId,
                    revision: 3,
                    status: 'active',
                    run: {
                        runId: 'run-before-crash',
                        type: 'task',
                        taskId: 'task-a',
                        taskTitle: 'Task A',
                        startedAt,
                        revision: 3,
                    },
                },
                commandId: `cmd-recover-${minutes}`,
                runId: `run-after-recovery-${minutes}`,
                issuedAt: recoveredAt,
                recoveredAt,
            });

            expect(plan.command).toMatchObject({
                kind: 'recover',
                expectedRevision: 3,
                expectedRunId: 'run-before-crash',
            });
            expect(plan.creditedMinutes).toBe(minutes);
            expect(plan.writes.find((write) =>
                write.path === `active_sessions/${userId}`
            ).data).toMatchObject({
                revision: 4,
                status: 'active',
                run: {
                    runId: `run-after-recovery-${minutes}`,
                    startedAt: recoveredAt,
                },
            });
            expect(plan.writes.find((write) => write.path === 'tasks/task-a').data)
                .toMatchObject({
                    timerStatus: 'running',
                    timerStartedAt: recoveredAt,
                    timerMinutes: minutes,
                });
            expect(plan.recoveredGap).toMatchObject({
                sessionId: 'sess_gap_run_run-before-crash',
                gapMinutes: minutes,
            });
        }
    );

    it('caps a split-heartbeat recovery run to one MAX_SESSION_MINUTES budget (R-03)', () => {
        // Orphaned run: started at 0h, last heartbeat at 15h, recovered at 30h. The proven
        // segment (15h) and the post-heartbeat gap (15h) must NOT each be clamped to 16h and
        // summed (that credited 30h); the whole run shares one 960-minute ceiling.
        const startedAt = '2026-07-09T00:00:00.000Z';
        const startMs = new Date(startedAt).getTime();
        const heartbeatAt = new Date(startMs + 15 * 60 * 60000).toISOString();
        const recoveredAt = new Date(startMs + 30 * 60 * 60000).toISOString();
        const plan = planTaskRecover({
            task: {
                ...baseTask,
                timerStatus: 'running',
                timerStartedAt: startedAt,
                timerLastHeartbeat: heartbeatAt,
            },
            userId,
            userData: idleUser,
            activeRecord: {
                userId,
                revision: 3,
                status: 'active',
                run: {
                    runId: 'run-before-crash',
                    type: 'task',
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    startedAt,
                    revision: 3,
                },
            },
            commandId: 'cmd-recover-split',
            runId: 'run-after-recovery-split',
            issuedAt: recoveredAt,
            recoveredAt,
        });

        // Total credited time across both ledger rows must not exceed the 16h ceiling.
        expect(plan.creditedMinutes).toBeLessThanOrEqual(960);
        expect(plan.creditedMinutes).toBe(960);
        // The task projection must reflect the same single-budget total (baseTask starts at 0).
        expect(plan.writes.find((write) => write.path === 'tasks/task-a').data.timerMinutes)
            .toBe(960);
        // Neither individual ledger row may exceed the ceiling either.
        const provenRow = plan.writes.find((w) => w.path === 'work_sessions/sess_run_run-before-crash');
        const gapRow = plan.writes.find((w) => w.path === 'work_sessions/sess_gap_run_run-before-crash');
        expect(provenRow.data.durationMinutes).toBeLessThanOrEqual(960);
        expect(gapRow.data.durationMinutes).toBeLessThanOrEqual(960);
        expect(provenRow.data.durationMinutes + gapRow.data.durationMinutes).toBe(960);
    });

    it('finishes the active task, ledger, canonical session, and user projection atomically', () => {
        const plan = planTaskEnd({
            task: {
                ...baseTask,
                timerStatus: 'running',
                timerStartedAt: '2026-07-09T08:00:00.000Z',
                timerMinutes: 10,
            },
            userId,
            userData: idleUser,
            activeRecord: {
                userId,
                revision: 8,
                status: 'active',
                run: {
                    runId: 'run-finish',
                    type: 'task',
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    startedAt: '2026-07-09T08:00:00.000Z',
                    revision: 8,
                },
            },
            commandId: 'cmd-finish',
            issuedAt: '2026-07-09T08:05:00.000Z',
        });

        expect(plan.command).toMatchObject({
            kind: 'end-task',
            expectedRevision: 8,
            expectedRunId: 'run-finish',
        });
        expect(plan.closedSessionId).toBe('sess_run_run-finish');
        expect(plan.finalTimerMinutes).toBe(15);
        expect(plan.writes.find((write) => write.path === 'tasks/task-a').data)
            .toMatchObject({
                completed: true,
                status: 'completed',
                timerMinutes: 15,
                timeLimitReached: false,
            });
        expect(plan.writes.find((write) =>
            write.path === `active_sessions/${userId}`
        ).data).toMatchObject({
            status: 'idle',
            revision: 9,
        });
    });
});
