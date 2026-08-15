import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDisplayName, resolveUserId } from '../utils/formatters';
import {
    filterRankTasks,
    buildTaskSuggestions,
    getTaskMatchFields,
    getTaskSuggestionSources,
} from '../utils/taskSearch';

/**
 * useListSearchFilter — the shared "free-text search + filter by one person" behaviour for the
 * manager sub-tabs that are NOT the canonical team list.
 *
 * The team list ("Sąrašas užduočių") already had both, wired into `useTaskFiltering` alongside its
 * priority/tag/status/sort machinery. The sibling tabs (Laukia patvirtinimo, Pridavimas, Istorija,
 * Pasikartojančios užduotys) each render a different KIND of row from a different source, so they
 * cannot reuse that hook — but they must search and filter IDENTICALLY, or a manager learns one
 * behaviour on one tab and a different one on the next. This hook is that single behaviour,
 * parameterised only by how to read an item's assignee and its searchable text.
 *
 * Two guarantees it centralises:
 *  - **The person pills are derived from what is actually in the list**, never a static roster, so
 *    a pill never points at an empty result; if the selected person leaves the list, the filter
 *    self-heals back to "Visi" instead of stranding an empty screen behind an invisible filter.
 *  - **The assignee's CURRENT name is always searchable**, resolved from the live roster and
 *    appended to whatever fields the caller supplies. A row whose denormalised name is missing or
 *    stale still answers to the person's real name.
 *
 * The accessors default to the task shape; callers with another shape (e.g. recurring templates)
 * pass their own. They must be **module-level constants** (or memoised) — they are memo/callback
 * dependencies, so an inline arrow would re-derive on every render.
 *
 * @param {object[]} items - the unfiltered list this surface shows.
 * @param {object}   [opts]
 * @param {object[]} [opts.users] - live roster, for fresh display names on the pills.
 * @param {(item: object) => string} [opts.getUserId] - the item's assignee uid ('' when none).
 * @param {(item: object) => string} [opts.getUserName] - fallback (denormalised) assignee name.
 * @param {(item: object) => {text?: string, weight?: number}[]} [opts.getMatchFields]
 * @param {(item: object) => {value?: string, kind: string}[]} [opts.getSuggestionSources]
 */

// Stable default so a caller that passes nothing does not hand the memo below a fresh [] each render.
const EMPTY_EXTRA = [];

/** Default assignee reader for a task-shaped row. '' (not 'unknown') means "no assignee". */
export const getItemAssigneeId = (item) => {
    const id = resolveUserId(item);
    return id === 'unknown' ? '' : id;
};

/** Default denormalised-name reader for a task-shaped row. */
export const getItemAssigneeName = (item) => item?.assignedUserName || '';

/**
 * PURE: the distinct people present in `items`, as `FilterPills` options ordered by display name.
 * Names resolve from the live roster first (so a renamed worker reads correctly) and fall back to
 * the name denormalised onto the row.
 *
 * `extraAssignees` ([{ id, name }]) adds people who belong on the pill row but are not in `items` —
 * used where ONE control governs a second list the hook cannot see (Istorija: the pills must also
 * cover the archive below, or filtering by someone whose only rows are archived is impossible).
 */
export function buildAssigneeOptions(items, {
    users = [],
    getUserId = getItemAssigneeId,
    getUserName = getItemAssigneeName,
    extraAssignees = [],
} = {}) {
    const nameById = new Map((users || []).map((u) => [u.id, u.displayName || u.email || '']));
    const seen = new Map();
    for (const item of items || []) {
        const id = getUserId(item);
        if (!id || seen.has(id)) continue;
        const fullName = nameById.get(id) || getUserName(item) || '';
        seen.set(id, formatDisplayName(fullName) || '—');
    }
    for (const person of extraAssignees || []) {
        const id = person?.id;
        if (!id || seen.has(id)) continue;
        seen.set(id, formatDisplayName(nameById.get(id) || person.name || '') || '—');
    }
    return [...seen.entries()]
        .map(([value, label]) => ({ value, label, userId: value }))
        .sort((a, b) => a.label.localeCompare(b.label, 'lt'));
}

