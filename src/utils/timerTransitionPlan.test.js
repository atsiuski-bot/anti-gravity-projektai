import { describe, expect, it } from 'vitest';
import {
    canonicalSessionState,
    planBreakEnd,
    planBreakStart,
    planSecondaryEnd,
    planSecondaryStart,
    planTaskEnd,
    planManagerForceEnd,
    planTaskPause,
    planTaskRecover,
    planTaskStart,
} from './timerTransitionPlan';
import { APP_INSTANCE_ID } from './appInstance';

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
                // lastDate is part of the fixture because production always has it: a running break
                // means a break START wrote the pair. Without it the total is undated, which is now
                // deliberately treated as "not today's" — a different case, covered separately.
                breakState: { isTakingBreak: true, dailyAccumulatedMinutes: 3, lastDate: '2026-07-09' },
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
                // Same-day pair — see the note on the break-end fixture above.
                breakState: { isTakingBreak: true, dailyAccumulatedMinutes: 4, lastDate: '2026-07-09' },
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
            // The whole run is credited either way — what changes is whether the timer survives.
            expect(plan.creditedMinutes).toBe(minutes);

            const active = plan.writes.find((w) => w.path === `active_sessions/${userId}`).data;
            const taskWrite = plan.writes.find((w) => w.path === 'tasks/task-a').data;

            if (minutes <= 3) {
                // BRIEF interruption (unproven tail within TIMER_HEARTBEAT_CONTINUE_MS): an
                // ordinary mid-shift reload. The run is real continuous work — credited as ONE
                // segment up to the reload instant, and re-anchored so the worker never restarts.
                // It must NOT be split into a gap row: that row is flagged isManualSession, i.e. a
                // "manual correction" the worker never made, and it used to be minted on EVERY
                // reload along with a banner asking whether they had really worked.
                expect(plan.resumed).toBe(true);
                expect(plan.recoveredGap).toBeNull();
                expect(active).toMatchObject({
                    revision: 4,
                    status: 'active',
                    run: { runId: `run-after-recovery-${minutes}`, startedAt: recoveredAt },
                });
                expect(taskWrite).toMatchObject({
                    timerStatus: 'running',
                    timerStartedAt: recoveredAt,
                    timerMinutes: minutes,
                });
                // The re-anchored run must be claimed, or the ownership rule in useTaskHeartbeat
                // refuses to beat it and it looks abandoned a minute later.
                expect(typeof taskWrite.timerOwnerInstance).toBe('string');
            } else {
                // GENUINELY CLOSED: the app was gone for longer than a skipped beat. The proven
                // stretch and the plausible gap are still credited, but the timer comes back
                // PAUSED — exactly as the legacy path does. Re-anchoring every orphan
                // unconditionally is how an unattended timer runs away.
                expect(plan.resumed).toBe(false);
                expect(active).toMatchObject({ revision: 4, status: 'idle', run: null });
                expect(taskWrite).toMatchObject({
                    timerStatus: 'paused',
                    timerStartedAt: null,
                    timerMinutes: minutes,
                });
                expect(plan.recoveredGap).toMatchObject({
                    sessionId: 'sess_gap_run_run-before-crash',
                    gapMinutes: minutes,
                });
            }
        }
    );

    // The defect this closes: the gap used to be whatever was LEFT of the 16h ceiling, not how long
    // the worker was actually away. A timer forgotten over a weekend therefore credited a full
    // 16-hour payday nobody worked. Legacy refuses any gap longer than one plausible shift; this
    // asserts canonical now agrees.
    it('refuses an implausible gap instead of paying out the leftover 16h budget', () => {
        const startedAt = '2026-07-10T14:00:00.000Z';       // Friday 17:00 Vilnius
        const startMs = new Date(startedAt).getTime();
        const heartbeatAt = new Date(startMs + 2 * 60000).toISOString();      // dies after 2 min
        const recoveredAt = new Date(startMs + 63 * 60 * 60000).toISOString(); // reopened Monday
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
            commandId: 'cmd-recover-weekend',
            runId: 'run-after-weekend',
            issuedAt: recoveredAt,
            recoveredAt,
        });

        // Only the two proven minutes are credited — not the 958 minutes the leftover budget
        // would have handed over, and certainly not as a row claiming a 63-hour span.
        expect(plan.creditedMinutes).toBe(2);
        expect(plan.recoveredGap).toBeNull();
        expect(plan.writes.some((w) => w.path.includes('sess_gap_run_'))).toBe(false);
        // …and a run abandoned for three days comes back stopped.
        expect(plan.resumed).toBe(false);
    });

    it('caps a split-heartbeat recovery run to one MAX_SESSION_MINUTES budget (R-03)', () => {
        // Orphaned run: started at 0h, last heartbeat at 15h, recovered at 19h. The proven segment
        // (15h = 900 min) and the post-heartbeat gap (4h = 240 min) must NOT each be clamped to 16h
        // and summed (that would credit 1140 min); the whole run shares one 960-minute ceiling, so
        // the gap may only take the 60 minutes the proven segment left of it.
        //
        // The gap here is 4h — the largest an untracked interval may now be (see
        // isCreditableUntrackedGap). It used to be 15h, which this rule now refuses outright; that
        // made the case unable to exercise the PARTITION at all, which is what it exists to prove.
        const startedAt = '2026-07-09T00:00:00.000Z';
        const startMs = new Date(startedAt).getTime();
        const heartbeatAt = new Date(startMs + 15 * 60 * 60000).toISOString();
        const recoveredAt = new Date(startMs + 19 * 60 * 60000).toISOString();
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
            });
        expect(plan.writes.find((write) =>
            write.path === `active_sessions/${userId}`
        ).data).toMatchObject({
            status: 'idle',
            revision: 9,
        });
    });

    // Regression (reported 2026-08-04) — handing in an OLD, already-worked task while a different
    // timer is running used to throw timer/conflict, so the worker's only route was to stop the live
    // timer first. Finishing a task that owns no live run is bookkeeping, not a session transition:
    // it must write the completion and touch NOTHING that describes the running activity.
    it('finishes a non-running task without disturbing another task that is live', () => {
        const liveRecord = {
            userId,
            revision: 8,
            status: 'active',
            run: {
                runId: 'run-other',
                type: 'task',
                taskId: 'task-other',
                taskTitle: 'Task Other',
                startedAt: '2026-08-04T08:00:00.000Z',
                revision: 8,
            },
        };
        const plan = planTaskEnd({
            task: { ...baseTask, timerStatus: 'paused', timerMinutes: 45 },
            userId,
            userData: idleUser,
            activeRecord: liveRecord,
            commandId: 'cmd-finish-other',
            issuedAt: '2026-08-04T09:00:00.000Z',
        });

        expect(plan.closedSessionId).toBeNull();
        expect(plan.finalTimerMinutes).toBe(45);
        expect(plan.writes.find((write) => write.path === 'tasks/task-a').data)
            .toMatchObject({ completed: true, status: 'completed', timerMinutes: 45 });
        // No ledger row — this finish closed no stretch of work.
        expect(plan.writes.some((write) => write.path.startsWith('work_sessions/'))).toBe(false);
        // The live run's canonical record and legacy projection are left exactly as they are.
        expect(plan.writes.some((write) => write.path === `active_sessions/${userId}`)).toBe(false);
        expect(plan.writes.some((write) => write.path === `users/${userId}`)).toBe(false);
        // The command marker records the UNCHANGED revision, so it can never be read as a transition.
        expect(plan.writes.find((write) =>
            write.path.startsWith(`users/${userId}/timer_commands/`)
        ).data).toMatchObject({ kind: 'end-task', expectedRevision: 8, appliedRevision: 8 });
    });

    // A break / call / quick-work is the same case: it keeps running while an old task is handed in.
    it('finishes a non-running task without ending a live break', () => {
        const plan = planTaskEnd({
            task: { ...baseTask, timerStatus: 'paused', timerMinutes: 20 },
            userId,
            userData: idleUser,
            activeRecord: {
                userId,
                revision: 3,
                status: 'active',
                run: {
                    runId: 'run-break',
                    type: 'break',
                    taskId: null,
                    startedAt: '2026-08-04T11:00:00.000Z',
                    revision: 3,
                },
            },
            commandId: 'cmd-finish-during-break',
            issuedAt: '2026-08-04T11:05:00.000Z',
        });

        expect(plan.writes.some((write) => write.path === `active_sessions/${userId}`)).toBe(false);
        expect(plan.writes.some((write) => write.path === `users/${userId}`)).toBe(false);
        expect(plan.writes.find((write) => write.path === 'tasks/task-a').data.completed).toBe(true);
    });

    // Regression — the unearned on_estimate badge (confirmed live 2026-07-26, task
    // dwwURIYzX3ibQEUJvL6y: 30.016 min against a 30min estimate, finished from the forced
    // limit popup, badge granted anyway). onTaskFinishedBadge withholds on_estimate on the
    // completed false→true edge only when `after.timeLimitReached !== true`, and this batch IS
    // that edge — so clearing the flag in the same write made the trigger blind to every limit
    // the worker had actually hit. Atomicity is the bug: the legacy path passes only because it
    // clears the flag in a separate LATER write. The completion batch must leave the flag alone.
    it('does not clear timeLimitReached in the completion batch (the on_estimate badge gate)', () => {
        const plan = planTaskEnd({
            task: {
                ...baseTask,
                timerStatus: 'running',
                timerStartedAt: '2026-07-09T08:00:00.000Z',
                timerMinutes: 25,
                estimatedTime: '30min',
                timeLimitReached: true,
            },
            userId,
            userData: idleUser,
            activeRecord: {
                userId,
                revision: 4,
                status: 'active',
                run: {
                    runId: 'run-limit-finish',
                    type: 'task',
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    startedAt: '2026-07-09T08:00:00.000Z',
                    revision: 4,
                },
            },
            commandId: 'cmd-limit-finish',
            issuedAt: '2026-07-09T08:06:00.000Z',
        });

        const taskWrite = plan.writes.find((write) => write.path === 'tasks/task-a').data;
        expect(taskWrite.completed).toBe(true);
        expect(
            taskWrite,
            'planTaskEnd clears timeLimitReached again — the badge trigger reads it on THIS edge, so an over-estimate finish would be awarded on_estimate'
        ).not.toHaveProperty('timeLimitReached');
    });
});

