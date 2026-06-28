import { normalizePriority } from './priority';

/**
 * resolveReorderDrop — the PURE core of a flat-list drag-to-reorder drop (extracted from
 * useReorderableTasks so it can be unit-tested without React or @dnd-kit).
 *
 * A canonical team list is the four priority columns stacked top-to-bottom. After a card is dragged
 * to its drop slot, this decides which priority group it now belongs to — by its nearest NON-dragged
 * neighbour (the predecessor names the block it landed in; the successor is the fallback when it
 * landed at the very top) — and returns that group's full new order (the dragged card counted under
 * its new priority). It does no I/O; the caller persists `groupTasks` via utils/boardOrder, choosing
 * a same-priority reorder vs. an audited cross-priority reprioritize from `isReprioritize`.
 *
 * @param {Object}   p
 * @param {string[]} p.newOrder   - all VISIBLE task ids in their NEW order (the dragged id already moved)
 * @param {string}   p.draggedId  - the id that was dragged
 * @param {Object}   p.tasksById  - id → task lookup (should include every id in newOrder)
 * @returns {{ sourcePriority: string, targetPriority: string, groupTasks: Object[], isReprioritize: boolean } | null}
 *   null when the drop can't be resolved (the dragged task is absent). `groupTasks` is the target
 *   priority column's ordered task array (including the dragged task at its dropped slot).
 */
export const resolveReorderDrop = ({ newOrder, draggedId, tasksById }) => {
    const ids = Array.isArray(newOrder) ? newOrder : [];
    const byId = tasksById || {};
    const draggedTask = byId[draggedId];
    if (!draggedTask) return null;

    const sourcePriority = normalizePriority(draggedTask.priority);

    // Infer the dropped priority from the nearest non-dragged neighbour: predecessor first (you
    // dropped the card INTO that block), else successor (dropped at the very top). In a canonical
    // list the groups are contiguous, so the neighbour above unambiguously names the new group.
    const idx = ids.indexOf(draggedId);
    let targetPriority = sourcePriority;
    const predId = idx > 0 ? ids[idx - 1] : null;
    const succId = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null;
    if (predId && byId[predId]) targetPriority = normalizePriority(byId[predId].priority);
    else if (succId && byId[succId]) targetPriority = normalizePriority(byId[succId].priority);

    // The target group's FULL new order (the dragged card counted under its NEW priority), in the
    // dropped sequence — exactly the shape boardOrder needs to rewrite ranks. Filtered against the
    // VISIBLE list, mirroring the board: a hidden same-priority task keeps its place by index.
    const groupTasks = ids
        .map((id) => byId[id])
        .filter(Boolean)
        .filter((t) => (t.id === draggedId ? targetPriority : normalizePriority(t.priority)) === targetPriority);

    return {
        sourcePriority,
        targetPriority,
        groupTasks,
        isReprioritize: targetPriority !== sourcePriority,
    };
};
