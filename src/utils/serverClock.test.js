import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CLOCK_TRUST_BAND_MS,
    __resetServerClockForTests,
    isServerClockSynced,
    serverClockOffsetMs,
    serverNowISO,
    serverNowMs,
    syncServerClock,
    awaitServerClock,
    toServerFrame,
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

// Boot-time code — orphan recovery — stamps without any human waiting on it, so it is the one path
// that can run inside the window where the fire-and-forget probe has not landed. Unanchored, its
// endTime is refused by the rules and the run is left stuck ACTIVE: neither stoppable nor
// restartable on that device. These cases pin the two pieces that close that window.
describe('awaitServerClock — the boot-time gate before anything is stamped', () => {
    it('waits for the first probe, so a boot-time stamp lands in the server frame', async () => {
        globalThis.fetch = serverAt(CLIENT_NOW - 10 * MIN);

        await awaitServerClock();

        expect(isServerClockSynced()).toBe(true);
        expect(serverNowMs()).toBe(CLIENT_NOW - 10 * MIN + MIDPOINT);
    });

    it('joins the in-flight boot probe instead of issuing a second one', async () => {
        const fetchMock = serverAt(CLIENT_NOW);
        globalThis.fetch = fetchMock;

        await Promise.all([syncServerClock(), awaitServerClock(), awaitServerClock()]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns immediately once anchored — no probe, no wait', async () => {
        const fetchMock = serverAt(CLIENT_NOW - 10 * MIN);
        globalThis.fetch = fetchMock;
        await syncServerClock();

        await awaitServerClock();

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('gives up rather than hanging the app when no probe can land', async () => {
        // Offline: the probe never resolves. Recovery must still proceed — timing out lands exactly
        // where callers were before this gate existed, which is strictly better than never running.
        globalThis.fetch = vi.fn(() => new Promise(() => {}));

        const settled = awaitServerClock(4000);
        await vi.advanceTimersByTimeAsync(4000);

        await expect(settled).resolves.toBe(0);
        expect(isServerClockSynced()).toBe(false);
    });
});

// The app's boot instant is the one value that CANNOT be server-anchored when it is taken (module
// evaluation predates any probe), yet recovery compares it against server-anchored starts and
// heartbeats. Left unconverted on a device a few minutes fast, a beat written seconds ago reads as
// being in the future — so a live, beating run reads as having no proof of life and every boot
// stops it. That is the reported "the timer stops when I sign in on the PC".
describe('toServerFrame — re-expressing the boot instant', () => {
    it('is a no-op while the device is trusted', () => {
        expect(toServerFrame(CLIENT_NOW)).toBe(CLIENT_NOW);
    });

    it('shifts a FAST device\'s boot instant back, so its own fresh beat is not read as future', async () => {
        globalThis.fetch = serverAt(CLIENT_NOW - 10 * MIN);
        await syncServerClock();

        // A beat this device stamps NOW carries serverNowMs(). Recovery asks "is the beat before
        // now?" — true only because the boot instant moved into the same frame.
        const bootInServerFrame = toServerFrame(CLIENT_NOW - 60 * MIN);
        expect(bootInServerFrame).toBe(CLIENT_NOW - 70 * MIN + MIDPOINT);
        expect(serverNowMs()).toBeGreaterThan(bootInServerFrame);
    });
});
