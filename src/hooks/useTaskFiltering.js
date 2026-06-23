import { useState, useMemo, useEffect } from 'react';
import { getPriorityRank } from '../utils/priority';
import {
    filterRankTasks,
    buildTaskSuggestions,
    getTaskMatchFields,
    getTaskSuggestionSources,
} from '../utils/taskSearch';

import { getLithuanianNow, getLithuanian3AMCutoff, getLithuanianDateString } from '../utils/timeUtils';

/**
 * scopeActiveTasks — the visible task set for "today's work day" after the structural filters
 * (user / priority / tag), but BEFORE free-text search and sort. Extracted so the list and the
 * search suggestions both read from the same scope (suggest only what is actually in view).
 */
export const scopeActiveTasks = (tasks, { filterUser, filterPriority, filterTag, filterStatus }) => {
    let activeTasks = tasks.filter(t => {
        // Definition of "Today's Work Day" (Starts at 3:00 AM Europe/Vilnius)
        const now = getLithuanianNow();
        let cutoffDate = getLithuanianDateString(now);

        // If it's before 3AM, the work day started at 3AM yesterday
        if (now.getHours() < 3) {
            const yesterday = new Date(now);
            yesterday.setDate(now.getDate() - 1);
            cutoffDate = getLithuanianDateString(yesterday);
        }

        const cutoff = getLithuanian3AMCutoff(cutoffDate);

        // Deleted tasks: show if deleted today (with strikethrough), hide otherwise
        if (t.isDeleted || t.status === 'deleted') {
            const deletedAt = t.deletedAt || t.completedAt || t.updatedAt;
            if (!deletedAt) return false;
            return new Date(deletedAt) >= cutoff;
        }

        const isDone = t.completed || t.status === 'completed' || t.status === 'confirmed';

        if (isDone) {
            // If the task is done, it should only show if it was finished TODAY (after 3AM)
            const finishedAt = t.completedAt || t.confirmedAt || t.updatedAt;
            if (!finishedAt) return false;

            const finishDate = new Date(finishedAt);
            return finishDate >= cutoff;
        }

        // Not done, so it's active
        return true;
    });

    // Apply user filter
    if (filterUser) {
        activeTasks = activeTasks.filter(t => t.assignedUserId === filterUser);
    }

    // Apply priority filter
    if (filterPriority) {
        activeTasks = activeTasks.filter(t => t.priority === filterPriority);
    }

    // Apply tag filter
    if (filterTag) {
        activeTasks = activeTasks.filter(t => t.tag === filterTag);
    }

    // Apply status filter — match the STORED lifecycle value (running/paused are timer-derived
    // overlays, not stored states), defaulting a missing status to 'pending'.
    if (filterStatus) {
        activeTasks = activeTasks.filter(t => (t.status || 'pending') === filterStatus);
    }

    return activeTasks;
};

/**
 * Primary ordering for the "sort by tag" (Žymos) column: groups rows by their tag value
 * alphabetically, with untagged rows last. Tie-breaking (priority then user) stays in the
 * caller so it can reuse the shared comparators. Exported for unit coverage.
 */
export const compareTaskTag = (a, b) => {
    const tagA = a.tag || '';
    const tagB = b.tag || '';
    if (!tagA && !tagB) return 0;
    if (!tagA) return 1;
    if (!tagB) return -1;
    return tagA.localeCompare(tagB);
};

