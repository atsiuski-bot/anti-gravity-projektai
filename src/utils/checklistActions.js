import { doc, updateDoc, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * Checklist (sub-task) mutations.
 *
 * A task's checklist is an array of plain objects stored on the task document
 * itself (mirroring the existing `comments[]` / `links[]` pattern), NOT a
 * subcollection. Rationale: a handful of items per task makes the read free
 * (it rides along with the task snapshot), the write a single `updateDoc`, and
 * the Firestore rule trivial — the assigned worker may already update their own
 * task (firestore.rules tasks UPDATE) as long as it does not flip the
 * manager-only approval fields, and a checklist mutation never does. So workers
 * can tick items with no rules change.
 *
 * Every mutation rewrites the whole `checklist` array and bumps `updatedAt` so
 * the live snapshot (and the TaskCard memo, which compares `updatedAt`) refreshes.
 *
 * Items are keyed by a stable `id` (not array index) so a concurrent add/remove
 * cannot make a toggle hit the wrong row.
 *
 * Item shape: { id, text, done, doneBy, doneByName, doneAt, createdAt }.
 */

/** Generate a collision-resistant id for a new checklist item. */
export const makeChecklistItemId = () =>
    `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

/**
 * Build a fresh, unchecked checklist item from free text. Used by the in-modal
 * "add" flow and by TaskModal's authoring section so both produce the same shape.
 */
export const buildChecklistItem = (text) => ({
    id: makeChecklistItemId(),
    text: text.trim(),
    done: false,
    doneBy: null,
    doneByName: null,
    doneAt: null,
    createdAt: new Date().toISOString()
});

/**
 * Append a new item to a task's checklist.
 * @param {string} taskId
 * @param {string} text
 * @param {Array} currentChecklist - the live checklist from the task snapshot
 * @param {string} collectionName - 'tasks' (default) or 'archived_tasks'
 */
export const addChecklistItem = async (taskId, text, currentChecklist = [], collectionName = 'tasks') => {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    try {
        const next = [...(currentChecklist || []), buildChecklistItem(trimmed)];
        await updateDoc(doc(db, collectionName, taskId), {
            checklist: next,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('Error adding checklist item:', err);
        throw err;
    }
};

/**
 * Flip an item's done state. Marking done stamps who/when; un-marking clears it.
 * @param {string} taskId
 * @param {string} itemId
 * @param {Object} currentUser - { uid, displayName, email }
 * @param {Array} currentChecklist
 * @param {string} collectionName
 */
export const toggleChecklistItem = async (taskId, itemId, currentUser, currentChecklist = [], collectionName = 'tasks') => {
    if (!currentChecklist || currentChecklist.length === 0) return;
    try {
        const next = currentChecklist.map((item) => {
            if (item.id !== itemId) return item;
            const nowDone = !item.done;
            return {
                ...item,
                done: nowDone,
                doneBy: nowDone ? (currentUser?.uid || null) : null,
                doneByName: nowDone ? (currentUser?.displayName || currentUser?.email || null) : null,
                doneAt: nowDone ? new Date().toISOString() : null
            };
        });
        await updateDoc(doc(db, collectionName, taskId), {
            checklist: next,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('Error toggling checklist item:', err);
        throw err;
    }
};

/**
 * Rename an item, preserving its done state.
 */
export const updateChecklistItem = async (taskId, itemId, newText, currentChecklist = [], collectionName = 'tasks') => {
    const trimmed = (newText || '').trim();
    if (!trimmed || !currentChecklist) return;
    try {
        const next = currentChecklist.map((item) =>
            item.id === itemId ? { ...item, text: trimmed } : item
        );
        await updateDoc(doc(db, collectionName, taskId), {
            checklist: next,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('Error updating checklist item:', err);
        throw err;
    }
};

/**
 * Remove an item by id.
 */
export const deleteChecklistItem = async (taskId, itemId, currentChecklist = [], collectionName = 'tasks') => {
    if (!currentChecklist) return;
    try {
        const next = currentChecklist.filter((item) => item.id !== itemId);
        await updateDoc(doc(db, collectionName, taskId), {
            checklist: next,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('Error deleting checklist item:', err);
        throw err;
    }
};

/**
 * Persist a manager-authored checklist from TaskModal WITHOUT clobbering a worker's
 * concurrent live ticks. TaskModal saves the whole task document from a snapshot taken
 * when the modal opened, so a naive write of its `checklist` would overwrite any item a
 * worker checked (or added) from the card meanwhile.
 *
 * This runs a transaction and performs a three-way merge keyed by item id:
 *   - baselineIds  = the item ids present when the modal opened (the frozen `task` prop),
 *   - authored     = the manager's edited list at save (renames, additions, deletions),
 *   - live         = the current document (the worker's done-state + any item they added).
 *
 * Result:
 *   - the manager's set/order/text wins for items they kept or added,
 *   - each surviving item's done-state is taken from the LIVE doc (worker owns ticking),
 *   - items the manager deleted (in baseline, absent from authored) are dropped,
 *   - items the worker added concurrently (in live, not in baseline, not in authored) are kept.
 *
 * @param {string} taskId
 * @param {string[]} baselineIds - ids present when the modal opened
 * @param {Array} authoredChecklist - the manager's checklist at save time
 * @param {string} collectionName
 */
export const reconcileChecklist = async (taskId, baselineIds = [], authoredChecklist = [], collectionName = 'tasks') => {
    const baselineSet = new Set(baselineIds);
    const authoredSet = new Set((authoredChecklist || []).map((i) => i.id));

    try {
        await runTransaction(db, async (tx) => {
            const ref = doc(db, collectionName, taskId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return;

            const liveItems = Array.isArray(snap.data().checklist) ? snap.data().checklist : [];
            const liveById = new Map(liveItems.map((i) => [i.id, i]));

            // Manager's items, but each item's done-state taken from the live doc.
            const merged = (authoredChecklist || []).map((item) => {
                const liveItem = liveById.get(item.id);
                if (!liveItem) return item; // newly authored by the manager
                return {
                    ...item,
                    done: !!liveItem.done,
                    doneBy: liveItem.doneBy ?? null,
                    doneByName: liveItem.doneByName ?? null,
                    doneAt: liveItem.doneAt ?? null
                };
            });

            // Items the worker added from the card while the modal was open (the manager
            // never saw them, so they are not a deletion) — append, preserving their state.
            const concurrentlyAdded = liveItems.filter(
                (li) => !baselineSet.has(li.id) && !authoredSet.has(li.id)
            );

            tx.update(ref, {
                checklist: [...merged, ...concurrentlyAdded],
                updatedAt: new Date().toISOString()
            });
        });
    } catch (err) {
        console.error('Error reconciling checklist:', err);
        throw err;
    }
};

/**
 * Progress summary for badges/indicators: { total, done, allDone }.
 */
export const getChecklistProgress = (checklist) => {
    const items = Array.isArray(checklist) ? checklist : [];
    const total = items.length;
    const done = items.filter((i) => i && i.done).length;
    return { total, done, allDone: total > 0 && done === total };
};
