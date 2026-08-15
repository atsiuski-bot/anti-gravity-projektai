import { describe, it, expect } from 'vitest';
import { collectPeopleOptions, narrowRows } from './usePeopleSearchFilter';
import { getTaskMatchFields } from '../utils/taskSearch';
import { formatDisplayName } from '../utils/formatters';

// The pure half of the hook: WHO gets a pill, and WHAT survives a person + query narrowing. The
// React half (state, 200 ms debounce) is a thin wrapper over exactly these two functions, so
// covering them here covers the behaviour every Komandos veiklos sub-tab now shares.

const task = (id, assignedUserId, assignedUserName, title, extra = {}) => ({
    id, assignedUserId, assignedUserName, title, ...extra,
});

const taskPersonId = (t) => t?.assignedUserId || '';
const labelFromTask = (t) => formatDisplayName(t?.assignedUserName || '') || '—';

const narrow = (list, filterUser, query, opts = {}) => narrowRows(list, {
    filterUser,
    query,
    getPersonId: opts.getPersonId || taskPersonId,
    getMatchFields: opts.getMatchFields || getTaskMatchFields,
    resolveLabel: opts.resolveLabel || labelFromTask,
});

describe('collectPeopleOptions — the assignee pills', () => {
    const rows = [
        task('t1', 'u-jonas', 'Jonas Kazlauskas', 'Dažymas'),
        task('t2', 'u-petras', 'Petras Butkus', 'Montavimas'),
        task('t3', 'u-jonas', 'Jonas Kazlauskas', 'Valymas'),
        task('t4', 'u-aiste', 'Aistė Vaitkutė', 'Pjovimas'),
    ];

    it('offers each person once, sorted by the Lithuanian collation', () => {
        expect(collectPeopleOptions(rows, taskPersonId, labelFromTask)).toEqual([
            { value: 'u-aiste', label: 'Aistė V.', userId: 'u-aiste' },
            { value: 'u-jonas', label: 'Jonas K.', userId: 'u-jonas' },
            { value: 'u-petras', label: 'Petras B.', userId: 'u-petras' },
        ]);
    });

    it('never offers a pill with no row behind it', () => {
        // Only the people PRESENT in the list — an unassigned row contributes no pill at all,
        // so a pill can never filter the tab down to nothing.
        const withUnassigned = [...rows, task('t5', '', '', 'Be meistro')];
        const ids = collectPeopleOptions(withUnassigned, taskPersonId, labelFromTask).map((p) => p.value);
        expect(ids).toEqual(['u-aiste', 'u-jonas', 'u-petras']);
        expect(collectPeopleOptions([], taskPersonId, labelFromTask)).toEqual([]);
    });

    it('labels a person with the resolver the caller supplies (fresh roster name)', () => {
        // The hook passes a resolver that prefers the live roster over the name denormalised onto
        // the row — a renamed worker must not read as two different people.
        const fresh = new Map([['u-jonas', 'Jonas Kazlauskas-Naujokas']]);
        const resolve = (t) => formatDisplayName(fresh.get(taskPersonId(t)) || t.assignedUserName) || '—';
        const jonas = collectPeopleOptions(rows, taskPersonId, resolve).find((p) => p.value === 'u-jonas');
        expect(jonas.label).toBe('Jonas K.');
    });
});

describe('narrowRows — person filter + free-text search', () => {
    // t3 is deliberately far from "dažymas" in edit distance: the shared search core is
    // typo-tolerant, so a near-miss title (e.g. "Valymas", two edits away) would legitimately
    // match and say nothing about the person/query composition under test here.
    const rows = [
        task('t1', 'u-jonas', 'Jonas Kazlauskas', 'Dažymas', { tag: 'Statyba' }),
        task('t2', 'u-petras', 'Petras Butkus', 'Dažymas antrame aukšte'),
        task('t3', 'u-jonas', 'Jonas Kazlauskas', 'Krovinių pakrovimas'),
    ];

    it('returns the list untouched when nothing is selected and nothing is typed', () => {
        expect(narrow(rows, '', '').map((t) => t.id)).toEqual(['t1', 't2', 't3']);
        expect(narrow(rows, '', '   ').map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    });

    it('keeps only the rows belonging to the selected person', () => {
        expect(narrow(rows, 'u-jonas', '').map((t) => t.id)).toEqual(['t1', 't3']);
    });

    it('searches without diacritics — a phone keyboard finds "Dažymas" as "dazymas"', () => {
        expect(narrow(rows, '', 'dazymas').map((t) => t.id).sort()).toEqual(['t1', 't2']);
    });

    it('matches a person by name typed into the search box', () => {
        expect(narrow(rows, '', 'petras').map((t) => t.id)).toEqual(['t2']);
    });

    it('applies BOTH cuts — the query searches only within the chosen person', () => {
        expect(narrow(rows, 'u-jonas', 'dazymas').map((t) => t.id)).toEqual(['t1']);
        // "pakrovimas" only exists on Jonas' row, so asking for it under Petras yields nothing.
        expect(narrow(rows, 'u-petras', 'pakrovimas')).toEqual([]);
    });

    it('finds a row by its person even when the row stores no name — via the resolved label', () => {
        // The recurring-template shape: the meistras is an id inside `data`, with no name on the
        // row. getMatchFields receives the RESOLVED label as its second argument, which is what
        // makes "jonas" reach the template at all.
        const template = { id: 'tpl1', templateName: 'Rytinis patikrinimas', data: { assignedUserId: 'u-jonas' } };
        const opts = {
            getPersonId: (t) => t?.data?.assignedUserId || '',
            getMatchFields: (t, person) => [
                { text: t.templateName, weight: 1 },
                { text: person, weight: 0.9 },
            ],
            resolveLabel: () => 'Jonas K.',
        };
        expect(narrow([template], '', 'jonas', opts).map((t) => t.id)).toEqual(['tpl1']);
        expect(narrow([template], '', 'rytinis', opts).map((t) => t.id)).toEqual(['tpl1']);
        expect(narrow([template], '', 'petras', opts)).toEqual([]);
    });
});
