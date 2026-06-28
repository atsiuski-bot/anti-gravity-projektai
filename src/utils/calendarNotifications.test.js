import { describe, it, expect, vi, beforeEach } from 'vitest';

// Characterization tests for logCalendarChange. The module is mostly Firestore I/O, but its
// load-bearing pure logic is the WEEK-BOUNDARY KEY it writes to: the doc id is
// `${uid}_${weekId}`, where weekId is the Monday of the *Vilnius* calendar week. Both this
// writer and the manager-side reader derive that key from the same Vilnius-day helper, so two
// devices near the Monday boundary must agree — otherwise the notification document never
// matches and the change is silently lost.
//
// Strategy: neutralise the firebase module graph and run against in-memory firestore fakes so
// we can inspect the exact doc path / payload (mirrors the taskFlagActions / sessionEditActions
// test convention). We mock ONLY getLithuanianNow so the reference instant is injectable; the
// real getLithuanianWeekId / getLithuanianDateString math runs unmocked, so the doc-id
// assertions genuinely exercise the Vilnius week-boundary + DST logic end-to-end.
vi.mock('../firebase', () => ({ db: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
    setDoc: vi.fn(() => Promise.resolve()),
    getDoc: vi.fn(() => Promise.resolve({ exists: () => false, data: () => ({}) })),
    updateDoc: vi.fn(() => Promise.resolve()),
    // arrayUnion is a sentinel in real firestore; tag it so we can assert it was used and that
    // the change record is carried inside it.
    arrayUnion: vi.fn((value) => ({ __arrayUnion: value })),
}));

// Inject the reference "now" without touching the real Vilnius/week math that consumes it.
vi.mock('./timeUtils', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, getLithuanianNow: vi.fn(() => new Date()) };
});

import { doc, setDoc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { getLithuanianNow, getLithuanianWeekId } from './timeUtils';
import { logCalendarChange } from './calendarNotifications';

const user = { uid: 'u123', displayName: 'Darius Pavardenis', email: 'darius@example.com' };

// Helper: pin the injected "now" for a single call.
const at = (iso) => getLithuanianNow.mockReturnValue(new Date(iso));

// A representative start/end pair for the absence/calendar change being logged.
const START = new Date('2026-06-23T08:00:00.000Z');
const END = new Date('2026-06-23T16:00:00.000Z');

beforeEach(() => {
    vi.clearAllMocks();
    setDoc.mockResolvedValue(undefined);
    updateDoc.mockResolvedValue(undefined);
    arrayUnion.mockImplementation((value) => ({ __arrayUnion: value }));
    // Default: document does not yet exist (new-batch branch).
    getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) });
});

describe('logCalendarChange — week-boundary doc key (Vilnius Monday)', () => {
    it('targets the calendar_notifications doc keyed by `${uid}_${weekId}`', async () => {
        // Wed 2026-06-24, mid-day -> Vilnius week's Monday is 2026-06-22.
        at('2026-06-24T12:00:00.000Z');
        await logCalendarChange(user, 'add', START, END);

        expect(doc).toHaveBeenCalledTimes(1);
        const [, col, id] = doc.mock.calls[0];
        expect(col).toBe('calendar_notifications');
        expect(id).toBe('u123_2026-06-22');
        // The id's week part is exactly what the shared helper computes for that instant.
        expect(id).toBe(`u123_${getLithuanianWeekId(new Date('2026-06-24T12:00:00.000Z'))}`);
    });

    it('buckets every weekday of one Vilnius week to the SAME Monday key', async () => {
        // Mon..Sun 2026-06-22 .. 2026-06-28, all mid-day UTC (same Vilnius calendar day).
        const days = [
            '2026-06-22', '2026-06-23', '2026-06-24', '2026-06-25',
            '2026-06-26', '2026-06-27', '2026-06-28',
        ];
        for (const day of days) {
            vi.clearAllMocks();
            at(`${day}T12:00:00.000Z`);
            await logCalendarChange(user, 'add', START, END);
            const [, , id] = doc.mock.calls[0];
            expect(id).toBe('u123_2026-06-22');
        }
    });

    it('rolls to the NEXT Monday key the moment the Vilnius week ticks over', async () => {
        // Sun 2026-06-28 mid-day -> still the 2026-06-22 week.
        at('2026-06-28T12:00:00.000Z');
        await logCalendarChange(user, 'add', START, END);
        expect(doc.mock.calls[0][2]).toBe('u123_2026-06-22');

        // Mon 2026-06-29 mid-day -> the new week, Monday 2026-06-29.
        vi.clearAllMocks();
        at('2026-06-29T12:00:00.000Z');
        await logCalendarChange(user, 'add', START, END);
        expect(doc.mock.calls[0][2]).toBe('u123_2026-06-29');
    });
});

