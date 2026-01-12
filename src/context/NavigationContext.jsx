import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext';

const NavigationContext = createContext();

export function useNavigation() {
    return useContext(NavigationContext);
}

export function NavigationProvider({ children }) {
    const { userRole } = useAuth();
    const [activeTab, setActiveTab] = useState('tasks');

    // Reset tab when role changes (e.g. login/logout)
    useEffect(() => {
        setActiveTab('tasks');
    }, [userRole]);

    const value = {
        activeTab,
        setActiveTab
    };

    return (
        <NavigationContext.Provider value={value}>
            {children}
        </NavigationContext.Provider>
    );
}