// Audit T-18 / T-01 — a manager force-end must RECORD what it closes, and must be able to close a
// run whose task no longer exists (the only escape hatch out of an orphaned canonical run).
describe('manager force-end records every run type', () => {
    const activeUser = (run) => ({
        id: userId,
        activeSession: null,
        workStatus: { isWorking: false, status: 'idle', activeTaskId: null },
        __run: run,
    });
    const recordFor = (run, revision = 4) => ({
        userId,
        revision,
        expectedRevision: revision - 1,
        expectedRunId: null,
        status: 'active',
        run,
        lastCommandId: 'cmd-prev',
        updatedAt: run.startedAt,
        engineVersion: 2,
    });

    it('writes a call ledger row instead of silently dropping the minutes', () => {
        const run = { runId: 'run-call', type: 'call', startedAt: '2026-07-09T08:00:00.000Z', revision: 4 };
        const plan = planManagerForceEnd({
            targetUser: activeUser(run),
            actorId: 'manager-1',
            activeRecord: recordFor(run),
            activeTask: null,
            commandId: 'cmd-force-call',
            issuedAt: '2026-07-09T08:30:00.000Z',
        });

        expect(plan.creditedMinutes).toBe(30);
        const ledger = plan.writes.find((w) => w.path.startsWith('work_sessions/sess_call_ws_'));
        expect(ledger).toBeTruthy();
        expect(ledger.data).toMatchObject({ userId, durationMinutes: 30 });
        expect(plan.writes.find((w) => w.path === `active_sessions/${userId}`).data)
            .toMatchObject({ status: 'idle', run: null });
    });

    it('writes an auto-stopped quick-work record the worker can describe later', () => {
        const run = { runId: 'run-qw', type: 'quickWork', startedAt: '2026-07-09T08:00:00.000Z', revision: 4 };
        const plan = planManagerForceEnd({
            targetUser: activeUser(run),
            actorId: 'manager-1',
            activeRecord: recordFor(run),
            activeTask: null,
            commandId: 'cmd-force-qw',
            issuedAt: '2026-07-09T09:00:00.000Z',
        });

        expect(plan.creditedMinutes).toBe(60);
        const ledger = plan.writes.find((w) => w.path.startsWith('work_sessions/sess_qw_ws_'));
        expect(ledger.data).toMatchObject({ userId, durationMinutes: 60 });
        const task = plan.writes.find((w) => w.path.startsWith('tasks/sess_qw_task_'));
        expect(task.data.title).toContain('Automatiškai');
    });

    // The BREAK arm of T-18: it was left projection-only because break_sessions had no manager-create
    // branch, so the row is only writable now that firestore.rules grants one. Two things must happen
    // together — the history row AND the day counter — or the break is silently free.
    it('writes a break ledger row and banks it into the day total', () => {
        const run = { runId: 'run-break', type: 'break', startedAt: '2026-07-09T08:00:00.000Z', revision: 4 };
        const plan = planManagerForceEnd({
            targetUser: {
                ...activeUser(run),
                breakState: { isTakingBreak: true, dailyAccumulatedMinutes: 15, lastDate: '2026-07-09' },
            },
            actorId: 'manager-1',
            activeRecord: recordFor(run),
            activeTask: null,
            commandId: 'cmd-force-break',
            issuedAt: '2026-07-09T08:20:00.000Z',
        });

        expect(plan.writes.find((w) => w.path === 'break_sessions/sess_break_run_run-break').data)
            .toMatchObject({ userId, durationMinutes: 20, isBreak: true, runId: 'run-break' });
        // A break is NOT payable, so the settle credits no work minutes...
        expect(plan.creditedMinutes).toBe(0);
        expect(plan.writes.some((w) => w.path.startsWith('work_sessions/'))).toBe(false);
        // ...but the day's break allowance must still see them.
        expect(plan.writes.find((w) => w.path === `users/${userId}`).data.breakState)
            .toMatchObject({ isTakingBreak: false, dailyAccumulatedMinutes: 35, lastDate: '2026-07-09' });
    });

    // The counter is touched ONLY by a break force-end; ending a call must leave yesterday's/today's
    // break total exactly as it stood, or every settle would silently re-date it.
    it('leaves the break day total untouched when the closed run is not a break', () => {
        const run = { runId: 'run-call-2', type: 'call', startedAt: '2026-07-09T08:00:00.000Z', revision: 4 };
        const plan = planManagerForceEnd({
            targetUser: {
                ...activeUser(run),
                breakState: { isTakingBreak: false, dailyAccumulatedMinutes: 15, lastDate: '2026-07-08' },
            },
            actorId: 'manager-1',
            activeRecord: recordFor(run),
            activeTask: null,
            commandId: 'cmd-force-call-2',
            issuedAt: '2026-07-09T08:20:00.000Z',
        });

        expect(plan.writes.find((w) => w.path === `users/${userId}`).data.breakState)
            .toEqual({ isTakingBreak: false, dailyAccumulatedMinutes: 15, lastDate: '2026-07-08' });
    });

    it('closes an orphaned task run whose task document was hard-deleted', () => {
        const run = {
            runId: 'run-orphan',
            type: 'task',
            taskId: 'task-gone',
            taskTitle: 'Deleted task',
            startedAt: '2026-07-09T08:00:00.000Z',
            revision: 4,
        };
        const plan = planManagerForceEnd({
            targetUser: activeUser(run),
            actorId: 'manager-1',
            activeRecord: recordFor(run),
            activeTask: null, // the task document is gone
            commandId: 'cmd-force-orphan',
            issuedAt: '2026-07-09T08:45:00.000Z',
        });

        // The credited time survives, keyed so the rules' taskCloseLedgerBound() is satisfied.
        const ledger = plan.writes.find((w) => w.path === 'work_sessions/sess_run_run-orphan');
        expect(ledger.data).toMatchObject({
            runId: 'run-orphan',
            taskId: 'task-gone',
            durationMinutes: 45,
            orphanedTaskClose: true,
        });
        // ...and no write targets the task that no longer exists.
        expect(plan.writes.some((w) => w.path.startsWith('tasks/'))).toBe(false);
        expect(plan.writes.find((w) => w.path === `active_sessions/${userId}`).data)
            .toMatchObject({ status: 'idle' });
    });

    // A force-end must settle the worker COMPLETELY — its whole purpose is to un-stick someone who
    // is stuck live, so unwinding one layer would leave them live on a break nobody is watching.
    // What it must not do is drop the stack in silence, hence `discardedStack` for the caller.
    it('ends a two-deep stack to idle and REPORTS what it discarded', () => {
        const run = {
            runId: 'run-call-top',
            type: 'call',
            startedAt: '2026-07-09T10:00:00.000Z',
            revision: 4,
            pausedSession: {
                type: 'break',
                startTime: '2026-07-09T09:30:00.000Z',
                pausedSession: {
                    type: 'task',
                    taskId: 'task-a',
                    taskTitle: 'Stogo remontas',
                    startTime: '2026-07-09T09:00:00.000Z',
                },
            },
        };
        const plan = planManagerForceEnd({
            targetUser: activeUser(run),
            actorId: 'manager-1',
            activeRecord: recordFor(run),
            activeTask: null,
            commandId: 'cmd-force-stack',
            issuedAt: '2026-07-09T10:20:00.000Z',
        });

        // Settled outright — no layer is popped, nothing is left running.
        expect(plan.writes.find((w) => w.path === `active_sessions/${userId}`).data)
            .toMatchObject({ status: 'idle', run: null });
        // Only the TOP run is credited here; everything below was already banked when it was
        // interrupted, so a force-end must not credit it a second time.
        expect(plan.creditedMinutes).toBe(20);
        expect(plan.writes.filter((w) => w.path.startsWith('work_sessions/'))).toHaveLength(1);
        // ...and the return path the worker loses is named, so the caller can tell them.
        expect(plan.discardedStack).toEqual([
            { type: 'break' },
            { type: 'task', taskId: 'task-a', taskTitle: 'Stogo remontas' },
        ]);
    });

    it('reports an empty discarded stack when nothing was parked', () => {
        const run = { runId: 'run-solo', type: 'call', startedAt: '2026-07-09T08:00:00.000Z', revision: 4 };
        const plan = planManagerForceEnd({
            targetUser: activeUser(run),
            actorId: 'manager-1',
            activeRecord: recordFor(run),
            activeTask: null,
            commandId: 'cmd-force-solo',
            issuedAt: '2026-07-09T08:10:00.000Z',
        });
        expect(plan.discardedStack).toEqual([]);
    });
});