describe('logCalendarChange — Vilnius/UTC week-boundary edge (Sunday->Monday cutoff)', () => {
    it('keys by the Vilnius day, not the raw UTC day, across the Sunday-night boundary (summer, UTC+3)', async () => {
        // 21:30 UTC Sun 2026-06-28 is 00:30 Vilnius Mon 2026-06-29 (summer). The Vilnius week has
        // already flipped to the 2026-06-29 Monday even though the UTC day is still Sunday — keying
        // off the raw UTC day would put it in the wrong (previous) week document.
        at('2026-06-28T21:30:00.000Z');
        await logCalendarChange(user, 'add', START, END);
        expect(doc.mock.calls[0][2]).toBe('u123_2026-06-29');
    });

    it('keys by the Vilnius day, not the raw UTC day, across the Sunday-night boundary (winter, UTC+2)', async () => {
        // 22:30 UTC Sun 2026-01-04 is 00:30 Vilnius Mon 2026-01-05 (winter). Vilnius week is the
        // 2026-01-05 Monday, despite the UTC day still reading Sunday 2026-01-04.
        at('2026-01-04T22:30:00.000Z');
        await logCalendarChange(user, 'add', START, END);
        expect(doc.mock.calls[0][2]).toBe('u123_2026-01-05');
    });

    it('still belongs to the OLD week just before the Vilnius Monday boundary (summer)', async () => {
        // 20:30 UTC Sun 2026-06-28 is 23:30 Vilnius Sun 2026-06-28 — still the 2026-06-22 week.
        at('2026-06-28T20:30:00.000Z');
        await logCalendarChange(user, 'add', START, END);
        expect(doc.mock.calls[0][2]).toBe('u123_2026-06-22');
    });
});

describe('logCalendarChange — DST handling of the week key', () => {
    // The Vilnius spring-forward / fall-back transitions happen on the last Sunday of March /
    // October. The week key is built from the Vilnius CALENDAR day, so it is computed correctly
    // regardless of the transition; these pin that the boundary day still keys to its own week.
    it('spring-forward Sunday (2026-03-29) keys to the week starting Monday 2026-03-23', async () => {
        // DST starts 2026-03-29 (Vilnius UTC+2 -> UTC+3). Mid-day that Sunday is the 2026-03-23 week.
        at('2026-03-29T10:00:00.000Z');
        await logCalendarChange(user, 'add', START, END);
        expect(doc.mock.calls[0][2]).toBe('u123_2026-03-23');

        // The very next day (Mon 2026-03-30) opens the new week.
        vi.clearAllMocks();
        at('2026-03-30T10:00:00.000Z');
        await logCalendarChange(user, 'add', START, END);
        expect(doc.mock.calls[0][2]).toBe('u123_2026-03-30');
    });

    it('fall-back Sunday (2026-10-25) keys to the week starting Monday 2026-10-19', async () => {
        // DST ends 2026-10-25 (Vilnius UTC+3 -> UTC+2). Mid-day that Sunday is the 2026-10-19 week.
        at('2026-10-25T10:00:00.000Z');
        await logCalendarChange(user, 'add', START, END);
        expect(doc.mock.calls[0][2]).toBe('u123_2026-10-19');
    });
});

describe('logCalendarChange — change record shape', () => {
    it('writes the type and ISO start/end/timestamp into a single change entry (new doc)', async () => {
        at('2026-06-24T12:00:00.000Z');
        await logCalendarChange(user, 'add', START, END);

        expect(setDoc).toHaveBeenCalledTimes(1);
        const [, payload] = setDoc.mock.calls[0];
        expect(payload.changes).toHaveLength(1);
        const change = payload.changes[0];
        expect(change.type).toBe('add');
        expect(change.start).toBe(START.toISOString());
        expect(change.end).toBe(END.toISOString());
        // timestamp is the injected "now" rendered as ISO.
        expect(change.timestamp).toBe('2026-06-24T12:00:00.000Z');
    });

    it('carries the change type verbatim (e.g. "delete")', async () => {
        at('2026-06-24T12:00:00.000Z');
        await logCalendarChange(user, 'delete', START, END);
        expect(setDoc.mock.calls[0][1].changes[0].type).toBe('delete');
    });
});

