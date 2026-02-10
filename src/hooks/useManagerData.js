import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, orderBy, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';

export const useManagerData = (currentUser) => {
    const [tasks, setTasks] = useState([]);
    const [users, setUsers] = useState([]);
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

    // Fetch tasks and users
    useEffect(() => {
        let unsubscribe = () => { };
        setLoading(true);

        try {
            const q = query(collection(db, 'tasks'), orderBy('createdAt', 'desc'));
            unsubscribe = onSnapshot(q, async (snapshot) => {
                let tasksData = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));

                // Fetch worker names for assigned tasks
                try {
                    const usersSnapshot = await getDocs(collection(db, 'users'));
                    const usersMap = {};
                    const usersList = [];
                    usersSnapshot.docs.forEach(doc => {
                        const userData = { id: doc.id, ...doc.data() };
                        usersMap[doc.id] = userData;
                        if (!userData.isDisabled) {
                            usersList.push(userData);
                        }
                    });
                    setUsers(usersList);

                    // Enrich tasks with worker names and colors
                    tasksData = tasksData.map(task => ({
                        ...task,
                        assignedWorkerName: task.assignedWorkerId && usersMap[task.assignedWorkerId]
                            ? (usersMap[task.assignedWorkerId].displayName || usersMap[task.assignedWorkerId].email)
                            : null,
                        assignedWorkerColor: task.assignedWorkerId && usersMap[task.assignedWorkerId]
                            ? (usersMap[task.assignedWorkerId].color || null)
                            : null,
                        creatorName: task.creatorName || (task.createdBy && usersMap[task.createdBy]
                            ? (usersMap[task.createdBy].displayName || usersMap[task.createdBy].email)
                            : null)
                    }));
                } catch (err) {
                    console.error("Error fetching user names:", err);
                }

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
    }, []);

    return { tasks, users, manualTaskOrder, saveManualOrder, error, loading };
};
