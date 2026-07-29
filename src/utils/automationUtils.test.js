import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Firestore SDK and the firebase wrapper so the automation functions run
// against in-memory fakes. Keep the REAL timeUtils helpers (date math is what we are
// testing) but override getLithuanianNow so "now" is injectable and deterministic.
vi.mock('../firebase', () => ({ db: {} }));

vi.mock('firebase/firestore', () => ({
    collection: vi.fn(() => 'tasks-collection'),
    query: vi.fn((...args) => args),
    where: vi.fn(() => 'where-clause'),
    doc: vi.fn((_db, _col, id) => ({ id })),
    getDocs: vi.fn(),
    updateDoc: vi.fn(() => Promise.resolve()),
}));

vi.mock('./taskActions', () => ({ archiveTask: vi.fn(() => Promise.resolve()) }));

vi.mock('./timeUtils', async (importActual) => ({
    ...(await importActual()),
    getLithuanianNow: vi.fn(),
}));

import { getDocs } from 'firebase/firestore';
import { archiveTask } from './taskActions';
import { getLithuanianNow, getLithuanianDateString } from './timeUtils';
import { archiveOldTasks, runDailyAutomation } from './automationUtils';

// NOTE: deadline-based priority escalation moved to a scheduled Cloud Function
// (functions/index.js → escalateTaskPriorities); its Vilnius-bucketing behaviour is covered by the
// firebase consistency gate. Only the client-side ARCHIVING job remains tested here.

const snapshotOf = (tasks) => ({ docs: tasks.map((t) => ({ id: t.id, data: () => t })) });

beforeEach(() => {
    vi.clearAllMocks();
});

describe('archiveOldTasks — work-day cutoff flips at 05:00 Vilnius', () => {
    it('after the boundary: archives tasks finished before today, keeps today', async () => {
        // 15:00 Vilnius on 2026-06-21 -> cutoff = 2026-06-21.
        getLithuanianNow.mockReturnValue(new Date('2026-06-21T12:00:00Z'));
        getDocs
            .mockResolvedValueOnce(snapshotOf([
                { id: 'old', status: 'confirmed', confirmedAt: '2026-06-19T10:00:00Z' },
                { id: 'todayDone', status: 'confirmed', confirmedAt: '2026-06-21T10:00:00Z' },
            ]))
            .mockResolvedValueOnce(snapshotOf([]));

        await archiveOldTasks();

        const archivedIds = archiveTask.mock.calls.map((c) => c[0].id);
        expect(archivedIds).toContain('old');
        expect(archivedIds).not.toContain('todayDone');
    });

    it('before the boundary: rolls the work-day back one day', async () => {
        // 23:00 UTC on 2026-06-20 = 02:00 Vilnius on 2026-06-21 (summer +3), which is
        // BEFORE the boundary -> the work-day is still 2026-06-20.
        getLithuanianNow.mockReturnValue(new Date('2026-06-20T23:00:00Z'));
        getDocs
            .mockResolvedValueOnce(snapshotOf([
                { id: 'twoDaysAgo', status: 'confirmed', confirmedAt: '2026-06-19T10:00:00Z' },
                { id: 'yesterday', status: 'confirmed', confirmedAt: '2026-06-20T10:00:00Z' },
            ]))
            .mockResolvedValueOnce(snapshotOf([]));

        await archiveOldTasks();

        const archivedIds = archiveTask.mock.calls.map((c) => c[0].id);
        expect(archivedIds).toContain('twoDaysAgo');
        expect(archivedIds).not.toContain('yesterday'); // cutoff rolled back to 06-20
    });

    // The band that moving the boundary from 03:00 to 05:00 actually changed, and the reason the
    // move was made: a night shift that ends before dawn belongs to the day it started on. Under
    // the old 03:00 boundary this instant was already "the next work day", so the previous day's
    // finished work was archived out from under a worker who was still on shift.
    it('04:00 Vilnius still belongs to the PREVIOUS work day (the night-shift case)', async () => {
        // 01:00 UTC on 2026-06-21 = 04:00 Vilnius (summer +3): after the old 03:00 boundary but
        // before the current 05:00 one -> the work-day must still be 2026-06-20.
        getLithuanianNow.mockReturnValue(new Date('2026-06-21T01:00:00Z'));
        getDocs
            .mockResolvedValueOnce(snapshotOf([
                { id: 'twoDaysAgo', status: 'confirmed', confirmedAt: '2026-06-19T10:00:00Z' },
                // 20:00 UTC = 23:00 Vilnius on 06-20, so its Vilnius DAY is 2026-06-20 — the day
                // the shift began. (22:00 UTC would already bucket to 06-21 and make this test
                // pass under either boundary, i.e. prove nothing.)
                { id: 'nightShift', status: 'confirmed', confirmedAt: '2026-06-20T20:00:00Z' },
            ]))
            .mockResolvedValueOnce(snapshotOf([]));

        await archiveOldTasks();

        const archivedIds = archiveTask.mock.calls.map((c) => c[0].id);
        expect(archivedIds).toContain('twoDaysAgo');
        expect(archivedIds).not.toContain('nightShift');
    });

    it('buckets the confirmedAt to its Vilnius day, not the UTC day (the late-evening bug)', async () => {
        // now = 15:00 Vilnius on 2026-06-22 -> cutoff = 2026-06-22.
        getLithuanianNow.mockReturnValue(new Date('2026-06-22T12:00:00Z'));
        // 22:30 UTC on the 21st is 01:30 Vilnius on the 22nd (summer +3): its Vilnius work-day
        // is TODAY (06-22), so it must NOT be archived. The old relevantDate.split('T')[0] took
        // the UTC date '2026-06-21' < cutoff and would have archived it a cycle too soon.
        getDocs
            .mockResolvedValueOnce(snapshotOf([
                { id: 'lateEvening', status: 'confirmed', confirmedAt: '2026-06-21T22:30:00Z' },
            ]))
            .mockResolvedValueOnce(snapshotOf([]));

        await archiveOldTasks();

        const archivedIds = archiveTask.mock.calls.map((c) => c[0].id);
        expect(archivedIds).not.toContain('lateEvening');
    });
});

