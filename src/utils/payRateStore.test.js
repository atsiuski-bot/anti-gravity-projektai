import { describe, it, expect, vi, beforeEach } from 'vitest';

// payRateStore owns the STORAGE BOUNDARY for salary (audit R-10): the rate moved off the
// company-readable user document into users/{uid}/private/payRate. Three behaviours carry the
// whole migration and are pinned here:
//   1. effectivePayRate — the private document WINS, the inline field is only a fallback. Get this
//      backwards and a stale legacy value silently re-prices a worker whose rate was just changed.
//   2. savePayRate — writes the private document AND removes the inline copy, because leaving the
//      inline copy behind is exactly the leak this change exists to close.
//   3. savePayRate issues NO user-document write when there is no inline copy to clear — a
//      pointless mutation that would also wake the re-stamp trigger on every rate edit.
// The rules side (who may READ a rate) is pinned separately, against the real ruleset, in
// src/integration/firestore/securityRules.integration.test.js.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, ...segments) => ({ _path: segments.join('/') })),
    getDoc: vi.fn(() => Promise.resolve({ exists: () => false, data: () => undefined })),
    onSnapshot: vi.fn((_ref, _onNext, _onError) => () => {}),
    setDoc: vi.fn(() => Promise.resolve()),
    deleteDoc: vi.fn(() => Promise.resolve()),
    updateDoc: vi.fn(() => Promise.resolve()),
    deleteField: vi.fn(() => '<<delete>>'),
}));

vi.mock('./errorLog', () => ({ logError: vi.fn() }));

import { deleteDoc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { logError } from './errorLog';
import { effectivePayRate, fetchPayRate, fetchPayRates, payRateDocRef, savePayRate, subscribePayRate } from './payRateStore';

const RATE_A = { tiers: [{ fromHours: 0, netRate: 10 }] };
const RATE_B = { tiers: [{ fromHours: 0, netRate: 12 }] };

beforeEach(() => {
    vi.clearAllMocks();
});

describe('payRateDocRef', () => {
    it('addresses one fixed document per user, so a read is always a point lookup', () => {
        // A point lookup needs no index and — unlike a list query over the subcollection — cannot be
        // used to probe which colleagues have a rate at all.
        expect(payRateDocRef('u1')._path).toBe('users/u1/private/payRate');
    });
});

describe('effectivePayRate', () => {
    it('prefers the private document over the legacy inline field', () => {
        expect(effectivePayRate(RATE_B, { payRate: RATE_A })).toBe(RATE_B);
    });

    it('falls back to the inline field while a user is not migrated yet', () => {
        expect(effectivePayRate(null, { payRate: RATE_A })).toBe(RATE_A);
    });

    it('is null when the worker has no rate in either place', () => {
        expect(effectivePayRate(null, { id: 'u1' })).toBeNull();
        expect(effectivePayRate(null, null)).toBeNull();
        expect(effectivePayRate(undefined, undefined)).toBeNull();
    });
});

describe('fetchPayRate', () => {
    it('returns the document data when it exists', async () => {
        getDoc.mockResolvedValueOnce({ exists: () => true, data: () => RATE_A });
        await expect(fetchPayRate('u1')).resolves.toBe(RATE_A);
    });

    it('returns null when the user has no rate document', async () => {
        getDoc.mockResolvedValueOnce({ exists: () => false, data: () => undefined });
        await expect(fetchPayRate('u1')).resolves.toBeNull();
    });

    it('propagates a real read failure, so the admin editor can tell "no rate" from "unreadable"', async () => {
        getDoc.mockRejectedValueOnce(new Error('permission-denied'));
        await expect(fetchPayRate('u1')).rejects.toThrow('permission-denied');
    });
});

describe('fetchPayRates', () => {
    it('maps each uid to its rate and swallows a per-user failure', async () => {
        // One unreadable rate (an out-of-scope manager) must not blank the whole roster.
        getDoc
            .mockResolvedValueOnce({ exists: () => true, data: () => RATE_A })
            .mockRejectedValueOnce(new Error('permission-denied'))
            .mockResolvedValueOnce({ exists: () => false, data: () => undefined });
        await expect(fetchPayRates(['a', 'b', 'c'])).resolves.toEqual({ a: RATE_A, b: null, c: null });
    });

    it('de-duplicates uids and ignores empty entries', async () => {
        getDoc.mockResolvedValue({ exists: () => true, data: () => RATE_A });
        await fetchPayRates(['a', 'a', null, undefined, '']);
        expect(getDoc).toHaveBeenCalledTimes(1);
    });
});

describe('savePayRate', () => {
    it('writes the private document and clears the inline copy that leaked the salary', async () => {
        await savePayRate('u1', RATE_A, { id: 'u1', payRate: RATE_B });
        expect(setDoc).toHaveBeenCalledWith(expect.objectContaining({ _path: 'users/u1/private/payRate' }), RATE_A);
        expect(updateDoc).toHaveBeenCalledWith(
            expect.objectContaining({ _path: 'users/u1' }),
            { payRate: '<<delete>>' }
        );
    });

    it('does not touch the user document when there is no inline copy to clear', async () => {
        await savePayRate('u1', RATE_A, { id: 'u1' });
        expect(setDoc).toHaveBeenCalledTimes(1);
        expect(updateDoc).not.toHaveBeenCalled();
    });

    it('clearing a rate deletes the private document', async () => {
        await savePayRate('u1', null, { id: 'u1' });
        expect(deleteDoc).toHaveBeenCalledWith(expect.objectContaining({ _path: 'users/u1/private/payRate' }));
        expect(setDoc).not.toHaveBeenCalled();
    });

    it('a failed legacy cleanup is recorded, not thrown — the rate itself is already saved', async () => {
        updateDoc.mockRejectedValueOnce(new Error('offline'));
        await expect(savePayRate('u1', RATE_A, { id: 'u1', payRate: RATE_B })).resolves.toBeUndefined();
        expect(logError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ source: 'savePayRate.clearLegacy' }));
    });
});

