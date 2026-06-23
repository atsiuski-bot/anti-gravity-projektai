import { describe, it, expect, vi, beforeEach } from 'vitest';

// deriveSessionFields + MAX_EDIT_SESSION_MINUTES are PURE: they only do Date math and call the
// real getLithuanianDateString. They need no mocking and are exercised here as real logic. The
// mocks below exist solely to neutralise the firebase module graph that sessionEditActions.js
// (and its transitive errorLog import) pulls in at load time, and to let the WRITE helpers
// (editWorkSession / deleteWorkSession / createWorkSession) run against in-memory Firestore
// fakes so we can assert the payloads + audit snapshot they would persist. timeUtils is NOT
// mocked, so MAX_SESSION_MINUTES and the Vilnius day bucketing are the genuine implementations.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}` })),
    collection: vi.fn((_db, name) => ({ _col: name })),
    updateDoc: vi.fn(() => Promise.resolve()),
    addDoc: vi.fn(() => Promise.resolve({ id: 'generated-id' })),
}));

// notify() is exercised in its own surface; here we only assert the action layer hands it the
// right worker-facing payload after a successful edit/delete (recipient, type, day, summary, reason).
vi.mock('./notify', () => ({ notify: vi.fn(() => Promise.resolve()) }));

import { updateDoc, addDoc } from 'firebase/firestore';
import { notify } from './notify';
import {
    deriveSessionFields,
    MAX_EDIT_SESSION_MINUTES,
    editWorkSession,
    deleteWorkSession,
    createWorkSession,
} from './sessionEditActions';
import { MAX_SESSION_MINUTES } from './timeUtils';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('MAX_EDIT_SESSION_MINUTES', () => {
    it('reuses the live-timer 16h single-session ceiling', () => {
        expect(MAX_EDIT_SESSION_MINUTES).toBe(MAX_SESSION_MINUTES);
        expect(MAX_EDIT_SESSION_MINUTES).toBe(16 * 60);
        expect(MAX_EDIT_SESSION_MINUTES).toBe(960);
    });
});

describe('deriveSessionFields (validate [start,end] -> the two fields reports read)', () => {
    it('derives duration + the Vilnius END day for a normal interval', () => {
        // 08:00–11:30 UTC = 3h30m. End 11:30 UTC is 14:30 Vilnius (summer), so day = 2026-06-23.
        const r = deriveSessionFields('2026-06-23T08:00:00.000Z', '2026-06-23T11:30:00.000Z');
        expect(r).toEqual({ ok: true, error: null, durationMinutes: 210, date: '2026-06-23' });
    });

    it('accepts exactly 16h (the ceiling is inclusive)', () => {
        const r = deriveSessionFields('2026-06-23T00:00:00.000Z', '2026-06-23T16:00:00.000Z');
        expect(r.ok).toBe(true);
        expect(r.durationMinutes).toBe(960);
        expect(r.date).toBe('2026-06-23');
    });

    it('rejects end == start as out-of-order', () => {
        const r = deriveSessionFields('2026-06-23T08:00:00.000Z', '2026-06-23T08:00:00.000Z');
        expect(r).toEqual({ ok: false, error: 'order', durationMinutes: 0, date: null });
    });

    it('rejects end < start as out-of-order', () => {
        const r = deriveSessionFields('2026-06-23T11:00:00.000Z', '2026-06-23T10:00:00.000Z');
        expect(r).toEqual({ ok: false, error: 'order', durationMinutes: 0, date: null });
    });

    it('rejects an interval longer than 16h, echoing the raw minutes for the message', () => {
        // 17h = 1020 min > 960. durationMinutes carries the raw value so the UI can show it.
        const r = deriveSessionFields('2026-06-23T00:00:00.000Z', '2026-06-23T17:00:00.000Z');
        expect(r).toEqual({ ok: false, error: 'tooLong', durationMinutes: 1020, date: null });
    });

    it('rejects one minute over the ceiling', () => {
        const r = deriveSessionFields('2026-06-23T00:00:00.000Z', '2026-06-23T16:01:00.000Z');
        expect(r.ok).toBe(false);
        expect(r.error).toBe('tooLong');
        expect(r.durationMinutes).toBe(961);
    });

    it('rejects an un-parseable start or end timestamp', () => {
        expect(deriveSessionFields('not-a-date', '2026-06-23T11:30:00.000Z')).toEqual({
            ok: false, error: 'invalid', durationMinutes: 0, date: null,
        });
        expect(deriveSessionFields('2026-06-23T08:00:00.000Z', 'also-bad')).toEqual({
            ok: false, error: 'invalid', durationMinutes: 0, date: null,
        });
        expect(deriveSessionFields(undefined, undefined)).toEqual({
            ok: false, error: 'invalid', durationMinutes: 0, date: null,
        });
    });

    it('buckets a cross-midnight interval into the END day', () => {
        // Start 20:00 UTC = 23:00 Vilnius on the 23rd; end 22:00 UTC = 01:00 Vilnius on the 24th.
        // The session began on the 23rd but is credited to the day it finished — the 24th.
        const r = deriveSessionFields('2026-06-23T20:00:00.000Z', '2026-06-23T22:00:00.000Z');
        expect(r.ok).toBe(true);
        expect(r.durationMinutes).toBe(120);
        expect(r.date).toBe('2026-06-24');
    });
});

