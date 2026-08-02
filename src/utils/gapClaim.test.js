import { describe, it, expect, vi, beforeEach } from 'vitest';

// Firestore + the notification funnel are mocked: this file is about the ESCALATION DECISION —
// who gets told, what they are told, and what happens when there is nobody to tell — not about
// Firestore itself.
const getDoc = vi.fn();
vi.mock('firebase/firestore', () => ({
    doc: (_db, col, id) => ({ col, id }),
    getDoc: (...args) => getDoc(...args),
}));
vi.mock('../firebase', () => ({ db: {} }));

const notifyMany = vi.fn();
vi.mock('./notify', () => ({ notifyMany: (...args) => notifyMany(...args) }));

const logError = vi.fn();
vi.mock('./errorLog', () => ({ logError: (...args) => logError(...args) }));

import { raiseRefusedGapClaim, gapClaimSummary } from './gapClaim';

const WORKER = { uid: 'w1', displayName: 'Povilas Bielskis' };
const TASK = { id: 't1', title: 'Šiaudų pynimas' };
// 2026-07-29, 15:43 → 19:34 Vilnius (UTC+3) — the production incident's real interval.
const FROM = '2026-07-29T12:43:00.000Z';
const TO = '2026-07-29T16:34:00.000Z';

const userDoc = (data) => ({ exists: () => true, data: () => data });

const raise = (overrides = {}) => raiseRefusedGapClaim({
    task: TASK, worker: WORKER, fromIso: FROM, toIso: TO, gapMinutes: 231,
    cause: 'gap-not-one-work-stretch', engine: 'legacy', ...overrides,
});

beforeEach(() => {
    getDoc.mockReset();
    notifyMany.mockReset();
    logError.mockReset();
    notifyMany.mockResolvedValue(undefined);
});

describe('raiseRefusedGapClaim — recipients', () => {
    it('notifies the whole overseer closure, not just one manager', async () => {
        getDoc.mockResolvedValue(userDoc({ overseerIds: ['m1', 'm2', 'snr1'] }));
        const res = await raise();
        expect(res).toMatchObject({ ok: true, recipients: 3 });
        expect(notifyMany).toHaveBeenCalledTimes(1);
        expect(notifyMany.mock.calls[0][0]).toEqual(['m1', 'm2', 'snr1']);
    });

    it('falls back to the direct membership fields before the closure is stamped', async () => {
        // A user doc created before the Cloud Function folded the closure still has to escalate —
        // otherwise the fix silently does nothing for exactly the oldest accounts.
        getDoc.mockResolvedValue(userDoc({ teamManagerIds: ['m1'], seniorManagerIds: ['snr1'] }));
        const res = await raise();
        expect(res.ok).toBe(true);
        expect(notifyMany.mock.calls[0][0]).toEqual(['m1', 'snr1']);
    });

    it('falls back to the legacy single defaultManager', async () => {
        getDoc.mockResolvedValue(userDoc({ defaultManager: 'm9' }));
        await raise();
        expect(notifyMany.mock.calls[0][0]).toEqual(['m9']);
    });

    it('reports failure — and leaves a trace — when the worker has nobody above them', async () => {
        // The dangerous outcome would be reporting success: the caller would believe the interval was
        // escalated while it reached no one, which is the original silent loss wearing a new hat.
        getDoc.mockResolvedValue(userDoc({}));
        const res = await raise();
        expect(res).toMatchObject({ ok: false, recipients: 0, error: 'no-overseer' });
        expect(notifyMany).not.toHaveBeenCalled();
        expect(logError.mock.calls[0][1]).toMatchObject({ source: 'gapClaim:noRecipients' });
    });
});

describe('raiseRefusedGapClaim — payload', () => {
    beforeEach(() => getDoc.mockResolvedValue(userDoc({ overseerIds: ['m1'] })));

    it('carries the exact interval the manager will credit', async () => {
        await raise();
        expect(notifyMany.mock.calls[0][1]).toMatchObject({
            type: 'time_gap_claim',
            userId: 'w1',
            taskId: 't1',
            gapFromIso: FROM,
            gapToIso: TO,
            gapMinutes: 231,
            gapCause: 'gap-not-one-work-stretch',
            gapEngine: 'legacy',
        });
    });

    it('names the interval as gapFrom/gapTo, never as a session start/end', async () => {
        // A credited session and an unsettled claim must never be confusable by field name: an
        // aggregator that mistook one for the other would pay for undecided time.
        await raise();
        const payload = notifyMany.mock.calls[0][1];
        expect(payload.startTime).toBeUndefined();
        expect(payload.endTime).toBeUndefined();
        expect(payload.durationMinutes).toBeUndefined();
    });

    it('rounds a fractional gap to whole minutes', async () => {
        await raise({ gapMinutes: 230.98948 });
        expect(notifyMany.mock.calls[0][1].gapMinutes).toBe(231);
    });
});

describe('raiseRefusedGapClaim — never breaks recovery', () => {
    it('returns an error instead of throwing when the user doc cannot be read', async () => {
        getDoc.mockRejectedValue(new Error('offline'));
        await expect(raise()).resolves.toMatchObject({ ok: false, error: 'read' });
    });

    it('returns an error instead of throwing when the notification write fails', async () => {
        getDoc.mockResolvedValue(userDoc({ overseerIds: ['m1'] }));
        notifyMany.mockRejectedValue(new Error('denied'));
        await expect(raise()).resolves.toMatchObject({ ok: false, error: 'write' });
        expect(logError.mock.calls[0][1]).toMatchObject({ source: 'writeFail:raiseRefusedGapClaim' });
    });

    it('refuses an incomplete interval without touching Firestore', async () => {
        await expect(raise({ toIso: null })).resolves.toMatchObject({ ok: false, error: 'missing' });
        expect(getDoc).not.toHaveBeenCalled();
    });
});

describe('gapClaimSummary', () => {
    it('states the Vilnius day, the wall-clock span and the duration', () => {
        const text = gapClaimSummary({ fromIso: FROM, toIso: TO, gapMinutes: 231, taskTitle: 'Šiaudų pynimas' });
        expect(text).toContain('2026-07-29');
        expect(text).toContain('15:43');
        expect(text).toContain('19:34');
        expect(text).toContain('3h 51m');
        expect(text).toContain('Šiaudų pynimas');
    });

    it('survives a missing task title', () => {
        expect(gapClaimSummary({ fromIso: FROM, toIso: TO, gapMinutes: 60 })).toContain('Veikla');
    });
});
