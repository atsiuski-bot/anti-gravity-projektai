import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { auth, db } from '../firebase';
import {
    GoogleAuthProvider,
    signInWithPopup,
    getRedirectResult,
    signOut,
    onAuthStateChanged
} from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { logError } from '../utils/errorLog';

const AuthContext = createContext();

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
    return useContext(AuthContext);
}

export function AuthProvider({ children }) {
    const [currentUser, setCurrentUser] = useState(null);
    const [userData, setUserData] = useState(null); // Real-time Firestore data
    const [optimisticUserData, setOptimisticUserData] = useState(null); // Instant UI feedback overriding userData
    const [userRole, setUserRole] = useState(null);
    const [breakState, setBreakState] = useState(null);
    const [workStatus, setWorkStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const isProcessingRedirect = useRef(false);
    const isProcessingAuth = useRef(false);

    // Helper function to detect Opera browser
    function isOperaBrowser() {
        return (
            (!!window.opr && !!window.opr.addons) ||
            !!window.opera ||
            navigator.userAgent.indexOf(' OPR/') >= 0
        );
    }

    async function login() {
        const isOpera = isOperaBrowser();
        console.log(`Auth: Starting Google Login with popup...`);
        const provider = new GoogleAuthProvider();
        try {
            // Use popup for all browsers (including Opera)
            // Note: Opera works fine with popup. Redirect requires Firebase Console configuration.
            if (isOpera) {
                console.log('Auth: Opera browser detected, using popup (works reliably)');
            }

            const result = await signInWithPopup(auth, provider);
            const user = result.user;
            console.log("Auth: Google Sign-In successful for:", user.email);

            // Allow the onSnapshot listener to handle state updates
            // but we can check/create the document here to be safe
            await processUserAfterLogin(user);

        } catch (error) {
            console.error("Auth: Login Error:", error.code, error.message);
            if (error.code === 'auth/popup-closed-by-user') {
                console.log('Login cancelled by user');
            } else {
                // Let the Login page map this to friendly Lithuanian copy (loginErrorMessage).
                // The previous window.alert was banned (§) and its English text bypassed that.
                throw error;
            }
        }
    }

    // Helper function to process user after successful login
    async function processUserAfterLogin(user) {

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
        return signOut(auth);
    }

    useEffect(() => {
        console.log("Auth: Initializing onAuthStateChanged...");
        let unsubscribeSnapshot = null;
        let expirationCheckInterval = null;

        // Handle redirect result (for Opera browser and mobile/fallback)
        getRedirectResult(auth)
            .then(async (result) => {
                if (result && !isProcessingAuth.current) {
                    isProcessingAuth.current = true;
                    try {
                        const user = result.user;
                        console.log("Auth: Redirect Sign-In successful for:", user.email);
                        await processUserAfterLogin(user);
                    } finally {
                        // Reset after a short delay to allow state updates
                        setTimeout(() => {
                            isProcessingAuth.current = false;
                        }, 1000);
                    }
                }
            })
            .catch((error) => {
                console.error("Auth: Redirect Login Error:", error.code, error.message);
                isProcessingAuth.current = false;
            });


        const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {


            if (user) {
                // Auto-logout 4 days after the last actual sign-in. We read Firebase's
                // own user.metadata.lastSignInTime instead of a localStorage timestamp,
                // so clearing localStorage can no longer reset the clock (the previous
                // logic re-seeded a missing timestamp to "now", a trivial fail-open).
                // NOTE: this is a UX convenience, not a hard security boundary - a
                // client-only app cannot truly enforce session lifetime; real revocation
                // is server-side (Firebase token revoke / disabling the account).
                const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;

                const checkExpiration = () => {
                    const lastSignIn = user.metadata?.lastSignInTime
                        ? new Date(user.metadata.lastSignInTime).getTime()
                        : null;
                    if (lastSignIn && Date.now() - lastSignIn > FOUR_DAYS_MS) {
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
                            console.log("Auth: User account is disabled, logging out...");
                            // Clear state first
                            setCurrentUser(null);
                            setUserRole(null);
                            setUserData(null);
                            setBreakState(null);
                            setWorkStatus(null);
                            setLoading(false);
                            // Then sign out (this will trigger onAuthStateChanged again)
                            await signOut(auth);
                            // Do NOT reload - let React Router handle navigation
                            return;
                        }

                        setUserRole(data.role || 'worker');
                        setBreakState(data.breakState || null);
                        setWorkStatus(data.workStatus || { isWorking: false });
                        setUserData(data); // Update full user data

                        // Only clear optimistic data when real data has caught up
                        setOptimisticUserData(prev => {
                            if (!prev) return null;

                            const optType = prev?.activeSession?.type;
                            const realType = data?.activeSession?.type;

                            if (optType) {
                                if (optType === 'task') {
                                    const optTid = prev?.workStatus?.activeTaskId;
                                    const realTid = data?.workStatus?.activeTaskId;
                                    if (realType === 'task' && data?.workStatus?.status === 'running' && realTid === optTid) {
                                        return null; // Match found, clear optimistic
                                    }
                                    return prev; // Still waiting for DB to catch up
                                }
                                if (realType === optType) return null; // Match found
                                return prev; // Still waiting
                            }

                            // If optimistic state expects no active session
                            if (prev?.activeSession === null) {
                                if (!data?.activeSession) return null; // DB finally cleared it
                                return prev; // DB still has it, keep waiting
                            }

                            return prev; // Catch-all: hold onto optimistic state until explicitly matched
                        });

                        setCurrentUser(user);
                        setLoading(false);
                    } else {

                        // Document doesn't exist - create it if not already processing redirect
                        if (!isProcessingRedirect.current) {
                            isProcessingRedirect.current = true;
                            try {
                                await processUserAfterLogin(user);
                            } catch (error) {
                                console.error("Auth: Error creating user document:", error);
                                setLoading(false);
                            } finally {
                                isProcessingRedirect.current = false;
                            }
                        }
                    }
                }, (error) => {
                    logError(error, { source: 'onSnapshot:authUser' });
                    // On permission-denied, the user document may not exist yet (first login).
                    // Retry creating it so the snapshot can re-attach successfully.
                    if (error.code === 'permission-denied' && !isProcessingRedirect.current) {
                        console.log("Auth: Permission denied on snapshot — retrying user doc creation...");
                        isProcessingRedirect.current = true;
                        processUserAfterLogin(user)
                            .catch(e => console.error("Auth: Retry failed:", e))
                            .finally(() => { isProcessingRedirect.current = false; });
                    }
                    setLoading(false);
                });

            } else {
                if (expirationCheckInterval) clearInterval(expirationCheckInterval);
                setCurrentUser(null);
                setUserRole(null);
                setBreakState(null);
                setWorkStatus(null);
                setUserData(null);
                setOptimisticUserData(null);
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

    const effectiveUserData = optimisticUserData || userData;

    const value = {
        currentUser,
        userData: effectiveUserData, // Exposed real-time or optimistic override
        setOptimisticUserData, // Function to trigger instant UI updates
        userRole,
        login,
        logout,
        loading,
        breakState: effectiveUserData?.breakState || breakState,
        isTakingBreak: effectiveUserData?.breakState?.isTakingBreak || false,
        workStatus: effectiveUserData?.workStatus || workStatus
    };

    return (
        <AuthContext.Provider value={value}>
            {loading ? (
                <div className="flex h-screen items-center justify-center bg-gray-50">
                    <div className="flex flex-col items-center gap-4 p-6 text-center">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
                        <div>
                            <p className="text-gray-700 font-medium">Paleidžiama programa…</p>
                            <p className="text-gray-500 text-sm mt-1">Jungiamasi prie autentifikacijos</p>
                        </div>

                        {showForceButton && (
                            <div className="mt-6 animate-in fade-in duration-500">
                                <p className="text-red-500 text-sm mb-3">Jungimasis užtrunka ilgiau nei įprastai.</p>
                                <button
                                    onClick={() => window.location.reload()}
                                    className="px-4 py-2 bg-white border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                                >
                                    Perkrauti puslapį
                                </button>
                                {/* Debug-only escape hatch: bypassing the auth-loading guard renders the
                                    protected tree before auth resolves, so it must never ship to users. */}
                                {import.meta.env.DEV && (
                                    <button
                                        onClick={() => setLoading(false)}
                                        className="ml-2 px-4 py-2 bg-white border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                                    >
                                        Skip Loading (Debug)
                                    </button>
                                )}
                                <p className="text-gray-400 text-xs mt-4">
                                    Patikrinkite interneto ryšį ir bandykite dar kartą.
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
