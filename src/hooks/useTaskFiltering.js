import { useState, useMemo, useEffect } from 'react';
import { getPriorityRank } from '../utils/priority';

import { getLithuanianNow, getLithuanian3AMCutoff, getLithuanianDateString } from '../utils/timeUtils';

export const useTaskFiltering = (tasks, manualTaskOrder) => {
    const [filterUser, setFilterUser] = useState('');
    const [filterPriority, setFilterPriority] = useState('');
    const [filterTag, setFilterTag] = useState('');
    const [sortBy, setSortBy] = useState('none');

    // Free-text search, debounced so the list doesn't re-filter on every keystroke. Matches
    // client-side over the already-loaded array (title, description, worker name, tag).
    const [searchText, setSearchText] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useEffect(() => {
        const handle = setTimeout(() => setDebouncedSearch(searchText), 200);
        return () => clearTimeout(handle);
    }, [searchText]);

    const sortedTasks = useMemo(() => {
        // Filter out completed, deleted, and unapproved tasks
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

        // Apply free-text search (case-insensitive) over the human-readable fields.
        const query = debouncedSearch.trim().toLowerCase();
        if (query) {
            activeTasks = activeTasks.filter(t =>
                [t.title, t.description, t.assignedUserName, t.tag]
                    .some(field => field && String(field).toLowerCase().includes(query))
            );
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
                    if (status === 'pending') return 2;
                    if (status === 'unapproved') return 3;
                    if (status === 'completed') return 4;
                    if (status === 'confirmed') return 5;
                    return 6;
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
    }, [tasks, sortBy, manualTaskOrder, filterUser, filterPriority, filterTag, debouncedSearch]);

    return {
        sortedTasks,
        filterUser,
        setFilterUser,
        filterPriority,
        setFilterPriority,
        filterTag,
        setFilterTag,
        searchText,
        setSearchText,
        sortBy,
        setSortBy
    };
};
