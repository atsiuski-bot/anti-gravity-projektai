import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDisplayName } from '../utils/formatters';
import {
    filterRankTasks,
    buildTaskSuggestions,
    getTaskMatchFields,
    getTaskSuggestionSources,
} from '../utils/taskSearch';

// Default accessors — the task shape. Declared at module level so a caller that takes the
// defaults passes the SAME function identity on every render, and the memos below never churn.
const taskPersonId = (task) => task?.assignedUserId || '';
const taskPersonName = (task) => task?.assignedUserName || '';

/**
 * PURE: the pill options for a list — one entry per person who actually owns a row, deduped and
 * sorted by the Lithuanian collation. Never a static roster: a pill with no row behind it would
 * be a dead filter. Exported so the decision is unit-testable without rendering React.
 *
 * @param {object[]} items
 * @param {(item: object) => string} getPersonId
 * @param {(item: object) => string} resolveLabel - display name for the row's person.
 * @returns {{value: string, label: string, userId: string}[]}
 */
export function collectPeopleOptions(items, getPersonId, resolveLabel) {
    const seen = new Map();
    for (const item of items || []) {
        const id = getPersonId(item);
        if (!id || seen.has(id)) continue;
        seen.set(id, resolveLabel(item));
    }
    return [...seen.entries()]
        .map(([value, label]) => ({ value, label, userId: value }))
        .sort((a, b) => a.label.localeCompare(b.label, 'lt'));
}

/**
 * PURE: narrow a list by the selected person and then by the free-text query. Order matters — the
 * person filter is a hard structural cut, the query then RANKS what survives by relevance, so the
 * best match floats up within the chosen person's rows rather than across the whole list.
 *
 * @param {object[]} list
 * @param {object} opts
 * @param {string} opts.filterUser - '' = every person.
 * @param {string} opts.query - raw text; blank leaves the incoming order untouched.
 * @param {(item: object) => string} opts.getPersonId
 * @param {(item: object, personLabel: string) => {text?: string, weight?: number}[]} opts.getMatchFields
 * @param {(item: object) => string} opts.resolveLabel
 * @returns {object[]}
 */
export function narrowRows(list, { filterUser, query, getPersonId, getMatchFields, resolveLabel }) {
    let out = list || [];
    if (filterUser) out = out.filter((item) => getPersonId(item) === filterUser);
    const trimmed = (query || '').trim();
    if (!trimmed) return out;
    return filterRankTasks(out, trimmed, (item) => getMatchFields(item, resolveLabel(item)));
}

/**
 * usePeopleSearchFilter — the "free-text search + filter by person" pair that the team task list
 * ("Sąrašas užduočių") carries, extracted so every OTHER Komandos veiklos sub-tab can mount the
 * same behaviour over its own rows. `useTaskFiltering` stays the list tab's own hook: it also owns
 * priority/tag/status/sort and the active-task scoping, none of which the sibling tabs have.
 *
 * Two deliberate properties, both inherited from the list tab:
 *  - **The people come from the rows in view, never from a static roster.** A pill that filtered
 *    to an empty list would be a dead control; deriving them from `items` means every pill has at
 *    least one row behind it, and a person whose rows all left the tab stops being offered.
 *  - **Search is the shared fuzzy core** (utils/taskSearch): diacritic-insensitive, typo-tolerant
 *    and relevance-ranked, so "dazymas" finds "Dažymas" here exactly as it does in the list tab.
 *    The list re-filter is debounced; the suggestions follow the live text so they feel instant.
 *
 * A surface that renders its rows in several sections (e.g. Pridavimas: "šiandien" + "anksčiau")
 * uses `apply()` on each section, so one control narrows all of them identically while `people`
 * still describes the whole tab.
 *
 * @param {object[]} items - every row the tab can show, unfiltered.
 * @param {object} [options]
 * @param {object[]} [options.users] - live roster; a fresh displayName beats the row's stored copy.
 * @param {(item: object) => string} [options.getPersonId] - the person a row belongs to.
 * @param {(item: object) => string} [options.getPersonName] - fallback name stored ON the row.
 * @param {(item: object, personLabel: string) => {text?: string, weight?: number}[]} [options.getMatchFields]
 * @param {(item: object, personLabel: string) => {value?: string, kind: string}[]} [options.getSuggestionSources]
 *   The two search accessors receive the RESOLVED person label as a second argument, so a
 *   non-task row (e.g. a recurring template, which stores no assignee name) can still be found by
 *   typing the meistras' name. Pass stable (module-level or `useCallback`) functions.
 */
export function usePeopleSearchFilter(items, {
    users,
    getPersonId = taskPersonId,
    getPersonName = taskPersonName,
    getMatchFields = getTaskMatchFields,
    getSuggestionSources = getTaskSuggestionSources,
} = {}) {
    const [filterUser, setFilterUser] = useState('');
    const [searchText, setSearchText] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useEffect(() => {
        const handle = setTimeout(() => setDebouncedSearch(searchText), 200);
        return () => clearTimeout(handle);
    }, [searchText]);

    // Fresh roster names win over the denormalised copy stored on the row (a renamed worker must
    // not read as two different people between the pill and the row).
    const nameById = useMemo(
        () => new Map((users || []).map((u) => [u.id, u.displayName || u.email || ''])),
        [users]
    );

    const personLabel = useCallback((item) => {
        const id = getPersonId(item);
        if (!id) return '';
        return formatDisplayName(nameById.get(id) || getPersonName(item) || '') || '—';
    }, [nameById, getPersonId, getPersonName]);

    const people = useMemo(
        () => collectPeopleOptions(items, getPersonId, personLabel),
        [items, getPersonId, personLabel]
    );

    // If the selected person stops owning any row, fall back to "Visi" — otherwise the tab empties
    // behind an orphaned filter with no visible cause (the same guard the list tab's tags have).
    useEffect(() => {
        if (filterUser && !people.some((p) => p.value === filterUser)) setFilterUser('');
    }, [filterUser, people]);

    const apply = useCallback(
        (list) => narrowRows(list, {
            filterUser,
            query: debouncedSearch,
            getPersonId,
            getMatchFields,
            resolveLabel: personLabel,
        }),
        [filterUser, debouncedSearch, getPersonId, getMatchFields, personLabel]
    );

    const filtered = useMemo(() => apply(items), [apply, items]);

    // Suggestions read the person-narrowed set (not the search-narrowed one), so they only offer
    // completions that are actually reachable from where the user stands. They follow the LIVE
    // text, not the debounced one, so completions feel instant while the list re-filter waits.
    const suggestions = useMemo(() => {
        if (!searchText.trim()) return [];
        const scoped = narrowRows(items, { filterUser, query: '', getPersonId, getMatchFields, resolveLabel: personLabel });
        return buildTaskSuggestions(scoped, searchText, (item) => getSuggestionSources(item, personLabel(item)));
    }, [items, searchText, filterUser, getPersonId, getMatchFields, getSuggestionSources, personLabel]);

    const isFiltering = !!filterUser || debouncedSearch.trim().length > 0;

    return {
        filtered,
        apply,
        people,
        filterUser,
        setFilterUser,
        searchText,
        setSearchText,
        suggestions,
        isFiltering,
    };
}