// ── The once-per-day latch ──────────────────────────────────────────────────────────────────────
// The latch used to be stamped when the check RAN, so the day's first app-open consumed its only
// chance and a failed sweep waited until tomorrow. It is now claimed only after the work succeeds.
describe('runDailyAutomation — the day is marked done only after a successful sweep', () => {
    let store;

    beforeEach(() => {
        store = new Map();
        globalThis.localStorage = {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
        };
        // 15:00 Vilnius — past the boundary, so the work-day is the same calendar day throughout.
        getLithuanianNow.mockReturnValue(new Date('2026-06-21T12:00:00Z'));
    });

    it('retries on the next open when the sweep failed', async () => {
        getDocs.mockRejectedValueOnce(new Error('offline'));
        await runDailyAutomation();
        expect(store.get('lastAutomationRun')).toBeUndefined();

        // Second open, same day: the query is attempted AGAIN rather than short-circuited.
        getDocs
            .mockResolvedValueOnce(snapshotOf([{ id: 'old', status: 'confirmed', confirmedAt: '2026-06-19T10:00:00Z' }]))
            .mockResolvedValueOnce(snapshotOf([]));
        await runDailyAutomation();
        expect(archiveTask.mock.calls.map((c) => c[0].id)).toContain('old');
        expect(store.get('lastAutomationRun')).toBe(getLithuanianDateString());
    });

    it('does not sweep twice once the day succeeded', async () => {
        getDocs.mockResolvedValueOnce(snapshotOf([])).mockResolvedValueOnce(snapshotOf([]));
        await runDailyAutomation();
        expect(store.get('lastAutomationRun')).toBe(getLithuanianDateString());

        getDocs.mockClear();
        await runDailyAutomation();
        expect(getDocs).not.toHaveBeenCalled();
    });
});
