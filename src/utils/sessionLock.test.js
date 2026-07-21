import { describe, it, expect, vi, afterEach } from 'vitest';
import { withUserLock, LOCK_MAX_HOLD_MS } from './sessionLock';

// A manually-settleable promise so a test can hold a critical section open and assert that the
// next one for the same user has NOT started yet.
const deferred = () => {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
};

// Yield a few microtasks so any *incorrectly* un-serialized work would have had the chance to run.
const flushMicrotasks = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('withUserLock — per-user serialization of the activeSession write path', () => {
    // Several tests below drive the hold bound with fake timers; make sure the real clock is
    // restored so the surrounding (timer-free) cases are unaffected.
    afterEach(() => { vi.useRealTimers(); });


    it('runs two operations for the SAME user strictly one-at-a-time (the lost-update fix)', async () => {
        const order = [];
        const hold = deferred();

        const pA = withUserLock('u1', async () => {
            order.push('A:start');
            await hold.promise;       // keep the lock held open
            order.push('A:end');
        });
        const pB = withUserLock('u1', async () => {
            order.push('B:start');    // MUST NOT appear until A:end
            order.push('B:end');
        });

        // Even after the event loop drains its microtasks, B must still be queued behind A.
        await flushMicrotasks();
        expect(order).toEqual(['A:start']);

        hold.resolve();
        await Promise.all([pA, pB]);
        expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
    });

    it('does NOT serialize across DIFFERENT users (independent chains, no cross-user stall)', async () => {
        const order = [];
        const hold = deferred();

        const pA = withUserLock('u1', async () => { order.push('u1:start'); await hold.promise; order.push('u1:end'); });
        const pB = withUserLock('u2', async () => { order.push('u2:start'); order.push('u2:end'); });

        await flushMicrotasks();
        // u2 ran to completion while u1 still holds its own lock — they don't block each other.
        expect(order).toEqual(['u1:start', 'u2:start', 'u2:end']);

        hold.resolve();
        await Promise.all([pA, pB]);
        expect(order).toEqual(['u1:start', 'u2:start', 'u2:end', 'u1:end']);
    });

    it('a REJECTION in one critical section does not wedge the next op for that user', async () => {
        const order = [];
        const pA = withUserLock('u1', async () => { order.push('A'); throw new Error('boom'); });
        const pB = withUserLock('u1', async () => { order.push('B'); });

        await expect(pA).rejects.toThrow('boom');  // caller still sees the real rejection
        await pB;
        expect(order).toEqual(['A', 'B']);          // ...and B still ran after A failed
    });

    it('returns the wrapped function result to the caller', async () => {
        await expect(withUserLock('u1', async () => 42)).resolves.toBe(42);
    });

    it('runs immediately with no userId (nothing to serialize on)', async () => {
        await expect(withUserLock(null, async () => 'ok')).resolves.toBe('ok');
    });

    it('a NEVER-SETTLING critical section (unacknowledged offline write) does not wedge the queue', async () => {
        // The offline shape: Firestore applied the write locally but the mutation promise stays
        // pending until connectivity returns, so the critical section never finishes. Before the
        // hold bound this stalled EVERY later timer action for that worker, silently.
        vi.useFakeTimers();
        const order = [];
        const neverSettles = new Promise(() => {});

        withUserLock('u1', async () => { order.push('offline-break:start'); await neverSettles; });
        const pB = withUserLock('u1', async () => { order.push('later-task-start'); });

        // The first section is stuck and B is correctly still queued behind it.
        await vi.advanceTimersByTimeAsync(LOCK_MAX_HOLD_MS - 1);
        expect(order).toEqual(['offline-break:start']);

        // Once the hold budget is spent the queue moves on, even though A never settled.
        await vi.advanceTimersByTimeAsync(2);
        await pB;
        expect(order).toEqual(['offline-break:start', 'later-task-start']);
    });

    it('a settled section releases the next waiter immediately, not after the hold bound', async () => {
        // The bound is a backstop, never the normal path: online work must not wait 8 s.
        vi.useFakeTimers();
        const order = [];

        const pA = withUserLock('u1', async () => { order.push('A'); });
        const pB = withUserLock('u1', async () => { order.push('B'); });

        // No timer advancement at all — just let the microtask queue drain.
        await Promise.all([pA, pB]);
        expect(order).toEqual(['A', 'B']);
    });

    it('serializes a long same-user backlog in FIFO order', async () => {
        const order = [];
        const ops = [];
        for (let i = 0; i < 6; i++) {
            ops.push(withUserLock('u1', async () => {
                order.push(`${i}:start`);
                await Promise.resolve();   // a real async boundary inside each section
                order.push(`${i}:end`);
            }));
        }
        await Promise.all(ops);
        // Each op fully finishes (start THEN end) before the next starts — never interleaved.
        expect(order).toEqual([
            '0:start', '0:end', '1:start', '1:end', '2:start', '2:end',
            '3:start', '3:end', '4:start', '4:end', '5:start', '5:end',
        ]);
    });
});
