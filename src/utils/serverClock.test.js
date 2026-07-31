import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CLOCK_TRUST_BAND_MS,
    __resetServerClockForTests,
    isServerClockSynced,
    serverClockOffsetMs,
    serverNowISO,
    serverNowMs,
    syncServerClock,
} from './serverClock';

// These cases exist because the failure they prevent is invisible until it costs someone their pay:
// a device whose clock runs fast has EVERY session close refused by firestore.rules
// (endTimeNotInServerFuture), and the worker simply cannot stop their timer. The anchor is what
// makes the stamp land in the server's frame instead of the device's.

const MIN = 60 * 1000;
// A whole-second client instant, so the header's second-truncation introduces no rounding noise and
// every expected offset below can be written exactly.
const CLIENT_NOW = new Date('2026-07-31T12:00:00.000Z').getTime();
// One probe's Date header is truncated to the second, so the true instant is somewhere in the
// following second; the module takes the midpoint. Every exact expectation carries this term.
const MIDPOINT = 500;

/** A probe that answers with `serverMs` on its `Date` header, exactly as an HTTP response would. */
const serverAt = (serverMs) => vi.fn(async () => ({
    headers: { get: (name) => (name.toLowerCase() === 'date' ? new Date(serverMs).toUTCString() : null) },
}));

beforeEach(() => {
    __resetServerClockForTests();
    vi.useFakeTimers();
    vi.setSystemTime(CLIENT_NOW);
});

afterEach(() => {
    vi.useRealTimers();
    delete globalThis.fetch;
});

describe('serverClock', () => {
    it('uses the device clock verbatim until a probe lands', () => {
        expect(serverClockOffsetMs()).toBe(0);
        expect(serverNowMs()).toBe(CLIENT_NOW);
        expect(isServerClockSynced()).toBe(false);
    });

    it('pulls a FAST device back to server time — the case that loses a stop', async () => {
        // The device believes it is 12:00; the server says 11:50. Every stamp must land at 11:50.
        globalThis.fetch = serverAt(CLIENT_NOW - 10 * MIN);

        await syncServerClock();

        expect(serverClockOffsetMs()).toBe(-10 * MIN + MIDPOINT);
        expect(serverNowMs()).toBe(CLIENT_NOW - 10 * MIN + MIDPOINT);
        expect(serverNowISO().startsWith('2026-07-31T11:50:00')).toBe(true);
        expect(isServerClockSynced()).toBe(true);
    });

    it('pushes a SLOW device forward too — the anchor is not one-directional', async () => {
        globalThis.fetch = serverAt(CLIENT_NOW + 7 * MIN);

        await syncServerClock();

        expect(serverClockOffsetMs()).toBe(7 * MIN + MIDPOINT);
    });

    it('leaves an ordinary-drift device EXACTLY untouched (offset snaps to zero, not to noise)', async () => {
        globalThis.fetch = serverAt(CLIENT_NOW - 2000);

        await syncServerClock();

        // A healthy device must behave byte-identically to how it did before this module existed —
        // a fractional offset would perturb every stamped, deduped and credited instant for nothing.
        expect(serverClockOffsetMs()).toBe(0);
        expect(serverNowMs()).toBe(CLIENT_NOW);
    });

    it('keeps the anchor still when a re-probe only differs by measurement noise', async () => {
        globalThis.fetch = serverAt(CLIENT_NOW - 10 * MIN);
        await syncServerClock();
        const anchored = serverClockOffsetMs();

        // Same skew, one second of jitter. Re-seating the anchor here would step serverNowMs()
        // BACKWARDS mid-session, which is how a real interval turns into a negative one.
        globalThis.fetch = serverAt(CLIENT_NOW - 10 * MIN - 1000);
        await syncServerClock();

        expect(serverClockOffsetMs()).toBe(anchored);
    });

    it('re-anchors when the device clock is actually corrected', async () => {
        globalThis.fetch = serverAt(CLIENT_NOW - 10 * MIN);
        await syncServerClock();
        expect(serverClockOffsetMs()).toBeLessThan(-CLOCK_TRUST_BAND_MS);

        // Someone pressed "sync now" on the machine: the device and the server now agree.
        globalThis.fetch = serverAt(CLIENT_NOW);
        await syncServerClock();

        expect(serverClockOffsetMs()).toBe(0);
    });

    it('keeps the previous anchor when the probe fails — never throws, never guesses', async () => {
        globalThis.fetch = serverAt(CLIENT_NOW - 10 * MIN);
        await syncServerClock();
        const anchored = serverClockOffsetMs();

        globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        await expect(syncServerClock()).resolves.toBe(anchored);
        expect(serverClockOffsetMs()).toBe(anchored);
    });

    it('ignores a response with no usable Date header', async () => {
        globalThis.fetch = vi.fn(async () => ({ headers: { get: () => null } }));

        await syncServerClock();

        expect(serverClockOffsetMs()).toBe(0);
        expect(isServerClockSynced()).toBe(false);
    });

    it('discards a sample whose round trip is too slow to place accurately', async () => {
        globalThis.fetch = vi.fn(async () => {
            vi.setSystemTime(Date.now() + 20000);   // 20s round trip → ±10s of placement error
            return { headers: { get: () => new Date(CLIENT_NOW - 10 * MIN).toUTCString() } };
        });

        await syncServerClock();

        expect(serverClockOffsetMs()).toBe(0);
    });

    it('shares one probe between concurrent callers', async () => {
        const fetchMock = serverAt(CLIENT_NOW - 10 * MIN);
        globalThis.fetch = fetchMock;

        await Promise.all([syncServerClock(), syncServerClock(), syncServerClock()]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never repeats a probe URL — a cached response would carry a stale Date header', async () => {
        const fetchMock = serverAt(CLIENT_NOW);
        globalThis.fetch = fetchMock;

        await syncServerClock();
        await syncServerClock();

        const [first] = fetchMock.mock.calls[0];
        const [second] = fetchMock.mock.calls[1];
        expect(first).not.toBe(second);
        // And it must bypass the HTTP cache as well as the service worker's URL matching.
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    });
});
