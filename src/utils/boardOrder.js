import { doc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { PRIORITIES, normalizePriority } from './priority';
import { reprioritizeTask, humanActor, MODES } from '../domain';
import { logError } from './errorLog';

/**
 * boardOrder — the SHARED manual-ordering layer behind the desktop priority board.
 *
 * Two things are persisted from a drag:
 *  - which PRIORITY column a card sits in → the task's `priority` (an audited reprioritize), and
 *  - the card's place WITHIN that column → a per-task `boardRank` (a plain numeric field).
 *
 * `boardRank` is stored ON THE TASK (founder decision 2026-06-26), so the order is shared: every
 * surface — team list, worker list, mobile, desktop — reads the same arrangement through the
 * canonical comparator (compareTasksCanonical), where a present rank overrides the automatic
 * deadline → completion → createdAt fallback. Ranks are 0-based and only ever compared WITHIN a
 * priority, so reusing the same integers across columns is fine. No firestore.rules change is
 * needed: the tasks update rule is permissive (it validates only priority/estimate shape), so a
 * whole-team manager may write `boardRank` like any other task field.
 */

// Column order, left → right: most urgent first.
export const BOARD_COLUMNS = [
    PRIORITIES.URGENT,
    PRIORITIES.HIGH,
    PRIORITIES.MEDIUM,
    PRIORITIES.LOW,
];

/**
 * Group an already-canonically-sorted task array into the four priority buckets, preserving the
 * incoming order inside each bucket (so each column is already in canonical/manual order).
 */
export const groupTasksByPriority = (tasks) => {
    const buckets = { [PRIORITIES.URGENT]: [], [PRIORITIES.HIGH]: [], [PRIORITIES.MEDIUM]: [], [PRIORITIES.LOW]: [] };
    for (const task of tasks || []) {
        buckets[normalizePriority(task.priority)].push(task);
    }
    return buckets;
};

/**
 * Persist a column's order by writing sequential `boardRank` (0..n-1) to its tasks, in their new
 * visual order. Only tasks whose rank actually changes are written, so a repeated drag that doesn't
 * move much is cheap — but a column that was never arranged gets a rank on EVERY card the first time
 * (each previously-undefined rank differs from its index), which is exactly the "freeze the column"
 * behaviour: once touched, the whole column follows the manual order.
 */
export const persistColumnOrder = async (orderedTasks) => {
    const batch = writeBatch(db);
    let dirty = false;
    orderedTasks.forEach((task, index) => {
        if (task.boardRank !== index) {
            batch.update(doc(db, 'tasks', task.id), { boardRank: index });
            dirty = true;
        }
    });
    if (!dirty) return;
    try {
        await batch.commit();
    } catch (err) {
        logError(err, { source: 'boardOrder.persistColumnOrder' });
        throw err;
    }
};

/**
 * Move a card to a different priority column at a chosen position. The priority change is an
 * AUDITED reprioritize (humanActor commit — a manager dragging is a real triage decision, recorded
 * in the decision_log), after which the target column's `boardRank`s are rewritten to lock the drop
 * position. The source column keeps its ranks (a harmless gap where the card left).
 *
 * @param {Object} task                  - the dragged task (pre-move snapshot)
 * @param {string} targetPriority        - the destination column's priority token
 * @param {Array}  targetOrderedTasks    - the destination column's FULL new order, including `task`
 * @param {Object} actorIdentity         - { uid, displayName, email, role } of the dragging manager
 */
export const moveTaskToColumn = async (task, targetPriority, targetOrderedTasks, actorIdentity) => {
    const priority = normalizePriority(targetPriority);
    const actor = humanActor(actorIdentity);
    try {
        await reprioritizeTask(
            { task, priority },
            { actor, mode: MODES.COMMIT, reason: 'reprioritized by dragging on the priority board' }
        );
    } catch (err) {
        logError(err, { source: 'boardOrder.moveTaskToColumn.reprioritize' });
        throw err;
    }
    // Write the destination order. The moved task is treated as already carrying the new priority;
    // persistColumnOrder only touches `boardRank`, so its stale local `priority` is irrelevant here.
    await persistColumnOrder(targetOrderedTasks);
};
