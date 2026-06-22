import { createContext, useContext, useState, useCallback } from 'react';
import UserProfileModal from '../components/UserProfileModal';

/**
 * ProfileViewer — a single app-wide overlay for viewing any member's read-only profile. Any
 * UserChip calls openProfile(uid); the modal renders once here at the provider root, so opening
 * a peer profile never depends on the tab system. Mounted inside the authenticated tree (below
 * UsersProvider, so the modal can resolve identity from the live users map).
 */
const ProfileViewerContext = createContext({ openProfile: () => {} });

// eslint-disable-next-line react-refresh/only-export-components -- hook co-located with its provider; dev-HMR-only lint.
export function useProfileViewer() {
    return useContext(ProfileViewerContext);
}

export function ProfileViewerProvider({ children }) {
    const [userId, setUserId] = useState(null);

    const openProfile = useCallback((id) => setUserId(id || null), []);
    const close = useCallback(() => setUserId(null), []);

    return (
        <ProfileViewerContext.Provider value={{ openProfile }}>
            {children}
            {userId && <UserProfileModal userId={userId} onClose={close} />}
        </ProfileViewerContext.Provider>
    );
}
