import { beforeEach, describe, expect, it } from 'vitest';
import {
    clearMemoryTimerOutboxForTests,
    describeTimerCommand,
    enqueueTimerCommand,
    listQueuedTimerCommands,
    updateTimerCommandStatus,
} from './timerOutbox';

describe('timer command outbox', () => {
    beforeEach(() => {
        clearMemoryTimerOutboxForTests();
    });

    it('persists the complete plan before exposing a queued command', async () => {
        const command = {
            commandId: 'cmd-a',
            userId: 'worker-a',
            kind: 'start-task',
            issuedAt: '2026-07-09T08:00:00.000Z',
        };
        const plan = { command, writes: [{ type: 'update', path: 'tasks/a', data: {} }] };

        await enqueueTimerCommand(command, plan);

        expect(await listQueuedTimerCommands('worker-a')).toEqual([
            expect.objectContaining({
                commandId: 'cmd-a',
                status: 'queued',
                plan,
            }),
        ]);
    });

    it('removes confirmed, rejected, and conflicted commands from the replay queue', async () => {
        for (const [index, status] of ['confirmed', 'rejected', 'conflicted'].entries()) {
            const command = {
                commandId: `cmd-${status}`,
                userId: 'worker-a',
                kind: 'pause-task',
                issuedAt: `2026-07-09T08:0${index}:00.000Z`,
            };
            await enqueueTimerCommand(command, { command, writes: [] });
            await updateTimerCommandStatus(command.commandId, status);
        }

        expect(await listQueuedTimerCommands('worker-a')).toEqual([]);
    });

    // Audit T-10 — replay order must survive a wall clock that repeats or goes BACKWARDS. Ordering by
    // issuedAt alone replayed a stop before its start, which the revision guard then rejects, leaving
    // the run active: ghost time the worker never worked.
    it('replays in issue order even when the clock repeats a millisecond', async () => {
        const sameInstant = '2026-07-09T08:00:00.000Z';
        for (const kind of ['start-task', 'pause-task']) {
            const command = { commandId: `cmd-${kind}`, userId: 'worker-a', kind, issuedAt: sameInstant };
            await enqueueTimerCommand(command, { command, writes: [] });
        }

        expect((await listQueuedTimerCommands('worker-a')).map((c) => c.kind))
            .toEqual(['start-task', 'pause-task']);
    });

    it('replays in issue order even when the clock rolls backwards between commands', async () => {
        const start = { commandId: 'cmd-start', userId: 'worker-a', kind: 'start-task', issuedAt: '2026-07-09T09:00:00.000Z' };
        await enqueueTimerCommand(start, { command: start, writes: [] });
        // NTP corrects the phone's clock an hour back before the matching stop is queued.
        const stop = { commandId: 'cmd-stop', userId: 'worker-a', kind: 'pause-task', issuedAt: '2026-07-09T08:00:00.000Z' };
        await enqueueTimerCommand(stop, { command: stop, writes: [] });

        expect((await listQueuedTimerCommands('worker-a')).map((c) => c.kind))
            .toEqual(['start-task', 'pause-task']);
    });

    it('keeps entries written before sequences existed ahead of new ones', async () => {
        const fresh = { commandId: 'cmd-new', userId: 'worker-a', kind: 'pause-task', issuedAt: '2026-07-09T07:00:00.000Z' };
        await enqueueTimerCommand(fresh, { command: fresh, writes: [] });

        expect((await listQueuedTimerCommands('worker-a'))[0].sequence).toBe(1);
    });
});

// A rejection notice that names only the ACTION ("Darbo užbaigimas failed") is unactionable: neither
// the worker nor the coordinator they report to can tell which stretch of the shift is missing. The
// transition plan already carries that, so the descriptor reads it back off the stored entry.
describe('describeTimerCommand (what a failed command was going to record)', () => {
    it('reads the task, interval and credited minutes off a CLOSING command\'s ledger write', () => {
        const entry = {
            issuedAt: '2026-07-27T15:00:00.000Z',
            plan: {
                writes: [
                    { type: 'update', path: 'tasks/t1', data: { timerStatus: 'paused' } },
                    {
                        type: 'set',
                        path: 'work_sessions/sess_run_r1',
                        data: {
                            taskTitle: 'Kostiumai',
                            startTime: '2026-07-27T14:00:00.000Z',
                            endTime: '2026-07-27T14:47:00.000Z',
                            durationMinutes: 47,
                        },
                    },
                ],
            },
        };

        expect(describeTimerCommand(entry)).toEqual({
            taskTitle: 'Kostiumai',
            startTime: '2026-07-27T14:00:00.000Z',
            endTime: '2026-07-27T14:47:00.000Z',
            durationMinutes: 47,
            issuedAt: '2026-07-27T15:00:00.000Z',
        });
    });

    it('falls back to the run an OPENING command would have started (it writes no ledger row)', () => {
        const entry = {
            issuedAt: '2026-07-27T09:00:00.000Z',
            plan: {
                writes: [{
                    type: 'set',
                    path: 'active_sessions/u1',
                    data: { run: { taskTitle: 'Piro', startedAt: '2026-07-27T09:00:00.000Z' } },
                }],
            },
        };

        const d = describeTimerCommand(entry);
        expect(d.taskTitle).toBe('Piro');
        expect(d.startTime).toBe('2026-07-27T09:00:00.000Z');
        expect(d.endTime).toBeNull();      // nothing was closed, so no interval end exists
        expect(d.durationMinutes).toBeNull();
    });

    // A notice that crashes is worse than one that is vague, so every unknown degrades to null.
    it('degrades to nulls rather than throwing on an entry with no usable plan', () => {
        expect(describeTimerCommand(undefined)).toEqual({
            taskTitle: null, startTime: null, endTime: null, durationMinutes: null, issuedAt: null,
        });
        expect(describeTimerCommand({ plan: { writes: 'not-an-array' } }).taskTitle).toBeNull();
        // A sub-minute close writes no duration; 0 must read as "nothing to show", not "0 min lost".
        expect(describeTimerCommand({
            plan: { writes: [{ path: 'work_sessions/x', data: { durationMinutes: 0 } }] },
        }).durationMinutes).toBeNull();
    });
});
