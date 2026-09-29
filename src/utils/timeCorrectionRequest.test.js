import { describe, it, expect, vi, beforeEach } from 'vitest';

// The write paths are covered in sessionEditActions.test.js; here they are stubs so the dispatcher's
// ROUTING (which kind reaches which owner-checked write, with which arguments) is what is asserted.
vi.mock('./sessionEditActions', () => ({
    creditRequestedSession: vi.fn(() => Promise.resolve({ ok: true })),
    applyRequestedSessionTimes: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { creditRequestedSession, applyRequestedSessionTimes } from './sessionEditActions';
import {
    CORRECTION_KINDS as K,
    workDayClockToISO,
    findOverlap,
    intervalMinutes,
    describeCorrection,
    buildCorrectionRequest,
    isApplicableCorrection,
    applyTimeCorrectionRequest,
    isNotFuture,
} from './timeCorrectionRequest';

beforeEach(() => vi.clearAllMocks());

describe('workDayClockToISO (a typed clock time on a 05:00→05:00 work day)', () => {
    it('anchors a daytime entry to the work day itself (summer, UTC+3)', () => {
        expect(workDayClockToISO('2026-09-29', '08:10')).toBe('2026-09-29T05:10:00.000Z');
    });
    // A 01:30 entry on work day 09-29 happened on the calendar date 09-30 — anchoring it to 09-29
    // would build an instant 24h early.
    it('puts a before-05:00 entry on the NEXT calendar date', () => {
        expect(workDayClockToISO('2026-09-29', '01:30')).toBe('2026-09-29T22:30:00.000Z');
    });
    it('rejects garbage', () => {
        expect(workDayClockToISO('2026-09-29', '8 ryte')).toBeNull();
        expect(workDayClockToISO('2026-09-29', undefined)).toBeNull();
    });
});

describe('findOverlap / intervalMinutes', () => {
    const rows = [
        { id: 'a', startTime: '2026-09-29T06:00:00Z', endTime: '2026-09-29T08:00:00Z' },
        { id: 'b', startTime: '2026-09-29T10:00:00Z', endTime: '2026-09-29T12:00:00Z' },
    ];
    it('finds an intersecting row, and treats touching edges as NOT overlapping', () => {
        expect(findOverlap('2026-09-29T07:30:00Z', '2026-09-29T09:00:00Z', rows)?.id).toBe('a');
        expect(findOverlap('2026-09-29T08:00:00Z', '2026-09-29T10:00:00Z', rows)).toBeNull();
    });
    it('can ignore the row being edited', () => {
        expect(findOverlap('2026-09-29T05:30:00Z', '2026-09-29T08:00:00Z', rows, { ignoreId: 'a' })).toBeNull();
    });
    it('measures forward intervals only', () => {
        expect(intervalMinutes('2026-09-29T06:00:00Z', '2026-09-29T07:30:00Z')).toBe(90);
        expect(intervalMinutes('2026-09-29T07:30:00Z', '2026-09-29T06:00:00Z')).toBeNull();
    });
});

describe('describeCorrection (the "Taip" preview)', () => {
    it('missed_start: the credited time is ADDED', () => {
        const d = describeCorrection({
            correctionKind: K.MISSED_START, taskTitle: 'Stogas',
            requestedStartTime: '2026-09-29T05:10:00Z', requestedEndTime: '2026-09-29T06:40:00Z',
        });
        expect(d.delta.startsWith('+')).toBe(true);
        expect(d.detail).toContain('Stogas');
    });
    it('wrong_time: the NET change from the stored row, in either direction', () => {
        const longer = describeCorrection({
            correctionKind: K.WRONG_TIME,
            originalStartTime: '2026-09-29T05:00:00Z', originalEndTime: '2026-09-29T13:00:00Z',
            requestedStartTime: '2026-09-29T04:30:00Z', requestedEndTime: '2026-09-29T13:00:00Z',
        });
        expect(longer.delta.startsWith('+')).toBe(true);
        expect(longer.detail).toContain('→');
        const same = describeCorrection({
            correctionKind: K.WRONG_TIME,
            originalStartTime: '2026-09-29T05:00:00Z', originalEndTime: '2026-09-29T13:00:00Z',
            requestedStartTime: '2026-09-29T05:30:00Z', requestedEndTime: '2026-09-29T13:30:00Z',
        });
        expect(same.delta).toBe('');
    });
    it('other: nothing to preview', () => {
        expect(describeCorrection({ correctionKind: K.OTHER })).toEqual({ delta: '', detail: '' });
    });
});

describe('buildCorrectionRequest (the notification payload)', () => {
    const worker = { uid: 'u1', name: 'Jonas' };
    it('stamps the worker as provenance and carries the machine-readable fix', () => {
        const n = buildCorrectionRequest({
            kind: K.MISSED_START, day: '2026-09-29', worker, taskId: 't1', taskTitle: 'Stogas',
            startTime: '2026-09-29T05:10:00Z', endTime: '2026-09-29T06:40:00Z', note: '  dirbau \n nuo 8 ',
        });
        // The request_notifications create rule requires the caller's uid as userId (or createdBy).
        expect(n).toMatchObject({
            type: 'time_correction_request', userId: 'u1', actorUid: 'u1', correctionKind: K.MISSED_START,
            requestedStartTime: '2026-09-29T05:10:00Z', requestedEndTime: '2026-09-29T06:40:00Z',
            taskId: 't1', workerNote: 'dirbau nuo 8', sessionRef: null, aiSuggested: false,
        });
        expect(n.commentText).toContain('Pamiršo paleisti');
        expect(n.commentText).toContain('„dirbau nuo 8“');
    });
    it('keeps commentText inside the rule\'s 2000-char clamp', () => {
        const n = buildCorrectionRequest({ kind: K.OTHER, day: '2026-09-29', worker, note: 'x'.repeat(5000) });
        expect(n.commentText.length).toBeLessThanOrEqual(2000);
        expect(n.workerNote.length).toBe(500);
    });
});

describe('isApplicableCorrection / applyTimeCorrectionRequest (routing the manager\'s Taip)', () => {
    const missed = {
        userId: 'u1', userName: 'Jonas', correctionKind: K.MISSED_START, taskId: 't1', taskTitle: 'Stogas',
        requestedStartTime: '2026-09-29T05:10:00Z', requestedEndTime: '2026-09-29T06:40:00Z',
    };
    const wrong = {
        userId: 'u1', correctionKind: K.WRONG_TIME, sessionRef: 'ws-1',
        requestedStartTime: '2026-09-29T04:30:00Z', requestedEndTime: '2026-09-29T13:00:00Z', workerNote: 'pradėjau anksčiau',
    };
    const editor = { uid: 'mgr1' };

    it('only fully-specified missed_start / wrong_time requests are one-tap', () => {
        expect(isApplicableCorrection(missed)).toBe(true);
        expect(isApplicableCorrection(wrong)).toBe(true);
        expect(isApplicableCorrection({ ...wrong, sessionRef: null })).toBe(false);
        expect(isApplicableCorrection({ ...missed, userId: null })).toBe(false);
        expect(isApplicableCorrection({ userId: 'u1', correctionKind: K.BREAK_WAS_WORK, requestedStartTime: 'a', requestedEndTime: 'b' })).toBe(false);
        expect(isApplicableCorrection({ userId: 'u1', correctionKind: K.OTHER })).toBe(false);
    });

    it('missed_start → creditRequestedSession, verified against the REQUESTER', async () => {
        await applyTimeCorrectionRequest({ notif: missed, editor });
        expect(creditRequestedSession).toHaveBeenCalledWith(expect.objectContaining({
            taskId: 't1', expectedUserId: 'u1', startTime: missed.requestedStartTime, endTime: missed.requestedEndTime, editor,
        }));
        expect(applyRequestedSessionTimes).not.toHaveBeenCalled();
    });

    it('wrong_time → applyRequestedSessionTimes on the named row, verified against the requester', async () => {
        await applyTimeCorrectionRequest({ notif: wrong, editor });
        expect(applyRequestedSessionTimes).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'ws-1', expectedUserId: 'u1', startTime: wrong.requestedStartTime, endTime: wrong.requestedEndTime,
        }));
        expect(applyRequestedSessionTimes.mock.calls[0][0].reason).toContain('pradėjau anksčiau');
    });

    it('an info-only kind writes nothing', async () => {
        expect(await applyTimeCorrectionRequest({ notif: { userId: 'u1', correctionKind: K.BREAK_WAS_WORK }, editor }))
            .toEqual({ ok: false, error: 'unsupported' });
        expect(creditRequestedSession).not.toHaveBeenCalled();
        expect(applyRequestedSessionTimes).not.toHaveBeenCalled();
    });
});

describe('isNotFuture', () => {
    it('allows now (with a minute of clock slack) and refuses the future', () => {
        const now = new Date('2026-09-29T10:00:00Z');
        expect(isNotFuture('2026-09-29T10:00:30Z', now)).toBe(true);
        expect(isNotFuture('2026-09-29T10:05:00Z', now)).toBe(false);
    });
});