describe('editWorkSession (in-place edit + once-only audit snapshot)', () => {
    const validEdit = {
        startTime: '2026-06-23T08:00:00.000Z',
        endTime: '2026-06-23T11:30:00.000Z',
        reason: '  correct clock skew  ',
        editor: { uid: 'admin1', displayName: 'Admin One' },
    };

    it('refuses a session with no id', async () => {
        expect(await editWorkSession({}, validEdit)).toEqual({ ok: false, error: 'missing' });
        expect(await editWorkSession(null, validEdit)).toEqual({ ok: false, error: 'missing' });
        expect(updateDoc).not.toHaveBeenCalled();
    });

    it('requires a non-blank reason', async () => {
        const r = await editWorkSession({ id: 's1' }, { ...validEdit, reason: '   ' });
        expect(r).toEqual({ ok: false, error: 'reason' });
        expect(updateDoc).not.toHaveBeenCalled();
    });

    it('propagates a derive error and writes nothing', async () => {
        const r = await editWorkSession(
            { id: 's1' },
            { startTime: '2026-06-23T11:00:00.000Z', endTime: '2026-06-23T10:00:00.000Z', reason: 'x' }
        );
        expect(r).toEqual({ ok: false, error: 'order' });
        expect(updateDoc).not.toHaveBeenCalled();
    });

    it('writes derived fields + a trimmed reason + the editor stamp, and snapshots the TRUE original on the first edit', async () => {
        const session = {
            id: 's1',
            startTime: '2026-06-23T06:00:00.000Z',
            endTime: '2026-06-23T07:00:00.000Z',
            durationMinutes: 60,
        };
        const res = await editWorkSession(session, validEdit);
        expect(res).toEqual({ ok: true, durationMinutes: 210, date: '2026-06-23' });
        expect(updateDoc).toHaveBeenCalledTimes(1);

        const updates = updateDoc.mock.calls[0][1];
        expect(updates.startTime).toBe('2026-06-23T08:00:00.000Z');
        expect(updates.endTime).toBe('2026-06-23T11:30:00.000Z');
        expect(updates.durationMinutes).toBe(210);
        expect(updates.date).toBe('2026-06-23');
        expect(updates.edited).toBe(true);
        expect(updates.editedBy).toBe('admin1');
        expect(updates.editedByName).toBe('Admin One');
        expect(updates.editReason).toBe('correct clock skew'); // trimmed
        // First edit captures what the worker's timer actually recorded.
        expect(updates.originalStartTime).toBe('2026-06-23T06:00:00.000Z');
        expect(updates.originalEndTime).toBe('2026-06-23T07:00:00.000Z');
        expect(updates.originalDurationMinutes).toBe(60);
    });

    it('does NOT re-snapshot the original on a subsequent edit', async () => {
        const session = {
            id: 's2',
            edited: true, // already edited once
            startTime: '2026-06-23T08:30:00.000Z',
            endTime: '2026-06-23T09:30:00.000Z',
            durationMinutes: 60,
            originalStartTime: '2026-06-23T06:00:00.000Z',
        };
        const res = await editWorkSession(session, validEdit);
        expect(res.ok).toBe(true);

        const updates = updateDoc.mock.calls[0][1];
        expect(updates).not.toHaveProperty('originalStartTime');
        expect(updates).not.toHaveProperty('originalEndTime');
        expect(updates).not.toHaveProperty('originalDurationMinutes');
    });

    it('falls back to email then a default name, and "unknown" when no editor is supplied', async () => {
        const session = { id: 's3', startTime: 'x', endTime: 'y', durationMinutes: 10 };
        await editWorkSession(session, { ...validEdit, editor: { uid: 'a', email: 'a@medievalclub.org' } });
        expect(updateDoc.mock.calls[0][1].editedByName).toBe('a@medievalclub.org');

        vi.clearAllMocks();
        await editWorkSession({ id: 's4', durationMinutes: 10 }, { ...validEdit, editor: undefined });
        const updates = updateDoc.mock.calls[0][1];
        expect(updates.editedBy).toBe('unknown');
        expect(updates.editedByName).toBe('Nežinomas');
    });
});

