import { beforeEach, describe, expect, it } from 'vitest';
import {
    clearMemoryTimerOutboxForTests,
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
