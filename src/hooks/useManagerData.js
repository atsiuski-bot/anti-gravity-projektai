import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, orderBy, doc, getDoc, setDoc } from 'firebase/firestore';
import { useUsers } from '../context/UsersContext';

export const useManagerData = (currentUser) => {
    const { users: usersList, usersMap, loading: usersLoading } = useUsers();
    const [tasks, setTasks] = useState([]);
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
            const q = query(collection(db, 'tasks'), orderBy('createdAt', 'desc'));
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
                console.error("Error fetching tasks:", err);
                setError("Nepavyko užkrauti užduočių. Patikrinkite teises arba bandykite vėliau.");
                setLoading(false);
            });
        } catch (err) {
            console.error("Error setting up tasks listener:", err);
            setError("Įvyko klaida. Bandykite perkrauti puslapį.");
            setLoading(false);
        }

        return () => unsubscribe();
    }, [usersLoading, usersMap]);

    // Filter out disabled users for the UI
    const users = usersList.filter(u => !u.isDisabled);

    return { tasks, users, allUsers: usersList, manualTaskOrder, saveManualOrder, error, loading };
};
