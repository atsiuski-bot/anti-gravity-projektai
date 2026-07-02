import { describe, it, expect } from 'vitest';
import { excludeDeleted } from './useWorkerStats';

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
