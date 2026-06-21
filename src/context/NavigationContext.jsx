import React, { createContext, useContext, useState, useEffect } from 'react';
import { useSearchParams, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { isManagerRole } from '../utils/formatters';

const NavigationContext = createContext();

// eslint-disable-next-line react-refresh/only-export-components -- hook intentionally co-located with its provider; dev-HMR-only lint, no runtime impact.
export function useNavigation() {
    return useContext(NavigationContext);
}

export function NavigationProvider({ children }) {
    const { userRole } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const location = useLocation();
    // Seed from the URL so a reload or a shared link reopens the same tab.
    const [activeTab, setActiveTabState] = useState(() => searchParams.get('tab') || 'tasks');
    const scrollPositions = React.useRef({});
    const prevRoleRef = React.useRef(undefined);

    // Reset the tab on a genuine role change (account switch / re-login). On the FIRST role
    // resolution (undefined → a role) we honor a tab carried in the URL, so a deep link or a
    // reload isn't clobbered by the role's home tab the moment auth resolves.
    useEffect(() => {
        const roleDefault = isManagerRole(userRole) ? 'my-tasks' : 'tasks';
        const prevRole = prevRoleRef.current;
        prevRoleRef.current = userRole;

        if (prevRole === undefined) {
            if (!searchParams.get('tab')) {
                setActiveTabState(roleDefault);
            }
            return;
        }
        if (prevRole !== userRole) {
            setActiveTabState(roleDefault);
            scrollPositions.current = {};
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- run only on role change; the URL tab is read once at first resolution.
    }, [userRole]);

    // Mirror the active tab into ?tab= (replace, so each switch doesn't push a history entry).
    // Only on the app route — never decorate /login with a tab param.
    useEffect(() => {
        if (location.pathname !== '/') return;
        if (searchParams.get('tab') === activeTab) return;
        const next = new URLSearchParams(searchParams);
        next.set('tab', activeTab);
        setSearchParams(next, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mirror activeTab → URL; guarded by an equality check to avoid a loop.
    }, [activeTab, location.pathname]);

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
