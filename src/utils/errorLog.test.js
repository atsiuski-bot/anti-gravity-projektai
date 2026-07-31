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

// Everything a call site passes beyond source/componentStack used to be discarded by BOTH sinks,
// so a permission-denied reported from the field could not be classified: timerCommandEngine
// .settle() passes `outcome`, and a `rejected` (nothing happened — the worker lost the stretch) is
// a different incident from a `conflicted` (another device already recorded it). These pin that the
// keys now survive, and the three bounds that keep them from breaking the record they ride on.
describe('logError — caller context', () => {
    it('carries the remaining keys under context, in both sinks', () => {
        logError(new Error('settle-failed'), {
            source: 'timerCommandEngine.settle',
            commandId: 'cmd-7',
            commandKind: 'end',
            outcome: 'conflicted',
        });

        const local = getStoredErrorLog().at(-1);
        expect(local.context).toEqual({ commandId: 'cmd-7', commandKind: 'end', outcome: 'conflicted' });
        // The remote record is the same object — a manager reading error_logs sees the same keys.
        expect(addDoc.mock.calls[0][1].context).toEqual(local.context);
    });

    it('keeps source and componentStack top-level, and out of context', () => {
        logError(new Error('render-broke'), {
            source: 'boundary:TaskCard',
            componentStack: '\n  at TaskCard',
            taskId: 't-1',
        });
        const rec = getStoredErrorLog().at(-1);
        expect(rec.source).toBe('boundary:TaskCard');
        expect(rec.componentStack).toBe('\n  at TaskCard');
        expect(rec.context).toEqual({ taskId: 't-1' }); // not duplicated into the map
    });

    it('omits the context field entirely when only source is passed', () => {
        // The ~190 source-only call sites must keep writing the exact record shape they write today.
        logError(new Error('plain'), { source: 'onSnapshot:tasks' });
        expect('context' in getStoredErrorLog().at(-1)).toBe(false);
        expect('context' in addDoc.mock.calls[0][1]).toBe(false);
    });

    it('drops undefined values instead of stringifying them', () => {
        // Call sites pass `taskId: task?.id`; Firestore refuses a document containing an undefined
        // field value outright, so one absent id would cost the whole remote record.
        logError(new Error('no-task'), { source: 'orphanRecovery', taskId: undefined, code: 'permission-denied' });
        const rec = getStoredErrorLog().at(-1);
        expect(rec.context).toEqual({ code: 'permission-denied' });
        expect(Object.values(addDoc.mock.calls[0][1].context)).not.toContain(undefined);
    });

    it('never lets a caller overwrite the authenticated userId', () => {
        // firestore.rules pins the record's userId to request.auth.uid (or null); a caller's id
        // landing there would make the remote write permission-denied for that crash.
        auth.currentUser = { uid: 'signed-in-uid' };
        logError(new Error('other-user'), { source: 'BulkReassign', userId: 'some-other-uid' });
        const rec = getStoredErrorLog().at(-1);
        expect(rec.userId).toBe('signed-in-uid');
        expect(rec.context.userId).toBe('some-other-uid'); // kept, but only as context
    });

    it('bounds the map: long values are clamped and the key count is capped', () => {
        logError(new Error('huge-value'), { source: 'b1', blob: 'x'.repeat(5000) });
        expect(getStoredErrorLog().at(-1).context.blob).toHaveLength(500);

        const many = { source: 'b2' };
        for (let i = 0; i < 40; i++) many[`k${i}`] = i;
        logError(new Error('too-many-keys'), many);
        expect(Object.keys(getStoredErrorLog().at(-1).context)).toHaveLength(20);
    });

    it('flattens non-scalar values without throwing (a circular value must not kill the record)', () => {
        const circular = { a: 1 };
        circular.self = circular;
        expect(() => logError(new Error('exotic'), {
            source: 'x1',
            circular,
            list: [1, 2],
            when: null,
            ok: false,
            n: 42,
        })).not.toThrow();

        const ctx = getStoredErrorLog().at(-1).context;
        expect(ctx.when).toBeNull();
        expect(ctx.ok).toBe(false);
        expect(ctx.n).toBe(42);
        expect(ctx.list).toBe('[1,2]');
        expect(typeof ctx.circular).toBe('string'); // String()-fallback, not a thrown TypeError
        // The record still reached both sinks despite the unserializable value.
        expect(addDoc).toHaveBeenCalledTimes(1);
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