describe('subscribePayRate', () => {
    // The rules that expose users/{uid}/private ship in a HUMAN-ONLY deploy, so the app runs against
    // a project that still default-denies this read until someone runs it. That denial is the
    // expected state, not an incident — recording it would write a durable crash entry for every
    // user on every login, for a leak this very change is closing.
    const listen = () => {
        subscribePayRate('u1', vi.fn());
        return onSnapshot.mock.calls[0];
    };

    it('emits the document data when it exists', () => {
        const onData = vi.fn();
        subscribePayRate('u1', onData);
        const [, next] = onSnapshot.mock.calls[0];
        next({ exists: () => true, data: () => RATE_A });
        expect(onData).toHaveBeenCalledWith(RATE_A);
    });

    it('emits null when the document is absent, so the legacy fallback takes over', () => {
        const onData = vi.fn();
        subscribePayRate('u1', onData);
        const [, next] = onSnapshot.mock.calls[0];
        next({ exists: () => false, data: () => undefined });
        expect(onData).toHaveBeenCalledWith(null);
    });

    it('does NOT log a permission-denied — that is the expected pre-deploy state', () => {
        const [, , onError] = listen();
        onError({ code: 'permission-denied', message: 'Missing or insufficient permissions.' });
        expect(logError).not.toHaveBeenCalled();
    });

    it('DOES log any other failure', () => {
        const [, , onError] = listen();
        onError({ code: 'unavailable', message: 'backend unreachable' });
        expect(logError).toHaveBeenCalledWith(
            expect.objectContaining({ code: 'unavailable' }),
            expect.objectContaining({ source: 'onSnapshot:payRate' })
        );
    });

    it('fails closed on any error — no rate rather than a stale one', () => {
        const onData = vi.fn();
        subscribePayRate('u1', onData);
        const [, , onError] = onSnapshot.mock.calls[0];
        onError({ code: 'permission-denied' });
        expect(onData).toHaveBeenCalledWith(null);
    });

    it('is inert without a uid, and still returns an unsubscribe the caller can call', () => {
        const onData = vi.fn();
        const unsub = subscribePayRate(null, onData);
        expect(onData).toHaveBeenCalledWith(null);
        expect(onSnapshot).not.toHaveBeenCalled();
        expect(() => unsub()).not.toThrow();
    });
});
