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
import { getLithuanianNow } from './timeUtils';
import { archiveOldTasks } from './automationUtils';

// NOTE: deadline-based priority escalation moved to a scheduled Cloud Function
// (functions/index.js → escalateTaskPriorities); its Vilnius-bucketing behaviour is covered by the
// firebase consistency gate. Only the client-side ARCHIVING job remains tested here.

const snapshotOf = (tasks) => ({ docs: tasks.map((t) => ({ id: t.id, data: () => t })) });

beforeEach(() => {
    vi.clearAllMocks();
});

describe('archiveOldTasks — work-day cutoff flips at 03:00 Vilnius', () => {
    it('after 03:00 Vilnius: archives tasks finished before today, keeps today', async () => {
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

    it('before 03:00 Vilnius: rolls the work-day back one day', async () => {
        // 23:00 UTC on 2026-06-20 = 02:00 Vilnius on 2026-06-21 (summer +3), which is
        // BEFORE 03:00 Vilnius -> the work-day is still 2026-06-20.
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
