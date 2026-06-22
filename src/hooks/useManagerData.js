import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, orderBy, where, doc, getDoc, setDoc } from 'firebase/firestore';
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
    const [tasks, setTasks] = useState([]);
    const [ownTasks, setOwnTasks] = useState([]);
    const [manualTaskOrder, setManualTaskOrder] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    // Fetch manual task order
    useEffect(() => {
        if (!currentUser) return;
        const fetchSettings = async () => {
            try {
                const docRef = doc(db, 'user_settings', currentUser.uid);
                const docSnap = await getDoc(docRef);
                if (docSnap.exists() && docSnap.data().manualTaskOrder) {
                    setManualTaskOrder(docSnap.data().manualTaskOrder);
                }
            } catch (err) {
                console.error("Error fetching user settings:", err);
            }
        };
        fetchSettings();
    }, [currentUser]);

    const saveManualOrder = async (newOrder) => {
        setManualTaskOrder(newOrder);
        if (!currentUser) return;
        try {
            await setDoc(doc(db, 'user_settings', currentUser.uid), {
                manualTaskOrder: newOrder
            }, { merge: true });
        } catch (err) {
            console.error("Error saving manual order:", err);
        }
    };

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
                let tasksData = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));

                // Enrich tasks with worker names and colors
                tasksData = tasksData.map(task => ({
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
                }));

                setTasks(tasksData);
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
    }, [usersLoading, usersMap, scoped, uid]);

    // The manager's OWN tasks (the "Mano" section). A scoped manager's team listener above is
    // array-contains(me), which by design does NOT include the manager's own rows (those carry
    // the manager's OWN managers, not themselves) — so my-tasks needs its own owner-scoped query.
    // Run it for everyone (cheap, and keeps my-tasks identical across scoped/unscoped managers).
    useEffect(() => {
        if (!uid) return;
        const q = query(collection(db, 'tasks'), where('assignedUserId', '==', uid));
        const unsub = onSnapshot(q, (snapshot) => {
            setOwnTasks(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
        }, (err) => {
            logError(err, { source: 'onSnapshot:managerOwnTasks' });
        });
        return () => unsub();
    }, [uid]);

    // Filter out disabled users for the UI
    const users = usersList.filter(u => !u.isDisabled);

    return { tasks, ownTasks, users, allUsers: usersList, manualTaskOrder, saveManualOrder, error, loading };
};
