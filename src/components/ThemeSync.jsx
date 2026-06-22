import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

/**
 * ThemeSync — the one-way bridge from the Firestore user doc to ThemeContext (ADR 0006).
 *
 * ThemeProvider sits above AuthProvider, so it cannot read auth state itself. This component
 * lives INSIDE the authed tree, where `userData` is available, and adopts the user's saved
 * `themePreference` whenever it arrives or changes on another device (the AuthContext snapshot
 * is real-time). It writes nothing back — ProfilePage owns the write path — so there is no echo
 * loop: when the local choice already matches, this is a no-op.
 *
 * Renders nothing.
 */
export default function ThemeSync() {
    const { userData } = useAuth();
    const { preference, setPreference } = useTheme();
    const remote = userData?.themePreference;

    useEffect(() => {
        if ((remote === 'system' || remote === 'light' || remote === 'dark') && remote !== preference) {
            setPreference(remote);
        }
    }, [remote, preference, setPreference]);

    return null;
}