export const useTaskFiltering = (tasks, manualTaskOrder) => {
    const [filterUser, setFilterUser] = useState('');
    const [filterPriority, setFilterPriority] = useState('');
    const [filterTag, setFilterTag] = useState('');
    const [filterStatus, setFilterStatus] = useState('');
    const [sortBy, setSortBy] = useState('none');

    // Free-text search, debounced so the list doesn't re-filter on every keystroke. Matches
    // client-side via the shared fuzzy core (diacritic-insensitive, typo-tolerant, ranked) —
    // see utils/taskSearch.js.
    const [searchText, setSearchText] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useEffect(() => {
        const handle = setTimeout(() => setDebouncedSearch(searchText), 200);
        return () => clearTimeout(handle);
    }, [searchText]);

    // Suggestions read from the in-scope set so the dropdown only offers titles / workers / tags
    // that are actually present under the current filters. Driven by the live searchText (not the
    // debounced one) so completions feel instant while the heavier list re-filter stays debounced.
    const searchSuggestions = useMemo(() => {
        if (!searchText.trim()) return [];
        const scoped = scopeActiveTasks(tasks, { filterUser, filterPriority, filterTag, filterStatus });
        return buildTaskSuggestions(scoped, searchText, getTaskSuggestionSources);
    }, [tasks, searchText, filterUser, filterPriority, filterTag, filterStatus]);

    const sortedTasks = useMemo(() => {
        let activeTasks = scopeActiveTasks(tasks, { filterUser, filterPriority, filterTag, filterStatus });

        // Apply fuzzy free-text search. When a query is present this returns the matches ordered
        // by relevance; that order is kept for the default 'none' sort and overridden by an
        // explicit sort choice below.
        if (debouncedSearch.trim()) {
            activeTasks = filterRankTasks(activeTasks, debouncedSearch, getTaskMatchFields);
        }

        if (sortBy === 'none') return activeTasks;

        const comparePriority = (a, b) => {
            const rankA = getPriorityRank(a.priority);
            const rankB = getPriorityRank(b.priority);
            return rankB - rankA; // Descending rank (Urgent > Low)
        };

        const sorted = [...activeTasks];

        const compareUser = (a, b) => {
            const nameA = a.assignedUserName || '';
            const nameB = b.assignedUserName || '';
            if (!nameA && !nameB) return 0;
            if (!nameA) return 1;
            if (!nameB) return -1;
            return nameA.localeCompare(nameB);
        };

        const compareDeadline = (a, b) => {
            const dateA = a.deadline || '9999-99-99'; // No deadline goes last
            const dateB = b.deadline || '9999-99-99';
            return dateA.localeCompare(dateB);
        };

        if (sortBy === 'priority') {
            sorted.sort((a, b) => {
                const prioDiff = comparePriority(a, b);
                if (prioDiff !== 0) return prioDiff;
                return compareUser(a, b);
            });
        } else if (sortBy === 'user') {
            sorted.sort((a, b) => {
                const userDiff = compareUser(a, b);
                if (userDiff !== 0) return userDiff;
                return comparePriority(a, b);
            });
        } else if (sortBy === 'deadline-user') {
            sorted.sort((a, b) => {
                const deadlineDiff = compareDeadline(a, b);
                if (deadlineDiff !== 0) return deadlineDiff;
                return compareUser(a, b);
            });
        } else if (sortBy === 'user-priority') {
            sorted.sort((a, b) => {
                const userDiff = compareUser(a, b);
                if (userDiff !== 0) return userDiff;
                return comparePriority(a, b);
            });
        } else if (sortBy === 'manual') {
            const orderMap = new Map(manualTaskOrder.map((id, index) => [id, index]));
            sorted.sort((a, b) => {
                const idxA = orderMap.has(a.id) ? orderMap.get(a.id) : 999999;
                const idxB = orderMap.has(b.id) ? orderMap.get(b.id) : 999999;

                if (idxA !== idxB) return idxA - idxB;
                return 0;
            });
        } else if (sortBy === 'status') {
            sorted.sort((a, b) => {
                const getStatusRank = (task) => {
                    const status = task.status || 'pending';
                    if (status === 'in-progress') return 1;
                    if (status === 'approved') return 2; // gate cleared, ready to start — near the top
                    if (status === 'pending') return 3;
                    if (status === 'unapproved') return 4;
                    if (status === 'completed') return 5;
                    if (status === 'confirmed') return 6;
                    return 7;
                };
                const rankA = getStatusRank(a);
                const rankB = getStatusRank(b);

                if (rankA !== rankB) return rankA - rankB;

                // Within same status, sort by priority
                const prioDiff = comparePriority(a, b);
                if (prioDiff !== 0) return prioDiff;

                // Then by user
                return compareUser(a, b);
            });
        } else if (sortBy === 'tag') {
            // Group rows by their tag (alphabetical, untagged last); within a tag fall back to
            // priority then user so the grouping stays readable.
            sorted.sort((a, b) => {
                const tagDiff = compareTaskTag(a, b);
                if (tagDiff !== 0) return tagDiff;
                const prioDiff = comparePriority(a, b);
                if (prioDiff !== 0) return prioDiff;
                return compareUser(a, b);
            });
        } else if (sortBy.startsWith('tag-')) {
            const tag = sortBy.replace('tag-', '');
            sorted.sort((a, b) => {
                const isTagA = a.tag === tag;
                const isTagB = b.tag === tag;
                if (isTagA && !isTagB) return -1;
                if (!isTagA && isTagB) return 1;

                const prioDiff = comparePriority(a, b);
                if (prioDiff !== 0) return prioDiff;

                return compareUser(a, b);
            });
        }

        return sorted;
    }, [tasks, sortBy, manualTaskOrder, filterUser, filterPriority, filterTag, filterStatus, debouncedSearch]);

    return {
        sortedTasks,
        filterUser,
        setFilterUser,
        filterPriority,
        setFilterPriority,
        filterTag,
        setFilterTag,
        filterStatus,
        setFilterStatus,
        searchText,
        setSearchText,
        searchSuggestions,
        sortBy,
        setSortBy
    };
};
