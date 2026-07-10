import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    applyTimerTransitionPlan: vi.fn(),
    getDocFromCache: vi.fn(),
    getDocFromServer: vi.fn(),
    listQueuedTimerCommands: vi.fn(),
    updateTimerCommandStatus: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, ...parts) => ({ path: parts.join('/') })),
    getDocFromCache: mocks.getDocFromCache,
    getDocFromServer: mocks.getDocFromServer,
}));
vi.mock('./errorLog', () => ({ logError: vi.fn() }));
vi.mock('./timerOutbox', () => ({
    enqueueTimerCommand: vi.fn(),
    listQueuedTimerCommands: mocks.listQueuedTimerCommands,
    updateTimerCommandStatus: mocks.updateTimerCommandStatus,
}));
vi.mock('./timerTransitionExecutor', () => ({
    applyTimerTransitionPlan: mocks.applyTimerTransitionPlan,
}));

const entry = (suffix) => ({
    commandId: `cmd-${suffix}`,
    userId: 'worker-a',
    kind: 'start-task',
    issuedAt: `2026-07-09T08:00:0${suffix}.000Z`,
    expectedRevision: Number(suffix) - 1,
    plan: {
        command: { commandId: `cmd-${suffix}` },
        writes: [{ type: 'set', path: `active_sessions/worker-a-${suffix}`, data: {} }],
    },
});

describe('timer command boot replay', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.updateTimerCommandStatus.mockResolvedValue({});
    });

    it('issues every missing queued plan without awaiting the first remote acknowledgement', async () => {
        const neverSettles = new Promise(() => {});
        mocks.listQueuedTimerCommands.mockResolvedValue([entry('1'), entry('2')]);
        mocks.getDocFromCache.mockRejectedValue(new Error('not cached'));
        mocks.applyTimerTransitionPlan.mockReturnValue(neverSettles);

        const { replayQueuedTimerCommands } = await import('./timerCommandEngine');
        const results = await replayQueuedTimerCommands('worker-a');

        expect(mocks.applyTimerTransitionPlan).toHaveBeenCalledTimes(2);
        expect(results).toEqual([
            expect.objectContaining({ status: 'queued', commandId: 'cmd-1' }),
            expect.objectContaining({ status: 'queued', commandId: 'cmd-2' }),
        ]);
    });

    it('does not duplicate a batch already persisted in Firestore local pending writes', async () => {
        mocks.listQueuedTimerCommands.mockResolvedValue([entry('3')]);
        mocks.getDocFromCache.mockResolvedValue({
            exists: () => true,
            metadata: { hasPendingWrites: true },
        });
        mocks.getDocFromServer.mockReturnValue(new Promise(() => {}));

        const { replayQueuedTimerCommands } = await import('./timerCommandEngine');
        const results = await replayQueuedTimerCommands('worker-a');

        expect(mocks.applyTimerTransitionPlan).not.toHaveBeenCalled();
        expect(results[0]).toMatchObject({ status: 'queued', commandId: 'cmd-3' });
    });
});
