import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { useAuth } from './AuthContext';

const UsersContext = createContext();

export function useUsers() {
    return useContext(UsersContext);
}

export const UsersProvider = ({ children }) => {
    const { currentUser } = useAuth();
    const [users, setUsers] = useState([]);
    const [usersMap, setUsersMap] = useState({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // Only subscribe to users collection when authenticated
        if (!currentUser) {
            setUsers([]);
            setUsersMap({});
            setLoading(false);
            return;
        }

        setLoading(true);
        const unsubscribe = onSnapshot(
            collection(db, 'users'),
            (snapshot) => {
                const usersData = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));

                const map = {};
                usersData.forEach(user => {
                    map[user.id] = user;
                });

                setUsers(usersData);
                setUsersMap(map);
                setLoading(false);
            },
            (error) => {
                console.error("Error fetching users collection in UsersContext:", error);
                setLoading(false);
            }
        );

        return () => unsubscribe();
    }, [currentUser]);

    // Active (non-blocked) users — use these for dropdowns, selection lists, and creating new items.
    // Full `users`/`usersMap` remain available for historical lookups (archives, existing tasks, etc.)
    const activeUsers = useMemo(() => users.filter(u => !u.isDisabled), [users]);
    const activeUsersMap = useMemo(() => {
        const map = {};
        activeUsers.forEach(user => {
            map[user.id] = user;
        });
        return map;
    }, [activeUsers]);

    const value = {
        users,
        usersMap,
        activeUsers,
        activeUsersMap,
        loading
    };

    return (
        <UsersContext.Provider value={value}>
            {children}
        </UsersContext.Provider>
    );
};