describe('deleteWorkSession (soft delete + audit trail)', () => {
    it('refuses a session with no id', async () => {
        expect(await deleteWorkSession({}, { reason: 'x' })).toEqual({ ok: false, error: 'missing' });
        expect(updateDoc).not.toHaveBeenCalled();
    });

    it('marks the row deleted with the reason + editor stamp (reason optional)', async () => {
        const res = await deleteWorkSession(
            { id: 's1' },
            { reason: '  orphaned 16h timer  ', editor: { uid: 'admin1', displayName: 'Admin One' } }
        );
        expect(res).toEqual({ ok: true });
        expect(updateDoc).toHaveBeenCalledTimes(1);

        const updates = updateDoc.mock.calls[0][1];
        expect(updates.isDeleted).toBe(true);
        expect(updates.deletedBy).toBe('admin1');
        expect(updates.deletedByName).toBe('Admin One');
        expect(updates.deleteReason).toBe('orphaned 16h timer'); // trimmed
    });

    it('allows an empty reason, storing null', async () => {
        const res = await deleteWorkSession({ id: 's1' }, { editor: { uid: 'admin1' } });
        expect(res.ok).toBe(true);
        expect(updateDoc.mock.calls[0][1].deleteReason).toBeNull();
    });
});

describe('createWorkSession (admin-authored manual session)', () => {
    const base = {
        userId: 'u1',
        userName: 'Worker',
        startTime: '2026-06-23T08:00:00.000Z',
        endTime: '2026-06-23T09:00:00.000Z',
        reason: 'forgot to start the timer',
        editor: { uid: 'admin1', displayName: 'Admin One' },
    };

    it('requires a target user', async () => {
        expect(await createWorkSession({ ...base, userId: undefined })).toEqual({ ok: false, error: 'user' });
        expect(addDoc).not.toHaveBeenCalled();
    });

    it('requires a non-blank reason', async () => {
        expect(await createWorkSession({ ...base, reason: '   ' })).toEqual({ ok: false, error: 'reason' });
        expect(addDoc).not.toHaveBeenCalled();
    });

    it('propagates a derive error and writes nothing', async () => {
        const r = await createWorkSession({ ...base, startTime: '2026-06-23T09:00:00.000Z', endTime: '2026-06-23T08:00:00.000Z' });
        expect(r).toEqual({ ok: false, error: 'order' });
        expect(addDoc).not.toHaveBeenCalled();
    });

    it('persists a manual-session payload and returns the new id', async () => {
        const res = await createWorkSession(base);
        expect(res).toEqual({ ok: true, id: 'generated-id', durationMinutes: 60, date: '2026-06-23' });
        expect(addDoc).toHaveBeenCalledTimes(1);

        const payload = addDoc.mock.calls[0][1];
        expect(payload.isManualSession).toBe(true);
        expect(payload.userId).toBe('u1');
        expect(payload.userName).toBe('Worker');
        expect(payload.durationMinutes).toBe(60);
        expect(payload.date).toBe('2026-06-23');
        expect(payload.createdByAdmin).toBe('admin1');
        expect(payload.createdByAdminName).toBe('Admin One');
        expect(payload.editReason).toBe('forgot to start the timer');
        // Synthetic taskId can never collide with a real Firestore task id.
        expect(String(payload.taskId)).toMatch(/^manual_/);
    });

    it('defaults a blank title and trims a supplied one', async () => {
        await createWorkSession({ ...base, taskTitle: '   ' });
        expect(addDoc.mock.calls[0][1].taskTitle).toBe('Rankinė sesija');

        vi.clearAllMocks();
        await createWorkSession({ ...base, taskTitle: '  Roof repair  ' });
        expect(addDoc.mock.calls[0][1].taskTitle).toBe('Roof repair');
    });
});

