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

// `issuedAt` is relative to NOW, not a fixed date: replay refuses commands older than the 16h
// single-run ceiling, so a hard-coded fixture date would silently start failing as it aged.
const entry = (suffix, ageMs = 0) => ({
    commandId: `cmd-${suffix}`,
    userId: 'worker-a',
    kind: 'start-task',
    issuedAt: new Date(Date.now() - ageMs).toISOString(),
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

    // A rollback puts the worker back on the LEGACY writers, which never touch the canonical record —
    // so a command queued before the rollback still matches its expectedRevision days later and would
    // be accepted, re-opening a run their legacy session closed long ago.
    it('refuses to issue a command older than the 16h single-run ceiling, and says so', async () => {
        const { TIMER_COMMAND_MAX_REPLAY_AGE_MS } = await import('./timerCommandEngine');
        mocks.listQueuedTimerCommands.mockResolvedValue([entry('4', TIMER_COMMAND_MAX_REPLAY_AGE_MS + 60_000)]);
        mocks.getDocFromCache.mockRejectedValue(new Error('not cached'));

        const { replayQueuedTimerCommands } = await import('./timerCommandEngine');
        const results = await replayQueuedTimerCommands('worker-a');

        expect(mocks.applyTimerTransitionPlan).not.toHaveBeenCalled();
        expect(mocks.updateTimerCommandStatus).toHaveBeenCalledWith(
            'cmd-4', 'rejected', { errorCode: 'timer/stale-replay' }
        );
        // Surfaced, not silently dropped — TimerSyncNotice renders `rejected`.
        expect(results[0]).toMatchObject({ status: 'rejected', commandId: 'cmd-4' });
    });

    it('still lets an aged command through when Firestore already holds its pending write', async () => {
        const { TIMER_COMMAND_MAX_REPLAY_AGE_MS } = await import('./timerCommandEngine');
        mocks.listQueuedTimerCommands.mockResolvedValue([entry('5', TIMER_COMMAND_MAX_REPLAY_AGE_MS + 60_000)]);
        mocks.getDocFromCache.mockResolvedValue({
            exists: () => true,
            metadata: { hasPendingWrites: true },
        });
        mocks.getDocFromServer.mockReturnValue(new Promise(() => {}));

        const { replayQueuedTimerCommands } = await import('./timerCommandEngine');
        const results = await replayQueuedTimerCommands('worker-a');

        // Firestore's own queue will commit it regardless; calling it rejected would be a lie.
        expect(results[0]).toMatchObject({ status: 'queued', commandId: 'cmd-5' });
        expect(mocks.updateTimerCommandStatus).not.toHaveBeenCalledWith(
            'cmd-5', 'rejected', expect.anything()
        );
    });
});

describe('isStaleForReplay', () => {
    it('bounds a queued intent by the longest possible single run', async () => {
        const { isStaleForReplay, TIMER_COMMAND_MAX_REPLAY_AGE_MS } = await import('./timerCommandEngine');
        const NOW = Date.parse('2026-07-09T08:00:00.000Z');
        const at = (ms) => ({ issuedAt: new Date(ms).toISOString() });

        expect(isStaleForReplay(at(NOW - TIMER_COMMAND_MAX_REPLAY_AGE_MS + 1000), NOW)).toBe(false);
        expect(isStaleForReplay(at(NOW - TIMER_COMMAND_MAX_REPLAY_AGE_MS - 1000), NOW)).toBe(true);
    });

    it('leaves an unparseable issuedAt to the revision guards rather than guessing it is stale', async () => {
        const { isStaleForReplay } = await import('./timerCommandEngine');
        expect(isStaleForReplay({ issuedAt: 'nope' })).toBe(false);
        expect(isStaleForReplay({})).toBe(false);
    });
});
