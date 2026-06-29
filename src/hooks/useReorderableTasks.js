import { useEffect, useMemo, useRef, useState } from 'react';
import {
    MouseSensor,
    TouchSensor,
    KeyboardSensor,
    useSensor,
    useSensors,
    closestCenter,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useAuth } from '../context/AuthContext';
import { resolveReorderDrop } from '../utils/reorderDrop';
import { persistColumnOrder, moveTaskToColumn } from '../utils/boardOrder';
import { logError } from '../utils/errorLog';

/**
 * useReorderableTasks — the SHARED drag-to-reorder engine for a FLAT canonical task list (the mobile
 * card list and the desktop team table). It is the priority board's logic projected onto one axis:
 * a canonical list is already the four priority columns stacked top-to-bottom, so dragging WITHIN a
 * priority group reorders it (a shared `boardRank`), and dragging ACROSS a priority boundary
 * REPRIORITIZES the task to the group it landed in (the same audited move the board does between
 * columns). Both go through utils/boardOrder, so there is still ONE manual order app-wide — the list
 * and the board write and read the exact same arrangement through compareTasksCanonical.
 *
 * It lives behind a lazy boundary (its only importers are the lazy reorder components) so @dnd-kit's
 * weight never enters the worker bundle or the default eager path — the same reason the board is
 * lazy-loaded.
 *
 * Activation is input-aware: a MOUSE drags from a small distance (desktop handle), a TOUCH needs a
 * short press-and-hold (long-press) so a normal swipe still scrolls the list, and the KEYBOARD drives
 * it from the focusable handle (Space to pick up, arrows to move).
 *
 * @param {Array}  tasks               - the visible, already-canonically-sorted task list
 * @param {Object} opts
 * @param {boolean} opts.enabled       - when false the hook is inert (items === tasks, nothing draggable)
 */

// A finished / accepted / deleted task can't carry a meaningful manual rank — it sinks to the bottom
// by the canonical comparator regardless — so it is never draggable (dragging it would just snap back).
const isDraggableTask = (t) =>
    !!t &&
    !t.completed &&
    !t.isDeleted &&
    t.status !== 'deleted' &&
    t.status !== 'completed' &&
    t.status !== 'confirmed';

export default function useReorderableTasks(tasks, { enabled = true } = {}) {
    const { currentUser, userRole } = useAuth();

    const tasksById = useMemo(() => {
        const map = {};
        for (const t of tasks || []) map[t.id] = t;
        return map;
    }, [tasks]);

    const baseIds = useMemo(() => (tasks || []).map((t) => t.id), [tasks]);
    const baseSignature = baseIds.join(',');

    // Local, drag-mutable order. Re-synced from props whenever the underlying set/order changes and no
    // drag is in flight, so a Firestore snapshot can't yank a card out from under the finger mid-drag.
    const [order, setOrder] = useState(baseIds);
    const [activeId, setActiveId] = useState(null);
    const [error, setError] = useState('');

    const orderRef = useRef(order);
    orderRef.current = order;

    useEffect(() => {
        if (activeId) return; // never re-sync mid-drag
        setOrder(baseIds);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [baseSignature, activeId]);

    const sensors = useSensors(
        // Mouse: a small movement threshold so a plain click on the handle still reads as a click.
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        // Touch: press-and-hold to pick up. With delay-based activation we deliberately do NOT set
        // touch-action:none on the card, so an immediate swipe (move beyond `tolerance` before the
        // delay elapses) still scrolls the list; only a stationary hold starts a drag.
        useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    // The tasks to render, in the optimistic local order (freshest task objects from props, reordered).
    const items = useMemo(() => {
        if (!enabled) return tasks || [];
        const seen = new Set();
        const arr = [];
        for (const id of order) {
            if (tasksById[id]) {
                arr.push(tasksById[id]);
                seen.add(id);
            }
        }
        // Append any id present in props but not yet in the local order (e.g. a task added between a
        // drag and the next re-sync) so nothing ever disappears from view.
        for (const t of tasks || []) if (!seen.has(t.id)) arr.push(t);
        return arr;
    }, [enabled, order, tasksById, tasks]);

    const itemIds = useMemo(() => items.map((t) => t.id), [items]);

    const onDragStart = ({ active }) => {
        setError('');
        setActiveId(active.id);
    };

    const onDragCancel = () => {
        setActiveId(null);
        setOrder(baseIds);
    };

    const onDragEnd = ({ active, over }) => {
        setActiveId(null);
        if (!over || active.id === over.id) return;

        const current = orderRef.current;
        const from = current.indexOf(active.id);
        const to = current.indexOf(over.id);
        if (from === -1 || to === -1) return;

        const newOrder = arrayMove(current, from, to);
        setOrder(newOrder);

        // Pure resolution of the drop (neighbour-inferred target priority + the target group's new
        // order); unit-tested in utils/reorderDrop.test.js.
        const resolution = resolveReorderDrop({ newOrder, draggedId: active.id, tasksById });
        if (!resolution) return;
        const { targetPriority, groupTasks, isReprioritize } = resolution;

        const revert = (err) => {
            logError(err, { source: 'useReorderableTasks.persist' });
            setError('Nepavyko išsaugoti naujos tvarkos. Atstatyta ankstesnė.');
            setOrder(baseIds); // back to the last confirmed snapshot
        };

        if (!isReprioritize) {
            // Reorder within the same priority — only `boardRank` changes (a no-op write if the rank
            // sequence is unchanged, so a drag that lands back in place costs nothing).
            persistColumnOrder(groupTasks).catch(revert);
        } else {
            // Crossed a priority boundary — an AUDITED reprioritize plus the new rank, identical to
            // dragging between the board's columns.
            moveTaskToColumn(tasksById[active.id], targetPriority, groupTasks, {
                uid: currentUser?.uid,
                displayName: currentUser?.displayName,
                email: currentUser?.email,
                role: userRole,
            }).catch(revert);
        }
    };

    return {
        enabled,
        sensors,
        collisionDetection: closestCenter,
        items,
        itemIds,
        activeId,
        activeTask: activeId ? tasksById[activeId] : null,
        isDraggableTask,
        onDragStart,
        onDragEnd,
        onDragCancel,
        error,
        clearError: () => setError(''),
    };
}
