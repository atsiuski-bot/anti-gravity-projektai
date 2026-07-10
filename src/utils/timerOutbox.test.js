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
});
