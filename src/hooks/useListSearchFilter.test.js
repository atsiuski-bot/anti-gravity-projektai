import { describe, it, expect } from 'vitest';
import { buildAssigneeOptions, applyListSearchFilter, getItemAssigneeId } from './useListSearchFilter';

// The hook's React wiring (useState/useEffect debounce) is not rendered — the project has no React
// test harness. What is unique and purely testable is the two behaviours the four manager sub-tabs
// now share: which PEOPLE become filter pills, and how a pill + a query narrow a list together.

const task = (over = {}) => ({ id: 'x', title: 'Darbas', ...over });

describe('buildAssigneeOptions — the pills are derived from the list, not the roster', () => {
    const users = [
        { id: 'u1', displayName: 'Jonas Kazlauskas' },
        { id: 'u2', displayName: 'Asta Petraitė' },
        { id: 'u9', displayName: 'Niekada Nedirbantis' },
    ];

    it('offers only people who actually have a row, deduped and sorted by display name', () => {
        const items = [
            task({ id: 'a', assignedUserId: 'u1' }),
            task({ id: 'b', assignedUserId: 'u2' }),
            task({ id: 'c', assignedUserId: 'u1' }),
        ];
        // u9 has no row, so it must not offer a pill that leads to an empty list.
        expect(buildAssigneeOptions(items, { users })).toEqual([
            { value: 'u2', label: 'Asta P.', userId: 'u2' },
            { value: 'u1', label: 'Jonas K.', userId: 'u1' },
        ]);
    });

    it('prefers the live roster name over the name denormalised onto the row', () => {
        const items = [task({ assignedUserId: 'u1', assignedUserName: 'Senas Vardas' })];
        expect(buildAssigneeOptions(items, { users })[0].label).toBe('Jonas K.');
    });

    it('falls back to the row name when the person is not in the roster', () => {
        const items = [task({ assignedUserId: 'gone', assignedUserName: 'Buvęs Darbuotojas' })];
        expect(buildAssigneeOptions(items, { users: [] })[0].label).toBe('Buvęs D.');
    });

    it('skips rows with no assignee rather than offering an "unknown" pill', () => {
        expect(getItemAssigneeId(task({}))).toBe('');
        expect(buildAssigneeOptions([task({})], { users })).toEqual([]);
    });

    it('folds in extraAssignees, deduped against the list — Istorija\'s archive-only people', () => {
        // u1 has a live row; u2's rows exist only in the archive below, which reports it separately.
        // Both must offer a pill, exactly once each, or the archive cannot be filtered by u2 at all.
        const items = [task({ assignedUserId: 'u1' })];
        const out = buildAssigneeOptions(items, {
            users,
            extraAssignees: [{ id: 'u2', name: 'Asta Petraitė' }, { id: 'u1', name: 'Jonas Kazlauskas' }],
        });
        expect(out).toEqual([
            { value: 'u2', label: 'Asta P.', userId: 'u2' },
            { value: 'u1', label: 'Jonas K.', userId: 'u1' },
        ]);
    });
});

describe('applyListSearchFilter — person first, then relevance', () => {
    const items = [
        task({ id: 'a', title: 'Dažymas', assignedUserId: 'u1' }),
        task({ id: 'b', title: 'Dažymas', assignedUserId: 'u2' }),
        task({ id: 'c', title: 'Tvarkymas', assignedUserId: 'u1' }),
    ];

    it('returns the list untouched when nothing is selected or typed', () => {
        expect(applyListSearchFilter(items, {})).toBe(items);
    });

    it('narrows to one person', () => {
        expect(applyListSearchFilter(items, { filterUser: 'u1' }).map(t => t.id)).toEqual(['a', 'c']);
    });

    it('applies the person filter BEFORE the query, so search never widens past the pill', () => {
        const out = applyListSearchFilter(items, { filterUser: 'u1', query: 'dazymas' });
        expect(out.map(t => t.id)).toEqual(['a']);
    });

    it('matches diacritic-free typing, like every other list in the app', () => {
        expect(applyListSearchFilter(items, { query: 'dazymas' }).map(t => t.id).sort()).toEqual(['a', 'b']);
    });
});