describe('logCalendarChange — new-document branch (setDoc)', () => {
    beforeEach(() => {
        getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) });
    });

    it('seeds userId, a formatted userName, the weekStart, the first change, and an empty dismissedBy', async () => {
        at('2026-06-24T12:00:00.000Z');
        await logCalendarChange(user, 'add', START, END);

        expect(setDoc).toHaveBeenCalledTimes(1);
        expect(updateDoc).not.toHaveBeenCalled();
        const [, payload] = setDoc.mock.calls[0];
        expect(payload.userId).toBe('u123');
        // formatDisplayName("Darius Pavardenis") -> "Darius P."
        expect(payload.userName).toBe('Darius P.');
        expect(payload.weekStart).toBe('2026-06-22');
        expect(payload.dismissedBy).toEqual([]);
        expect(payload.changes).toHaveLength(1);
    });

    it('falls back to email for userName when there is no displayName', async () => {
        at('2026-06-24T12:00:00.000Z');
        await logCalendarChange({ uid: 'u123', email: 'darius@example.com' }, 'add', START, END);
        expect(setDoc.mock.calls[0][1].userName).toBe('darius@example.com');
    });
});

describe('logCalendarChange — existing, not-dismissed document (append)', () => {
    it('appends the change via arrayUnion and clears dismissedBy', async () => {
        getDoc.mockResolvedValue({
            exists: () => true,
            data: () => ({ changes: [{ type: 'add' }], dismissedBy: [] }),
        });
        at('2026-06-24T12:00:00.000Z');
        await logCalendarChange(user, 'delete', START, END);

        expect(setDoc).not.toHaveBeenCalled();
        expect(updateDoc).toHaveBeenCalledTimes(1);
        const [, payload] = updateDoc.mock.calls[0];
        // The change is wrapped in the arrayUnion sentinel (append, not replace).
        expect(arrayUnion).toHaveBeenCalledTimes(1);
        expect(payload.changes).toEqual({ __arrayUnion: arrayUnion.mock.results[0].value.__arrayUnion });
        expect(payload.changes.__arrayUnion.type).toBe('delete');
        expect(payload.dismissedBy).toEqual([]);
    });

    it('treats a doc with no dismissedBy field as not-dismissed (append)', async () => {
        getDoc.mockResolvedValue({
            exists: () => true,
            data: () => ({ changes: [{ type: 'add' }] }), // dismissedBy absent
        });
        at('2026-06-24T12:00:00.000Z');
        await logCalendarChange(user, 'add', START, END);

        expect(updateDoc).toHaveBeenCalledTimes(1);
        expect(arrayUnion).toHaveBeenCalledTimes(1);
    });
});

describe('logCalendarChange — existing, dismissed document (fresh batch)', () => {
    it('starts a fresh changes batch (no arrayUnion) and resets dismissedBy when previously dismissed', async () => {
        getDoc.mockResolvedValue({
            exists: () => true,
            data: () => ({ changes: [{ type: 'add' }, { type: 'add' }], dismissedBy: ['mgr1'] }),
        });
        at('2026-06-24T12:00:00.000Z');
        await logCalendarChange(user, 'delete', START, END);

        expect(setDoc).not.toHaveBeenCalled();
        expect(updateDoc).toHaveBeenCalledTimes(1);
        const [, payload] = updateDoc.mock.calls[0];
        // Fresh batch: a plain array of exactly the new change, NOT an arrayUnion append.
        expect(arrayUnion).not.toHaveBeenCalled();
        expect(Array.isArray(payload.changes)).toBe(true);
        expect(payload.changes).toHaveLength(1);
        expect(payload.changes[0].type).toBe('delete');
        expect(payload.dismissedBy).toEqual([]);
    });
});

describe('logCalendarChange — error handling', () => {
    it('swallows a Firestore read error (logs, does not throw)', async () => {
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
        getDoc.mockRejectedValue(new Error('permission-denied'));
        at('2026-06-24T12:00:00.000Z');

        await expect(logCalendarChange(user, 'add', START, END)).resolves.toBeUndefined();
        expect(consoleErr).toHaveBeenCalled();
        expect(setDoc).not.toHaveBeenCalled();
        consoleErr.mockRestore();
    });

    it('swallows a write error too', async () => {
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
        getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) });
        setDoc.mockRejectedValue(new Error('network'));
        at('2026-06-24T12:00:00.000Z');

        await expect(logCalendarChange(user, 'add', START, END)).resolves.toBeUndefined();
        expect(consoleErr).toHaveBeenCalled();
        consoleErr.mockRestore();
    });
});
