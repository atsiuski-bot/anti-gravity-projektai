import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext';

const NavigationContext = createContext();

export function useNavigation() {
    return useContext(NavigationContext);
}

export function NavigationProvider({ children }) {
    const { userRole } = useAuth();
    const [activeTab, setActiveTabState] = useState('tasks');
    const scrollPositions = React.useRef({});

    // Reset tab when role changes (e.g. login/logout)
    useEffect(() => {
        setActiveTabState('tasks');
        scrollPositions.current = {};
    }, [userRole]);

    const setActiveTab = (newTab) => {
        // Save current scroll position before switching
        scrollPositions.current[activeTab] = window.scrollY;
        setActiveTabState(newTab);
    };

    const value = {
        activeTab,
        setActiveTab,
        scrollPositions // Expose for restoration
    };

    return (
        <NavigationContext.Provider value={value}>
            {children}
        </NavigationContext.Provider>
    );
}
