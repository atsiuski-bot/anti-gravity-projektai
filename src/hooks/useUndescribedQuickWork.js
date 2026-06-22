import { useEffect, useState } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { logError } from '../utils/errorLog';

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
                    .filter((t) => t.autoStopped === true && !t.isDeleted && t.status !== 'deleted')
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
