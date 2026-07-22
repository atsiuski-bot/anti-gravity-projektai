import { describe, it, expect } from 'vitest';
import { excludeDeleted, mergeTaskSources } from './useWorkerStats';

describe('excludeDeleted', () => {
    it('drops soft-deleted (isDeleted: true) docs and keeps the rest', () => {
        const docs = [
            { id: 'a', durationMinutes: 60 },
            { id: 'b', durationMinutes: 960, isDeleted: true }, // voided ghost session
            { id: 'c', durationMinutes: 30, isDeleted: false },
        ];
        expect(excludeDeleted(docs)).toEqual([
            { id: 'a', durationMinutes: 60 },
            { id: 'c', durationMinutes: 30, isDeleted: false },
        ]);
    });
});

describe('mergeTaskSources', () => {
    it('counts a mid-archive task once, keeping the archived copy', () => {
        // Same doc id in both collections: the archiver has copied the task but not yet deleted
        // the `tasks` row. Concatenating both counted the task twice.
        const archived = [{ id: 't1', title: 'Stogas', archivedAt: '2026-07-20' }];
        const active = [{ id: 't1', title: 'Stogas' }, { id: 't2', title: 'Tvora' }];
        expect(mergeTaskSources(archived, active)).toEqual([
            { id: 't1', title: 'Stogas', archivedAt: '2026-07-20' },
            { id: 't2', title: 'Tvora' },
        ]);
    });

    it('keeps every task when the two sources do not overlap', () => {
        const archived = [{ id: 'a1' }];
        const active = [{ id: 'a2' }];
        expect(mergeTaskSources(archived, active)).toEqual([{ id: 'a1' }, { id: 'a2' }]);
    });
});
