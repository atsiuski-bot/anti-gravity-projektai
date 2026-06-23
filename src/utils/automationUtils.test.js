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

import { getDocs, updateDoc } from 'firebase/firestore';
import { archiveTask } from './taskActions';
import { getLithuanianNow } from './timeUtils';
import { checkAndPromoteTasks, archiveOldTasks } from './automationUtils';

const snapshotOf = (tasks) => ({ docs: tasks.map((t) => ({ id: t.id, data: () => t })) });

// Build a map of taskId -> priority written by checkAndPromoteTasks.
const promotedPriorities = () => {
    const out = {};
    for (const [ref, data] of updateDoc.mock.calls) out[ref.id] = data.priority;
    return out;
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe('checkAndPromoteTasks — deadline buckets are computed in Vilnius time', () => {
    it('buckets overdue/today/tomorrow -> Urgent, day-after-tomorrow -> High, 3+ days -> untouched', async () => {
        // "now" = 2026-06-21 15:00 Vilnius (summer, UTC+3). todayStr = 2026-06-21.
        getLithuanianNow.mockReturnValue(new Date('2026-06-21T12:00:00Z'));
        getDocs.mockResolvedValue(
            snapshotOf([
                { id: 'overdue', deadline: '2026-06-19T10:00:00Z', priority: 'Medium' },
                { id: 'today', deadline: '2026-06-21T10:00:00Z', priority: 'Low' },
                { id: 'tomorrow', deadline: '2026-06-22T08:00:00Z', priority: 'Medium' },
                { id: 'dayAfter', deadline: '2026-06-23T08:00:00Z', priority: 'Medium' },
                { id: 'far', deadline: '2026-06-30T08:00:00Z', priority: 'Low' },
            ])
        );

        const count = await checkAndPromoteTasks();
        const pr = promotedPriorities();

        expect(pr.overdue).toBe('Urgent');
        expect(pr.today).toBe('Urgent');
        expect(pr.tomorrow).toBe('Urgent');
        expect(pr.dayAfter).toBe('High');
        expect(pr.far).toBeUndefined(); // 3+ days out -> no update
        expect(count).toBe(4);
    });

    it('uses the Vilnius day, not the UTC day, at the day boundary (the bug the fix closed)', async () => {
        getLithuanianNow.mockReturnValue(new Date('2026-06-21T12:00:00Z')); // today = 2026-06-21
        // 22:00 UTC on the 22nd is 01:00 Vilnius on the 23rd (summer +3): a Vilnius
        // day-after-tomorrow -> High. The old local/UTC-date logic mis-read it as the
        // 22nd (tomorrow) and would have promoted it to Urgent.
        getDocs.mockResolvedValue(
            snapshotOf([{ id: 'boundary', deadline: '2026-06-22T22:00:00Z', priority: 'Medium' }])
        );

        await checkAndPromoteTasks();
        expect(promotedPriorities().boundary).toBe('High');
    });

    it('skips tasks with no deadline and tasks already at the target priority', async () => {
        getLithuanianNow.mockReturnValue(new Date('2026-06-21T12:00:00Z'));
        getDocs.mockResolvedValue(
            snapshotOf([
                { id: 'noDeadline', priority: 'Low' },
                { id: 'alreadyUrgent', deadline: '2026-06-21T10:00:00Z', priority: 'Urgent' },
            ])
        );

        const count = await checkAndPromoteTasks();
        expect(updateDoc).not.toHaveBeenCalled();
        expect(count).toBe(0);
    });
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
