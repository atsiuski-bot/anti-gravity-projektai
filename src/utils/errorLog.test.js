import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// errorLog is the durable "log of the breakage" the stateful session/timer paths write to on
// failure (findings #4/#5 wired logError into start/resume/pause/end). These tests pin the two
// invariants that make it trustworthy: it ACTUALLY persists (localStorage ring buffer +
// Firestore sink), and it can NEVER throw (a throwing logger would mask the crash it records).
//
// The module reads globalThis.localStorage / window / navigator at call time (not import time),
// so vi.stubGlobal gives it a controllable DOM surface in the node test environment — no jsdom
// needed. firebase is mocked so the Firestore sink is inspectable.
vi.mock('../firebase', () => ({ db: {}, auth: { currentUser: null } }));
vi.mock('firebase/firestore', () => ({
    collection: vi.fn((_db, name) => ({ _col: name })),
    addDoc: vi.fn(() => Promise.resolve()),
}));

import { addDoc, collection } from 'firebase/firestore';
import { auth } from '../firebase';
import { logError, getStoredErrorLog, clearStoredErrorLog } from './errorLog';

const makeLocalStorage = () => {
    let store = {};
    return {
        getItem: vi.fn((k) => (k in store ? store[k] : null)),
        setItem: vi.fn((k, v) => { store[k] = String(v); }),
        removeItem: vi.fn((k) => { delete store[k]; }),
    };
};

let ls;
beforeEach(() => {
    vi.clearAllMocks();
    addDoc.mockResolvedValue(undefined);
    ls = makeLocalStorage();
    vi.stubGlobal('localStorage', ls);
    vi.stubGlobal('window', { location: { href: 'http://test.local/page' } });
    vi.stubGlobal('navigator', { userAgent: 'vitest-UA', onLine: true });
    auth.currentUser = null;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('logError — durable persistence', () => {
    it('appends a normalized record to the localStorage ring buffer', () => {
        logError(new Error('single-fault'), { source: 'unit' });
        const log = getStoredErrorLog();
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({
            message: 'single-fault',
            source: 'unit',
            url: 'http://test.local/page',
            userAgent: 'vitest-UA',
            online: true,
        });
        expect(typeof log[0].timestamp).toBe('string');
    });

    it('writes the same record to the error_logs Firestore collection', () => {
        logError(new Error('to-firestore'), { source: 'snapshot' });
        expect(collection).toHaveBeenCalledWith(expect.anything(), 'error_logs');
        expect(addDoc).toHaveBeenCalledTimes(1);
        const record = addDoc.mock.calls[0][1];
        expect(record.message).toBe('to-firestore');
        expect(record.source).toBe('snapshot');
    });

    it('caps the ring buffer at the most recent 30 entries', () => {
        for (let i = 0; i < 35; i++) logError(new Error(`buf-${i}`), { source: `s-${i}` });
        const log = getStoredErrorLog();
        expect(log).toHaveLength(30);
        expect(log[0].message).toBe('buf-5'); // the first five were trimmed
        expect(log[log.length - 1].message).toBe('buf-34');
    });

    it('stamps the authenticated uid, or null when signed out', () => {
        auth.currentUser = { uid: 'u-42' };
        logError(new Error('with-uid'), { source: 'auth-on' });
        expect(getStoredErrorLog().at(-1).userId).toBe('u-42');

        auth.currentUser = null;
        logError(new Error('without-uid'), { source: 'auth-off' });
        expect(getStoredErrorLog().at(-1).userId).toBeNull();
    });

    it('clearStoredErrorLog empties the buffer', () => {
        logError(new Error('to-clear'), { source: 'clr' });
        expect(getStoredErrorLog()).toHaveLength(1);
        clearStoredErrorLog();
        expect(getStoredErrorLog()).toHaveLength(0);
    });
});

describe('logError — normalizeError shapes', () => {
    it('flattens Error, string, and event-like (reason) payloads into a message', () => {
        logError(new Error('an-error-object'), { source: 'n1' });
        const errRec = getStoredErrorLog().at(-1);
        expect(errRec.message).toBe('an-error-object');
        expect(typeof errRec.stack).toBe('string');

        logError('a-bare-string', { source: 'n2' });
        expect(getStoredErrorLog().at(-1).message).toBe('a-bare-string');

        logError({ reason: 'a-rejection-reason' }, { source: 'n3' });
        expect(getStoredErrorLog().at(-1).message).toBe('a-rejection-reason');
    });
});

describe('logError — dedupe window', () => {
    it('suppresses an identical rapid fault, then logs again after the window elapses', () => {
        vi.useFakeTimers();
        try {
            logError(new Error('flood'), { source: 'tick' });
            logError(new Error('flood'), { source: 'tick' }); // same signature, within 5s
            expect(getStoredErrorLog()).toHaveLength(1);

            vi.advanceTimersByTime(6000); // past DEDUPE_WINDOW_MS (5000ms)
            logError(new Error('flood'), { source: 'tick' });
            expect(getStoredErrorLog()).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('logError — never throws (it must not mask the crash it records)', () => {
    it('survives a null payload and a circular object', () => {
        expect(() => logError(null)).not.toThrow();
        const circular = {};
        circular.self = circular;
        expect(() => logError(circular, { source: 'circ' })).not.toThrow();
    });

    it('survives a failing localStorage.setItem and still reaches the Firestore sink', () => {
        ls.setItem.mockImplementation(() => { throw new Error('quota-exceeded'); });
        expect(() => logError(new Error('boom-quota'), { source: 'q' })).not.toThrow();
        // The two sinks are independent — a dead localStorage must not stop the remote write.
        expect(addDoc).toHaveBeenCalledTimes(1);
    });

    it('survives a rejecting Firestore write without surfacing the rejection', async () => {
        addDoc.mockRejectedValue(new Error('rules-denied'));
        expect(() => logError(new Error('boom-remote'), { source: 'r' })).not.toThrow();
        // The local sink still captured it.
        expect(getStoredErrorLog().at(-1).message).toBe('boom-remote');
        await Promise.resolve(); // let the swallowed rejection settle
    });
});