describe('worker notification on admin time correction (Step 4)', () => {
    it('notifies the session owner with a before→after summary after a successful edit', async () => {
        const session = {
            id: 's1',
            userId: 'worker-9',
            taskTitle: 'Roof repair',
            startTime: '2026-06-23T06:00:00.000Z',
            endTime: '2026-06-23T07:00:00.000Z',
            durationMinutes: 60,
        };
        await editWorkSession(session, {
            startTime: '2026-06-23T08:00:00.000Z',
            endTime: '2026-06-23T11:30:00.000Z', // 210 min
            reason: '  clock skew  ',
            editor: { uid: 'admin1', displayName: 'Admin One' },
        });
        expect(notify).toHaveBeenCalledTimes(1);
        const payload = notify.mock.calls[0][0];
        expect(payload).toMatchObject({
            recipientId: 'worker-9',
            type: 'session_edited',
            actorUid: 'admin1',
            actorName: 'Admin One',
            day: '2026-06-23',
            reason: 'clock skew', // trimmed by the action layer
            taskTitle: 'Roof repair',
        });
        expect(payload.summary).toBe('1h → 3h 30m'); // before 60m, after 210m
    });

    it('phrases the summary without an arrow when the prior duration is unknown', async () => {
        const session = { id: 's2', userId: 'w', startTime: 'x', endTime: 'y' }; // no durationMinutes
        await editWorkSession(session, {
            startTime: '2026-06-23T08:00:00.000Z',
            endTime: '2026-06-23T09:00:00.000Z', // 60 min
            reason: 'fix',
            editor: { uid: 'admin1' },
        });
        expect(notify.mock.calls[0][0].summary).toBe('nustatyta trukmė 1h');
    });

    it('notifies the owner with the delete summary + stored day after a successful delete', async () => {
        const session = { id: 's3', userId: 'worker-3', date: '2026-06-20', taskTitle: 'Demolition' };
        await deleteWorkSession(session, { reason: '  orphaned timer  ', editor: { uid: 'admin1', email: 'a@b.lt' } });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({
            recipientId: 'worker-3',
            type: 'session_deleted',
            actorUid: 'admin1',
            actorName: 'a@b.lt',
            day: '2026-06-20',
            summary: 'pašalinta sesija',
            reason: 'orphaned timer',
            taskTitle: 'Demolition',
        });
    });

    it('does NOT notify when the write itself fails', async () => {
        updateDoc.mockRejectedValueOnce(new Error('boom'));
        const res = await editWorkSession(
            { id: 's4', userId: 'w', durationMinutes: 10 },
            { startTime: '2026-06-23T08:00:00.000Z', endTime: '2026-06-23T09:00:00.000Z', reason: 'r', editor: { uid: 'a' } }
        );
        expect(res.ok).toBe(false);
        expect(notify).not.toHaveBeenCalled();
    });
});