// Audit T-02 — recovery must credit only to the last pre-boot proof of life, never to the reopen
// instant, and must never resume what an abandoned session had paused.
describe('secondary close honours an explicit credit boundary', () => {
    it('credits a call up to creditUntil, not the command instant', () => {
        const run = { runId: 'run-c', type: 'call', startedAt: '2026-07-09T08:00:00.000Z', revision: 2 };
        const plan = planSecondaryEnd({
            type: 'call',
            userId,
            userData: { id: userId },
            activeRecord: {
                userId, revision: 2, expectedRevision: 1, expectedRunId: null,
                status: 'active', run, lastCommandId: 'c', updatedAt: run.startedAt, engineVersion: 2,
            },
            commandId: 'cmd-recover-call',
            issuedAt: '2026-07-09T20:00:00.000Z',   // reopened 12h later
            creditUntil: '2026-07-09T08:20:00.000Z', // last heartbeat
            skipRestore: true,
        });

        expect(plan.creditedMinutes).toBe(20);
    });

    it('skipRestore ends straight to idle instead of resuming a paused task', () => {
        const run = {
            runId: 'run-q',
            type: 'quickWork',
            startedAt: '2026-07-09T08:00:00.000Z',
            revision: 2,
            pausedSession: { type: 'task', taskId: 'task-a', taskTitle: 'Task A' },
        };
        const plan = planSecondaryEnd({
            type: 'quickWork',
            userId,
            userData: { id: userId },
            activeRecord: {
                userId, revision: 2, expectedRevision: 1, expectedRunId: null,
                status: 'active', run, lastCommandId: 'c', updatedAt: run.startedAt, engineVersion: 2,
            },
            commandId: 'cmd-recover-qw',
            issuedAt: '2026-07-09T09:00:00.000Z',
            skipRestore: true,
        });

        expect(plan.restoredRunId).toBeNull();
        expect(plan.writes.find((w) => w.path === `active_sessions/${userId}`).data)
            .toMatchObject({ status: 'idle', run: null });
    });
});

