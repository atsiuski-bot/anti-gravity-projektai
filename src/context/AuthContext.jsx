import React, { createContext, useContext, useState, useEffect } from 'react';
import { auth, db } from '../firebase';
import {
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    setPersistence,
    browserSessionPersistence
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
        console.log("Auth: Starting Google Login...");
        const provider = new GoogleAuthProvider();
        try {
            // Use browserSessionPersistence for better compatibility in Incognito/restricted environments
            await setPersistence(auth, browserSessionPersistence);
            const result = await signInWithPopup(auth, provider);
            const user = result.user;
            console.log("Auth: Google Sign-In successful for:", user.email);

            // Check if user exists in Firestore
            console.log("Auth: Checking Firestore for user document...");
            const userRef = doc(db, 'users', user.uid);
            const userSnap = await getDoc(userRef);

            if (!userSnap.exists()) {
                console.log("Auth: Creating new user document in Firestore...");
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
                setUserRole('worker');
                setUserData(newUserData);
                console.log("Auth: New user document created.");
            } else {
                const data = userSnap.data();
                if (data.isDisabled) {
                    console.log("Auth: User is disabled. Logging out.");
                    await signOut(auth);
                    throw new Error("Jūsų paskyra yra užblokuota/ištrinta.");
                }

                const role = data.role;
                console.log("Auth: Existing user found with role:", role);
                setUserRole(role);
                setUserData(data);
            }
            setCurrentUser(user);
        } catch (error) {
            console.error("Auth: Login Error:", error.code, error.message);
            throw error;
        }
    }

    function logout() {
        return signOut(auth);
    }

    useEffect(() => {
        console.log("Auth: Initializing onAuthStateChanged...");
        let unsubscribeSnapshot = null;

        const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
            console.log("Auth: State changed, user:", user ? user.email : "none");

            if (user) {
                // Subscribe to User Document changes (Role + Break State + Disabled Status)
                const userRef = doc(db, 'users', user.uid);

                // We use onSnapshot to get real-time updates for role and break status
                unsubscribeSnapshot = onSnapshot(userRef, async (docSnap) => {
                    if (docSnap.exists()) {
                        const data = docSnap.data();

                        if (data.isDisabled) {
                            console.log("Auth: User became disabled. Logging out.");
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

                        console.log("Auth: User data updated", data.role);
                        setCurrentUser(user);
                        setLoading(false);
                    } else {
                        console.log("Auth: User document missing. Waiting for creation...");
                        // Document doesn't exist yet - this is normal during initial login
                        // The login() function will create it, so we just wait
                    }
                }, (error) => {
                    console.error("Auth: Snapshot error:", error);
                    setLoading(false);
                });

            } else {
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
