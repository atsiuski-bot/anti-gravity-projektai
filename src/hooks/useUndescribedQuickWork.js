import { useEffect, useState } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { logError } from '../utils/errorLog';

/**
 * Does this task belong in the "describe your quick work" prompt?
 *
 * `autoStopped` ALONE IS NOT ENOUGH — and getting this wrong destroys data. Two unrelated server
 * paths write `autoStopped: true` onto a task:
 *   1. the quick-work closers (utils/sessionActions.js + the `autoCloseForgottenSessions` half of
 *      functions/index.js), which create a NEW placeholder task and always stamp `isQuickWork: true`;
 *   2. `autoStopForgottenTimers` (functions/index.js), which UPDATES an ordinary, manager-authored
 *      task whose timer ran past the 16 h cutoff — it never sets `isQuickWork`.
 *
 * Without the `isQuickWork` discriminator, case 2 surfaced in the worker's prompt: answering it
 * called addQuickWorkDescription, which rewrites `title` and `description` on the durable task
 * record. A worker who simply forgot to stop a timer was invited to "describe" a real task and
 * silently renamed it — no history, no undo, and the manager saw their task turn into a sentence.
 *
 * The check is deliberately a POSITIVE match on `isQuickWork` rather than an exclusion of case 2's
 * `autoStopReason`, because the failure modes are asymmetric: excluding a genuine quick-work entry
 * only costs the worker a retroactive rename (visible, recoverable), whereas admitting an ordinary
 * task destroys a manager's data (invisible, unrecoverable). Fail closed.
 *
 * @param {Object} task
 * @returns {boolean}
 */
export const isUndescribedQuickWork = (task) => (
    !!task
    && task.autoStopped === true
    && task.isQuickWork === true
    && !task.isDeleted
    && task.status !== 'deleted'
);

/**
 * Subscribe to the current user's auto-stopped quick-work tasks that still need a description.
 *
 * A quick-work session ended remotely is logged with a generic title and `autoStopped: true`,
 * because the worker never saw the naming prompt on this device (see addQuickWorkDescription).
 * This surfaces those records so they can be described retroactively.
 *
 * Scope follows the product decision "until archived": we read the live `tasks` collection
 * only, so an entry drops out both when it is described (autoStopped → false) and when the
 * nightly automation archives it. Queried by assignedUserId alone — the same single-field
 * index WorkerView already relies on — and filtered client-side, so there is no composite
 * index to provision.
 *
 * @param {{ uid: string } | null} currentUser
 * @returns {Array<Object>} undescribed auto-stopped quick-work tasks, newest first
 */
export function useUndescribedQuickWork(currentUser) {
    const [items, setItems] = useState([]);

    useEffect(() => {
        if (!currentUser?.uid) {
            setItems([]);
            return undefined;
        }

        const q = query(
            collection(db, 'tasks'),
            where('assignedUserId', '==', currentUser.uid)
        );

        const unsubscribe = onSnapshot(
            q,
            (snapshot) => {
                const list = snapshot.docs
                    .map((d) => ({ id: d.id, ...d.data() }))
                    .filter(isUndescribedQuickWork)
                    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
                setItems(list);
            },
            (err) => {
                logError(err, { source: 'onSnapshot:undescribedQuickWork' });
            }
        );

        return () => unsubscribe();
    }, [currentUser?.uid]);

    return items;
}