// A task can be hard-deleted or archived WHILE its timer runs. The canonical record still points at
// that run, so every later transition is planned from it — and every planner used to refuse without
// the task document, which left the worker unable to start anything at all while the orphaned run
// kept accruing. Only a PROVABLY absent task may bypass the guard; a merely unreadable one (offline)
// must still refuse, or the close would silently drop the credited minutes from tasks/{id}.
describe('a task deleted mid-run must not wedge the worker', () => {
    const runningOnDeleted = {
        userId,
        revision: 6,
        status: 'active',
        run: {
            runId: 'run-gone',
            type: 'task',
            taskId: 'task-deleted',
            taskTitle: 'Deleted task',
            startedAt: '2026-07-09T08:00:00.000Z',
            revision: 6,
        },
    };
    const otherTask = { ...baseTask, id: 'task-b', title: 'Task B' };

    it('starting another task closes the orphaned run from the RUN itself', () => {
        const plan = planTaskStart({
            task: otherTask,
            userId,
            userData: idleUser,
            activeRecord: runningOnDeleted,
            previousTask: null,
            previousTaskMissing: true,
            commandId: 'cmd-switch',
            runId: 'run-new',
            issuedAt: '2026-07-09T08:30:00.000Z',
        });

        const ledger = plan.writes.find((w) => w.path === 'work_sessions/sess_run_run-gone');
        expect(ledger.data).toMatchObject({
            taskId: 'task-deleted',
            taskTitle: 'Deleted task',
            durationMinutes: 30,
            orphanedTaskClose: true,
        });
        // Nothing may be written to the task that no longer exists.
        expect(plan.writes.some((w) => w.path === 'tasks/task-deleted')).toBe(false);
        expect(plan.writes.some((w) => w.path === 'tasks/task-b')).toBe(true);
    });

    it('still refuses when the task is merely UNREADABLE, so credited minutes are never dropped', () => {
        expect(() => planTaskStart({
            task: otherTask,
            userId,
            userData: idleUser,
            activeRecord: runningOnDeleted,
            previousTask: null,
            commandId: 'cmd-switch',
            runId: 'run-new',
            issuedAt: '2026-07-09T08:30:00.000Z',
        })).toThrow(/atomic switch/);
    });

    it('lets a break and a secondary session start over the orphaned run too', () => {
        const breakPlan = planBreakStart({
            userId,
            userData: idleUser,
            activeRecord: runningOnDeleted,
            currentTask: null,
            currentTaskMissing: true,
            commandId: 'cmd-break',
            runId: 'run-break',
            issuedAt: '2026-07-09T08:30:00.000Z',
        });
        expect(breakPlan.writes.find((w) => w.path === 'work_sessions/sess_run_run-gone').data.durationMinutes)
            .toBe(30);

        const callPlan = planSecondaryStart({
            type: 'call',
            userId,
            userData: idleUser,
            activeRecord: runningOnDeleted,
            currentTask: null,
            currentTaskMissing: true,
            commandId: 'cmd-call',
            runId: 'run-call',
            issuedAt: '2026-07-09T08:30:00.000Z',
        });
        expect(callPlan.writes.find((w) => w.path === 'work_sessions/sess_run_run-gone').data.durationMinutes)
            .toBe(30);
    });

    it('a plain start claims the run for this app instance, or the heartbeat refuses to beat it', () => {
        const plan = planTaskStart({
            task: baseTask,
            userId,
            userData: idleUser,
            activeRecord: null,
            commandId: 'cmd-start',
            runId: 'run-owned',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        expect(plan.writes.find((w) => w.path === 'tasks/task-a').data.timerOwnerInstance)
            .toBe(APP_INSTANCE_ID);
    });
});

// breakState.dailyAccumulatedMinutes is a DAY total. Every writer used to carry the stored number
// forward verbatim while ALSO stamping lastDate to today, so the first break of a new day re-dated
// yesterday's total as today's and it grew day over day (production: 619 min against ~50 s taken).
// The pair (total, lastDate) must now always describe the SAME day.
describe('break day counter must not carry across the day boundary', () => {
    const YESTERDAY_TOTAL = 619.1034;
    const staleUser = {
        id: userId,
        activeSession: null,
        workStatus: { isWorking: false, status: 'idle', activeTaskId: null },
        breakState: {
            isTakingBreak: false,
            dailyAccumulatedMinutes: YESTERDAY_TOTAL,
            lastDate: '2026-07-08',
        },
    };
    const breakStateOf = (plan) =>
        plan.writes.find((w) => w.path === `users/${userId}`).data.breakState;

    it('starting a break on a NEW day rebases the total to zero before re-dating it', () => {
        const plan = planBreakStart({
            userId,
            userData: staleUser,
            activeRecord: null,
            commandId: 'cmd-break-newday',
            runId: 'run-break-newday',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        const bs = breakStateOf(plan);
        expect(bs.dailyAccumulatedMinutes, 'yesterday\'s total must not become today\'s').toBe(0);
        expect(bs.lastDate).toBe('2026-07-09');
    });

    it('keeps a SAME-day total, so a second break of the day still accumulates', () => {
        const sameDay = {
            ...staleUser,
            breakState: { ...staleUser.breakState, dailyAccumulatedMinutes: 12, lastDate: '2026-07-09' },
        };
        const plan = planBreakStart({
            userId,
            userData: sameDay,
            activeRecord: null,
            commandId: 'cmd-break-sameday',
            runId: 'run-break-sameday',
            issuedAt: '2026-07-09T08:00:00.000Z',
        });
        expect(breakStateOf(plan).dailyAccumulatedMinutes).toBe(12);
    });

    it('ending a break credits onto the rebased total and re-dates it in the same write', () => {
        const plan = planBreakEnd({
            userId,
            userData: staleUser,
            activeRecord: {
                userId,
                revision: 6,
                status: 'active',
                run: {
                    runId: 'run-break',
                    type: 'break',
                    startedAt: '2026-07-09T08:05:00.000Z',
                    revision: 6,
                    pausedSession: null,
                },
            },
            commandId: 'cmd-end-break-newday',
            issuedAt: '2026-07-09T08:15:00.000Z',
        });
        const bs = breakStateOf(plan);
        expect(bs.dailyAccumulatedMinutes, 'must be the 10 credited minutes alone').toBe(10);
        expect(bs.lastDate).toBe('2026-07-09');
    });

    it.each([
        ['a call', 'call'],
        ['a quick work', 'quickWork'],
    ])('%s interrupted by a break banks its minutes and nests, then resumes fresh', (_label, type) => {
        const startedAt = '2026-07-09T09:00:00.000Z';
        const interruptedAt = '2026-07-09T09:10:00.000Z';
        const startMs = new Date(startedAt).getTime();
        const ledgerPath = type === 'call'
            ? `work_sessions/sess_call_ws_${userId}_${startMs}`
            : `work_sessions/sess_qw_ws_${userId}_${startMs}`;
        const runningSecondary = {
            userId,
            revision: 7,
            status: 'active',
            run: { runId: 'run-secondary', type, startedAt, revision: 7, pausedSession: null },
        };

        const started = planBreakStart({
            userId,
            userData: staleUser,
            activeRecord: runningSecondary,
            commandId: 'cmd-break-over-secondary',
            runId: 'run-break-over',
            issuedAt: interruptedAt,
        });

        // The interrupted stretch is banked as its OWN complete record, keyed to its own start.
        expect(started.writes.find((w) => w.path === ledgerPath)?.data.durationMinutes).toBe(10);
        // ...and the session itself is nested, not destroyed.
        const nested = started.writes
            .find((w) => w.path === `active_sessions/${userId}`).data.run.pausedSession;
        expect(nested).toMatchObject({ type, startTime: startedAt });

        // Ending the break pops it back as a NEW run starting NOW — so the banked stretch and the
        // resumed stretch can never overlap or share a ledger id.
        const ended = planBreakEnd({
            userId,
            userData: staleUser,
            activeRecord: {
                userId,
                revision: 8,
                status: 'active',
                run: {
                    runId: 'run-break-over',
                    type: 'break',
                    startedAt: interruptedAt,
                    revision: 8,
                    pausedSession: nested,
                },
            },
            commandId: 'cmd-end-break-over',
            runId: 'run-secondary-resumed',
            issuedAt: '2026-07-09T09:15:00.000Z',
        });
        const resumed = ended.writes
            .find((w) => w.path === `active_sessions/${userId}`).data;
        expect(resumed.status).toBe('active');
        expect(resumed.run).toMatchObject({
            runId: 'run-secondary-resumed',
            type,
            startedAt: '2026-07-09T09:15:00.000Z',
        });
        // The break's own minutes still reach the day counter even though it did not pass idle.
        expect(breakStateOf(ended).dailyAccumulatedMinutes).toBe(5);
    });

    it('a quick work interrupted by a call keeps the two segments on DIFFERENT ledger ids', () => {
        const firstStart = '2026-07-09T10:00:00.000Z';
        const interruptedAt = '2026-07-09T10:20:00.000Z';
        const resumedAt = '2026-07-09T10:30:00.000Z';
        const idFor = (iso) => `work_sessions/sess_qw_ws_${userId}_${new Date(iso).getTime()}`;

        const interrupted = planSecondaryStart({
            type: 'call',
            userId,
            userData: staleUser,
            activeRecord: {
                userId,
                revision: 2,
                status: 'active',
                run: {
                    runId: 'run-qw-1',
                    type: 'quickWork',
                    startedAt: firstStart,
                    revision: 2,
                    pausedSession: null,
                },
            },
            commandId: 'cmd-call-over-qw',
            runId: 'run-call-over-qw',
            issuedAt: interruptedAt,
        });
        expect(interrupted.writes.find((w) => w.path === idFor(firstStart))?.data.durationMinutes)
            .toBe(20);

        // The resumed segment closes onto its OWN id — 20 + 15 minutes in two rows, never 35 in one
        // row twice.
        const finished = planSecondaryEnd({
            type: 'quickWork',
            userId,
            userData: staleUser,
            activeRecord: {
                userId,
                revision: 4,
                status: 'active',
                run: {
                    runId: 'run-qw-2',
                    type: 'quickWork',
                    startedAt: resumedAt,
                    revision: 4,
                    pausedSession: null,
                },
            },
            commandId: 'cmd-end-qw',
            issuedAt: '2026-07-09T10:45:00.000Z',
            customTitle: 'Tvarkos',
        });
        expect(finished.writes.find((w) => w.path === idFor(resumedAt))?.data.durationMinutes)
            .toBe(15);
        expect(finished.writes.some((w) => w.path === idFor(firstStart))).toBe(false);
    });

    it('keeps the task at the BOTTOM of a two-deep stack addressable', () => {
        const withTaskUnderBreak = {
            userId,
            revision: 5,
            status: 'active',
            run: {
                runId: 'run-break-deep',
                type: 'break',
                startedAt: '2026-07-09T11:00:00.000Z',
                revision: 5,
                pausedSession: {
                    type: 'task',
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    runId: 'run-task',
                    startTime: '2026-07-09T10:00:00.000Z',
                },
            },
        };
        const plan = planSecondaryStart({
            type: 'call',
            userId,
            userData: staleUser,
            activeRecord: withTaskUnderBreak,
            commandId: 'cmd-call-over-break-over-task',
            runId: 'run-call-deep',
            issuedAt: '2026-07-09T11:05:00.000Z',
        });
        // call ← break ← task: the projection must still name the task the worker will return to,
        // which a one-level-deep lookup reported as null.
        expect(plan.writes.find((w) => w.path === `users/${userId}`).data.workStatus.activeTaskId)
            .toBe('task-a');
    });

    it('refuses to nest a session inside one of the SAME type', () => {
        const runningCall = {
            userId,
            revision: 1,
            status: 'active',
            run: {
                runId: 'run-call',
                type: 'call',
                startedAt: '2026-07-09T12:00:00.000Z',
                revision: 1,
                pausedSession: null,
            },
        };
        expect(() => planSecondaryStart({
            type: 'call',
            userId,
            userData: staleUser,
            activeRecord: runningCall,
            commandId: 'cmd-call-on-call',
            runId: 'run-call-2',
            issuedAt: '2026-07-09T12:01:00.000Z',
        })).toThrow(/already running/i);

        expect(() => planBreakStart({
            userId,
            userData: staleUser,
            activeRecord: {
                ...runningCall,
                run: { ...runningCall.run, type: 'break', runId: 'run-break' },
            },
            commandId: 'cmd-break-on-break',
            runId: 'run-break-2',
            issuedAt: '2026-07-09T12:01:00.000Z',
        })).toThrow(/already running/i);
    });

    it('recovery closes an abandoned break WITHOUT resuming whatever it paused', () => {
        const plan = planBreakEnd({
            userId,
            userData: staleUser,
            activeRecord: {
                userId,
                revision: 9,
                status: 'active',
                run: {
                    runId: 'run-break-abandoned',
                    type: 'break',
                    startedAt: '2026-07-09T13:00:00.000Z',
                    revision: 9,
                    pausedSession: {
                        type: 'task',
                        taskId: 'task-a',
                        taskTitle: 'Task A',
                        runId: 'run-task',
                        startTime: '2026-07-09T12:00:00.000Z',
                    },
                },
            },
            commandId: 'cmd-recover-break',
            issuedAt: '2026-07-09T13:30:00.000Z',
            skipRestore: true,
        });
        // Previously this THREW (restoreTask null vs. a paused task), so an abandoned break that had
        // interrupted a task could never be closed canonically at all.
        expect(plan.writes.find((w) => w.path === `active_sessions/${userId}`).data.status)
            .toBe('idle');
        expect(plan.restoredRunId).toBeNull();
    });

    it('refuses a THIRD secondary layer at commit time, not just in the UI', () => {
        // The button consults the same rule, but against a snapshot another device may have moved
        // on from — so the planner is what actually keeps a forbidden stack out of canonical state.
        const twoDeep = {
            userId,
            revision: 3,
            status: 'active',
            run: {
                runId: 'run-call-deep',
                type: 'call',
                startedAt: '2026-07-09T14:00:00.000Z',
                revision: 3,
                pausedSession: {
                    type: 'break',
                    startTime: '2026-07-09T13:30:00.000Z',
                    pausedSession: { type: 'task', taskId: 'task-a', taskTitle: 'Task A' },
                },
            },
        };
        expect(() => planSecondaryStart({
            type: 'quickWork',
            userId,
            userData: staleUser,
            activeRecord: twoDeep,
            commandId: 'cmd-third-layer',
            runId: 'run-qw-third',
            issuedAt: '2026-07-09T14:05:00.000Z',
        })).toThrow(/stacked/i);
    });

    it('a call starting over a break banks the closed minutes onto the rebased total', () => {
        const plan = planSecondaryStart({
            type: 'call',
            userId,
            userData: staleUser,
            activeRecord: {
                userId,
                revision: 3,
                status: 'active',
                run: {
                    runId: 'run-break-2',
                    type: 'break',
                    startedAt: '2026-07-09T08:00:00.000Z',
                    revision: 3,
                    pausedSession: null,
                },
            },
            commandId: 'cmd-call-over-break',
            runId: 'run-call',
            issuedAt: '2026-07-09T08:04:00.000Z',
        });
        const bs = breakStateOf(plan);
        expect(bs.dailyAccumulatedMinutes).toBe(4);
        expect(bs.lastDate).toBe('2026-07-09');
    });
});

// The production case that forced the bound to change (2026-07-27). A timer was left running
// overnight; recovery next morning measured a 10.4-hour gap — comfortably UNDER the 16h SESSION
// ceiling the old rule reused — and credited all 623 minutes as work. The worker was asleep.
describe('an overnight gap is a forgotten timer, not silent work', () => {
    const OLD_START = '2026-07-26T19:18:43.000Z';   // 22:18 Vilnius
    const HEARTBEAT = '2026-07-26T19:18:43.401Z';   // died immediately after the re-anchor
    const RECOVERED = '2026-07-27T05:41:56.000Z';   // 08:41 Vilnius, next morning

    const overnightPlan = () => planTaskRecover({
        task: {
            ...baseTask,
            timerStatus: 'running',
            timerStartedAt: OLD_START,
            timerLastHeartbeat: HEARTBEAT,
            timerMinutes: 19.19,
        },
        userId,
        userData: idleUser,
        activeRecord: {
            userId,
            revision: 7,
            status: 'active',
            run: {
                runId: 'run-overnight',
                type: 'task',
                taskId: 'task-a',
                taskTitle: 'Task A',
                startedAt: OLD_START,
                revision: 7,
            },
        },
        commandId: 'cmd-recover-overnight',
        runId: 'run-after-overnight',
        issuedAt: RECOVERED,
        recoveredAt: RECOVERED,
    });

    it('writes NO recovered-gap row for the night', () => {
        const plan = overnightPlan();
        expect(plan.writes.some((w) => w.path.startsWith('work_sessions/sess_gap_run_'))).toBe(false);
        expect(plan.recoveredGap).toBeNull();
    });

    it('leaves the task counter untouched by the night — only proven time is credited', () => {
        const plan = overnightPlan();
        const taskWrite = plan.writes.find((w) => w.path === 'tasks/task-a').data;
        // 623 minutes must NOT appear here; the pre-existing 19.19 stands, plus a sub-second proven
        // sliver rounded away by the ledger's own minimum.
        expect(taskWrite.timerMinutes).toBeLessThan(20);
        expect(plan.creditedMinutes).toBeLessThan(1);
    });

    it('still comes back PAUSED — an unattended timer must never re-anchor itself', () => {
        const plan = overnightPlan();
        expect(plan.resumed).toBe(false);
        expect(plan.writes.find((w) => w.path === `active_sessions/${userId}`).data)
            .toMatchObject({ status: 'idle', run: null });
    });

    it('reports the refused interval so the worker can still CLAIM it deliberately', () => {
        const plan = overnightPlan();
        expect(plan.refusedGap).toMatchObject({ fromIso: HEARTBEAT, toIso: RECOVERED });
        expect(Math.round(plan.refusedGap.gapMinutes)).toBe(623);
    });

    it('a normal within-shift gap is unaffected — it still auto-credits', () => {
        const start = '2026-07-27T06:00:00.000Z';          // 09:00 Vilnius
        const beat = '2026-07-27T06:01:00.000Z';
        const back = '2026-07-27T06:41:00.000Z';           // 40 min later, same work day
        const plan = planTaskRecover({
            task: { ...baseTask, timerStatus: 'running', timerStartedAt: start, timerLastHeartbeat: beat },
            userId,
            userData: idleUser,
            activeRecord: {
                userId, revision: 2, status: 'active',
                run: { runId: 'run-shift', type: 'task', taskId: 'task-a', taskTitle: 'Task A', startedAt: start, revision: 2 },
            },
            commandId: 'cmd-recover-shift',
            runId: 'run-after-shift',
            issuedAt: back,
            recoveredAt: back,
        });
        expect(plan.recoveredGap).toMatchObject({ sessionId: 'sess_gap_run_run-shift' });
        expect(Math.round(plan.recoveredGap.gapMinutes)).toBe(40);
        expect(plan.refusedGap).toBeNull();
    });
});