/**
 * PURE: narrow `items` to one person, then rank what remains by free-text relevance. The person
 * filter runs FIRST so the search only ever ranks rows the manager already chose to look at.
 * With no query the caller's incoming order is preserved untouched.
 */
export function applyListSearchFilter(items, {
    filterUser = '',
    query = '',
    getUserId = getItemAssigneeId,
    getMatchFields = getTaskMatchFields,
} = {}) {
    const list = filterUser ? (items || []).filter((i) => getUserId(i) === filterUser) : (items || []);
    if (!query.trim()) return list;
    return filterRankTasks(list, query, getMatchFields);
}

export function useListSearchFilter(items, {
    users = [],
    getUserId = getItemAssigneeId,
    getUserName = getItemAssigneeName,
    getMatchFields = getTaskMatchFields,
    getSuggestionSources = getTaskSuggestionSources,
    extraAssignees = EMPTY_EXTRA,
} = {}) {
    const [filterUser, setFilterUser] = useState('');
    const [searchText, setSearchText] = useState('');

    // Debounced exactly like the team list (200 ms): the suggestion dropdown follows every
    // keystroke, the heavier re-rank of the list below does not.
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useEffect(() => {
        const handle = setTimeout(() => setDebouncedSearch(searchText), 200);
        return () => clearTimeout(handle);
    }, [searchText]);

    const assigneeOptions = useMemo(
        () => buildAssigneeOptions(items, { users, getUserId, getUserName, extraAssignees }),
        [items, users, getUserId, getUserName, extraAssignees]
    );

    // Self-heal an orphaned pick: once the selected person has no row left here (accepted, moved
    // tab, reassigned), fall back to "Visi" rather than showing an empty list behind a filter the
    // manager can no longer see.
    useEffect(() => {
        if (filterUser && !assigneeOptions.some((o) => o.value === filterUser)) setFilterUser('');
    }, [filterUser, assigneeOptions]);

    // The assignee's CURRENT name, appended to the caller's fields/sources, so searching a person
    // by name works even where the row carries no (or a stale) denormalised name. Duplicates are
    // harmless: scoring takes the best field per token and suggestions dedupe by kind+value.
    const nameById = useMemo(
        () => new Map((users || []).map((u) => [u.id, u.displayName || u.email || ''])),
        [users]
    );
    const resolveName = useCallback(
        (item) => nameById.get(getUserId(item)) || getUserName(item) || '',
        [nameById, getUserId, getUserName]
    );
    const matchFields = useCallback((item) => {
        const name = resolveName(item);
        const base = getMatchFields(item);
        return name ? [...base, { text: name, weight: 0.9 }] : base;
    }, [resolveName, getMatchFields]);
    const suggestionSources = useCallback((item) => {
        const name = resolveName(item);
        const base = getSuggestionSources(item);
        return name ? [...base, { value: name, kind: 'worker' }] : base;
    }, [resolveName, getSuggestionSources]);

    // Exposed so a surface that renders SEVERAL lists off one control (Pridavimas shows "today"
    // and "earlier" separately) filters them all through the same state.
    const apply = useCallback(
        (list) => applyListSearchFilter(list, { filterUser, query: debouncedSearch, getUserId, getMatchFields: matchFields }),
        [filterUser, debouncedSearch, getUserId, matchFields]
    );

    const filteredItems = useMemo(() => apply(items), [apply, items]);

    // Suggestions read from the person-scoped set (never the whole list), so the dropdown only
    // offers completions that can actually produce a result under the active pill.
    const searchSuggestions = useMemo(() => {
        if (!searchText.trim()) return [];
        const scoped = filterUser ? (items || []).filter((i) => getUserId(i) === filterUser) : (items || []);
        return buildTaskSuggestions(scoped, searchText, suggestionSources);
    }, [items, searchText, filterUser, getUserId, suggestionSources]);

    return {
        filterUser,
        setFilterUser,
        assigneeOptions,
        searchText,
        setSearchText,
        searchSuggestions,
        filteredItems,
        apply,
        isNarrowed: !!filterUser || debouncedSearch.trim() !== '',
    };
}
