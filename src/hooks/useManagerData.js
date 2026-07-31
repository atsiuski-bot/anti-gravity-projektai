import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, orderBy, where } from 'firebase/firestore';
import { useUsers } from '../context/UsersContext';
import { useAuth } from '../context/AuthContext';
import { isScopedOverseer } from '../utils/teamScope';
import { logError } from '../utils/errorLog';

export const useManagerData = (currentUser) => {
    const { users: usersList, usersMap, loading: usersLoading } = useUsers();
    const { userData } = useAuth();
    // A scoped manager only ever queries their team's tasks (array-contains on the denormalized
    // teamManagerIds); admins and unscoped managers keep the broad team-wide read.
    const scoped = isScopedOverseer(userData);
    const uid = currentUser?.uid;
    // Raw task docs, exactly as the listener delivered them. Name/colour enrichment happens in a
    // memo below, NOT inside the snapshot callback — see the subscription's dependency note.
    const [rawTasks, setRawTasks] = useState([]);
    const [ownTasks, setOwnTasks] = useState([]);
    // "Mano darbai" runs on its OWN owner-scoped listener below, so the broad `loading` flag says
    // nothing about it. Without a flag of its own, an empty ownTasks array reads as "no tasks
    // assigned" while it still means "not loaded", and a manager working their own task was told
    // "Jums dar nepriskirta jokių užduočių" on every reload. Latches ON only — never reset on a
    // re-arm, so a populated list can't flash back to a spinner.
    const [ownTasksLoaded, setOwnTasksLoaded] = useState(false);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    // Fetch tasks
    useEffect(() => {
        if (usersLoading) return; // Wait for users to load before mapping tasks

        let unsubscribe = () => { };
        setLoading(true);

        try {
            const scope = scoped && uid ? where('teamManagerIds', 'array-contains', uid) : null;
            const q = scope
                ? query(collection(db, 'tasks'), scope, orderBy('createdAt', 'desc'))
                : query(collection(db, 'tasks'), orderBy('createdAt', 'desc'));
            unsubscribe = onSnapshot(q, (snapshot) => {
                setRawTasks(snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                })));
                setError(null);
                setLoading(false);
            }, (err) => {
                logError(err, { source: 'onSnapshot:managerTasks' });
                setError("Nepavyko užkrauti užduočių. Patikrinkite teises arba bandykite vėliau.");
                setLoading(false);
            });
        } catch (err) {
            console.error("Error setting up tasks listener:", err);
            setError("Įvyko klaida. Bandykite perkrauti puslapį.");
            setLoading(false);
        }

        return () => unsubscribe();
        // usersMap is deliberately NOT a dependency. UsersContext rebuilds it as a brand-new object
        // inside its whole-collection onSnapshot, so its identity changes on EVERY write to ANY user
        // doc — and a running session heartbeats its user doc once a minute. Depending on it tore
        // down and re-created this broad tasks listener several times a minute per connected device;
        // Firestore bills the initial snapshot of each new listener, so a manager re-read the entire
        // tasks collection because an unrelated worker's timer ticked, and `loading` flipped back to
        // true each time (visible flicker). The names it supplies are applied in the memo below,
        // which is free to re-run on every users change.
    }, [usersLoading, scoped, uid]);

    // A scoped overseer's team listener is array-contains(me) on teamManagerIds, which by design
    // never matches their OWN rows (those carry the overseer's own managers). Left alone, a scoped
    // coordinator's own tasks were missing from the shared team list — visible only in "Mano
    // darbai" — while unscoped managers and admins saw theirs there all along. Fold the
    // owner-scoped rows back in (deduped by id; the broad listener wins on overlap) so the team
    // list means the same thing for every overseer.
    const mergedRawTasks = useMemo(() => {
        if (!scoped || ownTasks.length === 0) return rawTasks;
        const seen = new Set(rawTasks.map(t => t.id));
        const extra = ownTasks.filter(t => !seen.has(t.id));
        return extra.length === 0 ? rawTasks : [...rawTasks, ...extra];
    }, [scoped, rawTasks, ownTasks]);

    // Enrich tasks with worker names and colors. Pure derivation over the raw docs, so a users
    // change re-labels the list without touching the subscription.
    const tasks = useMemo(() => mergedRawTasks.map(task => ({
        ...task,
        assignedUserName: task.assignedUserId && usersMap[task.assignedUserId]
            ? (usersMap[task.assignedUserId].displayName || usersMap[task.assignedUserId].email)
            : null,
        assignedWorkerColor: task.assignedUserId && usersMap[task.assignedUserId]
            ? (usersMap[task.assignedUserId].color || null)
            : null,
        creatorName: task.creatorName || (task.createdBy && usersMap[task.createdBy]
            ? (usersMap[task.createdBy].displayName || usersMap[task.createdBy].email)
            : null)
    })), [mergedRawTasks, usersMap]);

    // The manager's OWN tasks (the "Mano" section). A scoped manager's team listener above is
    // array-contains(me), which by design does NOT include the manager's own rows (those carry
    // the manager's OWN managers, not themselves) — so my-tasks needs its own owner-scoped query.
    // Run it for everyone (cheap, and keeps my-tasks identical across scoped/unscoped managers).
    useEffect(() => {
        if (!uid) return;
        const q = query(collection(db, 'tasks'), where('assignedUserId', '==', uid));
        const unsub = onSnapshot(q, (snapshot) => {
            setOwnTasks(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
            setOwnTasksLoaded(true);
        }, (err) => {
            logError(err, { source: 'onSnapshot:managerOwnTasks' });
            // Stop waiting on a read that will not arrive — the empty state is then the truthful
            // thing to show, rather than a spinner that never resolves.
            setOwnTasksLoaded(true);
        });
        return () => unsub();
    }, [uid]);

    // Filter out disabled users for the UI
    const users = usersList.filter(u => !u.isDisabled);

    return { tasks, ownTasks, ownTasksLoaded, users, allUsers: usersList, error, loading };
};
