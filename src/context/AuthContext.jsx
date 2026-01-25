import React, { createContext, useContext, useState, useEffect } from 'react';
import { auth, db } from '../firebase';
import {
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    setPersistence,
    browserLocalPersistence
} from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';

const AuthContext = createContext();

export function useAuth() {
    return useContext(AuthContext);
}

export function AuthProvider({ children }) {
    const [currentUser, setCurrentUser] = useState(null);
    const [userData, setUserData] = useState(null); // Real-time Firestore data
    const [userRole, setUserRole] = useState(null);
    const [breakState, setBreakState] = useState(null);
    const [workStatus, setWorkStatus] = useState(null);
    const [loading, setLoading] = useState(true);

    async function login() {
        console.log("Auth: Starting Google Login with popup...");
        const provider = new GoogleAuthProvider();
        try {
            // Use browserLocalPersistence to allow session to persist across browser restarts for 4 days
            await setPersistence(auth, browserLocalPersistence);

            // Use popup - now safe because we are on HTTP (no COOP/SSL errors)
            const result = await signInWithPopup(auth, provider);
            const user = result.user;
            console.log("Auth: Google Sign-In successful for:", user.email);

            // Allow the onSnapshot listener to handle state updates
            // but we can check/create the document here to be safe
            await processUserAfterLogin(user);

        } catch (error) {
            console.error("Auth: Login Error:", error.code, error.message);
            if (error.code === 'auth/popup-blocked') {
                alert('Login popup was blocked. Please allow popups for this site.');
            } else if (error.code === 'auth/popup-closed-by-user') {
                console.log('Login cancelled by user');
            } else {
                throw error;
            }
        }
    }

    // Helper function to process user after successful login
    async function processUserAfterLogin(user) {


        // Set login timestamp for 4-day expiration
        localStorage.setItem('auth_login_timestamp', Date.now().toString());

        // Check if user exists in Firestore

        const userRef = doc(db, 'users', user.uid);
        const userSnap = await getDoc(userRef);

        if (!userSnap.exists()) {

            const newUserData = {
                email: user.email,
                displayName: user.displayName,
                photoURL: user.photoURL,
                role: 'worker',
                createdAt: new Date().toISOString(),
                isDisabled: false
            };
            // Create new user with default role 'worker'
            await setDoc(userRef, newUserData);

            // Don't set state here - let the onSnapshot listener handle it
        } else {
            const data = userSnap.data();
            if (data.isDisabled) {

                await signOut(auth);
                throw new Error("Jūsų paskyra yra užblokuota/ištrinta.");
            }


            // Don't set state here - let the onSnapshot listener handle it
        }
    }

    function logout() {
        localStorage.removeItem('auth_login_timestamp');
        return signOut(auth);
    }

    useEffect(() => {
        console.log("Auth: Initializing onAuthStateChanged...");
        let unsubscribeSnapshot = null;
        let expirationCheckInterval = null;

        const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {


            if (user) {
                // Check session expiration (4 days = 4 * 24 * 60 * 60 * 1000 ms)
                const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;
                let loginTimestamp = localStorage.getItem('auth_login_timestamp');

                if (!loginTimestamp) {
                    // If missing (migration or cleared), set it now to start the 4-day timer
                    loginTimestamp = Date.now().toString();
                    localStorage.setItem('auth_login_timestamp', loginTimestamp);
                }

                const checkExpiration = () => {
                    const now = Date.now();
                    if (now - parseInt(loginTimestamp) > FOUR_DAYS_MS) {

                        logout();
                    }
                };

                // Check immediately
                checkExpiration();

                // Check periodically (e.g., every minute)
                expirationCheckInterval = setInterval(checkExpiration, 60000);

                // Subscribe to User Document changes (Role + Break State + Disabled Status)
                const userRef = doc(db, 'users', user.uid);

                // We use onSnapshot to get real-time updates for role and break status
                unsubscribeSnapshot = onSnapshot(userRef, async (docSnap) => {
                    if (docSnap.exists()) {
                        const data = docSnap.data();

                        if (data.isDisabled) {

                            await signOut(auth);
                            setCurrentUser(null);
                            setUserRole(null);
                            setUserData(null);
                            window.location.reload();
                            return;
                        }

                        setUserRole(data.role || 'worker');
                        setBreakState(data.breakState || null);
                        setWorkStatus(data.workStatus || { isWorking: false });
                        setUserData(data); // Update full user data


                        setCurrentUser(user);
                        setLoading(false);
                    } else {

                        // Document doesn't exist - create it if not already processing redirect
                        if (!isProcessingRedirect) {
                            isProcessingRedirect = true;
                            try {
                                await processUserAfterLogin(user);
                            } catch (error) {
                                console.error("Auth: Error creating user document:", error);
                                setLoading(false);
                            } finally {
                                isProcessingRedirect = false;
                            }
                        }
                    }
                }, (error) => {
                    console.error("Auth: Snapshot error:", error);
                    setLoading(false);
                });

            } else {
                if (expirationCheckInterval) clearInterval(expirationCheckInterval);
                setCurrentUser(null);
                setUserRole(null);
                setBreakState(null);
                setWorkStatus(null);
                setUserData(null);
                setLoading(false);
            }
        });

        return () => {
            unsubscribeAuth();
            if (unsubscribeSnapshot) {
                unsubscribeSnapshot();
            }
            if (expirationCheckInterval) {
                clearInterval(expirationCheckInterval);
            }
        };
    }, []);

    const [showForceButton, setShowForceButton] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            if (loading) {
                setShowForceButton(true);
            }
        }, 8000); // Show button after 8 seconds
        return () => clearTimeout(timer);
    }, [loading]);

    const value = {
        currentUser,
        userData, // Exposed here
        userRole,
        login,
        logout,
        loading,
        breakState,
        isTakingBreak: breakState?.isTakingBreak || false,
        workStatus
    };

    return (
        <AuthContext.Provider value={value}>
            {loading ? (
                <div className="flex h-screen items-center justify-center bg-gray-50">
                    <div className="flex flex-col items-center gap-4 p-6 text-center">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
                        <div>
                            <p className="text-gray-700 font-medium">Initializing application...</p>
                            <p className="text-gray-500 text-sm mt-1">Connecting to authentication services</p>
                        </div>

                        {showForceButton && (
                            <div className="mt-6 animate-in fade-in duration-500">
                                <p className="text-red-500 text-sm mb-3">Connection is taking longer than expected.</p>
                                <button
                                    onClick={() => setLoading(false)}
                                    className="px-4 py-2 bg-white border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                                >
                                    Skip Loading (Debug Mode)
                                </button>
                                <p className="text-gray-400 text-xs mt-4">
                                    Check your internet connection or browser console for errors.
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                children
            )}
        </AuthContext.Provider>
    );
}
