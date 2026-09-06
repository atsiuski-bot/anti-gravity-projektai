import { describe, it, expect, vi, beforeEach } from 'vitest';

// approveCalendarRequest is the SINGLE writer behind both approval surfaces — the manager
// notification bell and the team "Kalendoriaus istorija" tab. Its contract is that approving is one
// indivisible act: apply the change to work_hours, flip the request, log the audit entry, tell the
// worker. If the two surfaces ever drift, a plan silently approves without the hours moving (or the
// reverse), and the calendar the founder pays against stops matching what was agreed.
//
// It is also worth pinning because approval enforcement is CLIENT-side here (a known, accepted gap
// — the rules do not re-derive the affected time), so this module IS the control. The three shapes
// below each have a different failure: an `add` that leaks its synthetic id onto the work_hours doc,
// an `edit` that drops a field, a `delete` that removes the wrong document.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
    collection: vi.fn((_db, name) => ({ _col: name })),
    doc: vi.fn((_db, col, id) => ({ _col: col, _id: id, _path: `${col}/${id}` })),
    addDoc: vi.fn(() => Promise.resolve({ id: 'new-doc' })),
    updateDoc: vi.fn(() => Promise.resolve()),
    deleteDoc: vi.fn(() => Promise.resolve()),
}));

vi.mock('./calendarNotifications', () => ({ logCalendarChange: vi.fn(() => Promise.resolve()) }));
vi.mock('./notify', () => ({ notify: vi.fn(() => Promise.resolve()) }));

import { addDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { logCalendarChange } from './calendarNotifications';
import { notify } from './notify';
import { approveCalendarRequest, declineCalendarRequest } from './calendarApproval';

const ACTOR = { uid: 'mgr-1', displayName: 'Vadovas V.', email: 'mgr@example.test' };

const requestOf = (over) => ({
    id: 'req-1',
    userId: 'w1',
    userName: 'Meistras M.',
    reason: 'Liga',
    ...over,
});

const EVENT = {
    id: 'wh-9',
    start: '2026-07-01T06:00:00.000Z',
    end: '2026-07-01T14:00:00.000Z',
    title: 'Statyba',
    isWorkFromHome: false,
    isVacation: false,
    absenceType: null,
};

// The write aimed at one collection, across all mock calls.
const updatesTo = (col) => updateDoc.mock.calls.filter(([ref]) => ref._col === col);

beforeEach(() => {
    vi.clearAllMocks();
});

describe('approveCalendarRequest — add', () => {
    it('creates the planned shift and strips the synthetic id', async () => {
        // An `add` request carries id:null (a real id exists only for edit/delete). Letting it onto
        // the document would clobber doc.id for any later reader doing {id: doc.id, ...data}.
        await approveCalendarRequest(requestOf({ type: 'add', requestedEvent: { ...EVENT, id: null } }), ACTOR);

        expect(addDoc).toHaveBeenCalledTimes(1);
        const [ref, data] = addDoc.mock.calls[0];
        expect(ref._col).toBe('work_hours');
        expect(data).toMatchObject({ userId: 'w1', type: 'planned', start: EVENT.start, end: EVENT.end });
        expect(Object.prototype.hasOwnProperty.call(data, 'id')).toBe(false);
    });
});

describe('approveCalendarRequest — edit', () => {
    it('writes every schedulable field onto the existing shift', async () => {
        // A dropped field here is a silent partial approval: the worker sees the change accepted
        // while the calendar still holds the old value for whatever was omitted.
        await approveCalendarRequest(requestOf({ type: 'edit', requestedEvent: EVENT }), ACTOR);

        const [ref, patch] = updatesTo('work_hours')[0];
        expect(ref._id).toBe('wh-9');
        expect(patch).toEqual({
            start: EVENT.start,
            end: EVENT.end,
            title: EVENT.title,
            isWorkFromHome: false,
            isVacation: false,
            absenceType: null,
        });
        expect(addDoc).not.toHaveBeenCalled();
        expect(deleteDoc).not.toHaveBeenCalled();
    });

    it('normalises a missing absenceType to null rather than leaving it undefined', async () => {
        // Firestore rejects an explicit `undefined`; the ?? null is what keeps the write legal.
        const { absenceType, ...noType } = EVENT; // eslint-disable-line no-unused-vars
        await approveCalendarRequest(requestOf({ type: 'edit', requestedEvent: noType }), ACTOR);
        expect(updatesTo('work_hours')[0][1].absenceType).toBeNull();
    });
});

describe('approveCalendarRequest — delete', () => {
    it('removes exactly the requested shift and touches nothing else in work_hours', async () => {
        await approveCalendarRequest(requestOf({ type: 'delete', requestedEvent: EVENT }), ACTOR);

        expect(deleteDoc).toHaveBeenCalledTimes(1);
        expect(deleteDoc.mock.calls[0][0]._path).toBe('work_hours/wh-9');
        expect(addDoc).not.toHaveBeenCalled();
        expect(updatesTo('work_hours')).toHaveLength(0);
    });
});

describe('approveCalendarRequest — the indivisible act', () => {
    it('flips the request, stamps the approver, logs the change and tells the worker', async () => {
        await approveCalendarRequest(requestOf({ type: 'edit', requestedEvent: EVENT }), ACTOR);

        const [reqRef, reqPatch] = updatesTo('calendar_requests')[0];
        expect(reqRef._id).toBe('req-1');
        expect(reqPatch.status).toBe('approved');
        expect(reqPatch.approvedBy).toBe('mgr-1');
        expect(typeof reqPatch.approvedAt).toBe('string');

        expect(logCalendarChange).toHaveBeenCalledTimes(1);
        expect(logCalendarChange.mock.calls[0][0]).toMatchObject({ uid: 'w1' });
        expect(logCalendarChange.mock.calls[0][1]).toBe('edit');

        expect(notify).toHaveBeenCalledWith(expect.objectContaining({
            recipientId: 'w1',
            type: 'calendar_decision',
            decision: 'approved',
            actorUid: 'mgr-1',
        }));
    });

    it('applies the hours BEFORE flipping the request, so a failure cannot leave an approved request with unchanged hours', async () => {
        const order = [];
        updateDoc.mockImplementation((ref) => { order.push(ref._col); return Promise.resolve(); });
        await approveCalendarRequest(requestOf({ type: 'edit', requestedEvent: EVENT }), ACTOR);
        expect(order).toEqual(['work_hours', 'calendar_requests']);
    });

    it('propagates a failed hours write instead of reporting a successful approval', async () => {
        // The caller renders its own Lithuanian banner off this rejection. Swallowing it here would
        // show the manager a green confirmation for a change that never landed.
        updateDoc.mockRejectedValueOnce(new Error('permission-denied'));
        await expect(
            approveCalendarRequest(requestOf({ type: 'edit', requestedEvent: EVENT }), ACTOR)
        ).rejects.toThrow('permission-denied');
        expect(notify).not.toHaveBeenCalled();
    });
});

describe('declineCalendarRequest', () => {
    it('never touches the calendar — only the request and the worker', async () => {
        await declineCalendarRequest(requestOf({ type: 'delete', requestedEvent: EVENT }), ACTOR);

        expect(addDoc).not.toHaveBeenCalled();
        expect(deleteDoc).not.toHaveBeenCalled();
        expect(updatesTo('work_hours')).toHaveLength(0);

        const [, patch] = updatesTo('calendar_requests')[0];
        expect(patch.status).toBe('declined');
        expect(patch.declinedBy).toBe('mgr-1');
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ decision: 'declined', recipientId: 'w1' }));
    });
});
