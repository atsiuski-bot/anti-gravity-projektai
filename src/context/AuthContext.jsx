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
import { removeFcmToken } from '../utils/messaging';
import { setAgentsEnabled } from '../domain/agentControl';
import { decideDisabledLogin } from '../utils/accountStatus';

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
    // While the popup/redirect login flow is provisioning OR evaluating an account, it OWNS the
    // sign-out decision. The user-doc onSnapshot below must NOT also sign out during this window.
    // Why this matters: provisioning a brand-new account calls setDoc({isDisabled:true}), which
    // updates Firestore's LOCAL cache optimistically and fires that listener BEFORE the server
    // ACKs the write. If the listener signs out then, it invalidates the auth token mid-write —
    // the pending-doc creation is rejected (permission-denied), nothing persists for an admin to
    // approve, and the real "pending approval" reason is masked by a generic error. (Same race
    // also broke the existing-disabled read: signOut beat getDoc, so the coded message was lost.)
    const isProvisioning = useRef(false);

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
        // Claim sign-out ownership for the entire evaluation so the user-doc onSnapshot defers to
        // us (see isProvisioning). Cleared in `finally` AFTER our own signOut completes, so the
        // listener can never sign out mid-write and reject the pending-doc creation.
        isProvisioning.current = true;
        try {
            // Check if user exists in Firestore
            const userRef = doc(db, 'users', user.uid);
            const userSnap = await getDoc(userRef);

            if (!userSnap.exists()) {

                // New accounts are provisioned in a PENDING (disabled) state — an admin must
                // approve them in User Management before they get any access. This replaces silent
                // auto-provisioning, where anyone who reached the URL became an active worker with
                // team-wide read access to tasks, sessions, calendars and the full roster. We sign
                // the user out and surface a clear "pending approval" message (mapped in Login).
                const newUserData = {
                    email: user.email,
                    displayName: user.displayName,
                    photoURL: user.photoURL,
                    role: 'worker',
                    createdAt: new Date().toISOString(),
                    isDisabled: true,
                    status: 'pending',
                    // Approval-free backdated time-logging is OFF by default — an admin grants it
                    // per-user in User Management (the flag is admin-only by firestore.rules).
                    canBackdateTime: false
                };
                // Must persist BEFORE we sign out — and it now can, because the onSnapshot
                // disabled-handler defers while isProvisioning is set (otherwise its signOut
                // would race this write and Firestore would reject it with permission-denied).
                await setDoc(userRef, newUserData);

                await signOut(auth);
                const pendingErr = new Error('Account pending approval');
                pendingErr.code = 'app/pending-approval';
                throw pendingErr;
            } else {
                const data = userSnap.data();
                if (data.isDisabled) {
                    // A DISABLED account that signs in again is re-surfaced for approval instead of
                    // hitting a silent dead end. Any account that is not already awaiting its first
                    // approval (a previously-blocked one, or a legacy doc with no status) is re-flagged
                    // to status:'pending' BEFORE we sign out, so it re-enters the admin's approval
                    // queue — the nav badge + the roster's "Laukia" band both key on
                    // isDisabled && status==='pending' — and can be re-approved. reapprovalRequestedAt
                    // marks it as a RETURNING request (vs a brand-new sign-up) for the copy/pill.
                    //
                    // The write is permitted by firestore.rules: this self-update touches only
                    // status/reapprovalRequestedAt and leaves role + isDisabled + every admin-only
                    // field unchanged (the users UPDATE rule pins those, not these), so the account
                    // gains NO access — it merely re-enters the queue. It MUST persist before signOut,
                    // or invalidating the token mid-write rejects it (the same race the pending-doc
                    // CREATE above avoids); the onSnapshot disabled-handler defers meanwhile
                    // (isProvisioning is still set).
                    const { reflagToPending, errorCode } = decideDisabledLogin(data);
                    if (reflagToPending) {
                        await setDoc(userRef, {
                            status: 'pending',
                            reapprovalRequestedAt: new Date().toISOString(),
                        }, { merge: true });
                    }

                    await signOut(auth);
                    // Coded reason (never a raw thrown string — §10) so Login shows the right message:
                    // a first-time sign-up awaiting approval vs a returning account awaiting re-approval.
                    const disabledErr = new Error('Account pending approval');
                    disabledErr.code = errorCode;
                    throw disabledErr;
                }


                // Don't set state here - let the onSnapshot listener handle it
            }
        } finally {
            isProvisioning.current = false;
        }
    }

    async function logout() {
        // Remove this device's push token BEFORE signing out — the owner-only fcm_tokens rule
        // needs the user still authenticated. Best-effort and time-boxed: never let a slow/hung
        // network call delay sign-out (a leftover token is pruned server-side on next send).
        try {
            await Promise.race([
                removeFcmToken(currentUser),
                new Promise((resolve) => setTimeout(resolve, 2000))
            ]);
        } catch {
            /* ignore — sign-out must always proceed */
        }
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
                        // Direct signOut (not logout()) — keeps this auth effect free of the
                        // logout dependency; token cleanup matters on explicit logout, and a
                        // token orphaned by rare auto-expiry is pruned server-side on next send.
                        signOut(auth);
                    }
                };

                // Check immediately
                checkExpiration();

                // Check periodically (e.g., every minute)
                expirationCheckInterval = setInterval(checkExpiration, 60000);

                // Subscribe to User Document changes (Role + Break State + Disabled Status).
                // Detach any listener left over from a previous auth identity first, so a
                // re-login never stacks a second listener on top of the old one.
                if (unsubscribeSnapshot) {
                    unsubscribeSnapshot();
                    unsubscribeSnapshot = null;
                }
                const userRef = doc(db, 'users', user.uid);

                // We use onSnapshot to get real-time updates for role and break status
                unsubscribeSnapshot = onSnapshot(userRef, async (docSnap) => {
                    if (docSnap.exists()) {
                        const data = docSnap.data();

                        if (data.isDisabled) {
                            // Defer to the login flow while it is provisioning/evaluating this
                            // account: signing out here would race its in-flight pending-doc write
                            // (this snapshot fires from the OPTIMISTIC local cache before the server
                            // ACK) and reject it. processUserAfterLogin signs out deliberately once
                            // the write has persisted, and onAuthStateChanged(null) then tears the
                            // session down — so nothing is leaked by waiting. This guard only skips
                            // the INITIAL-login window; an admin disabling a LIVE session still
                            // signs out normally (isProvisioning is false then).
                            if (isProvisioning.current) {
                                return;
                            }
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
                    // A permission-denied that arrives because the user just SIGNED OUT is expected
                    // teardown noise, not a first-login race: the listener outlives the auth session
                    // for a tick. Swallow it and bail — retrying processUserAfterLogin here against the
                    // now-stale user is what used to leave the logout half-finished and hang the page.
                    if (error.code === 'permission-denied' && !auth.currentUser) {
                        return;
                    }
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
                // Detach the user-document listener bound to the session that just ended. Leaving it
                // attached makes it fire a permission-denied the moment auth clears, and the stale
                // listener (still backed by the persistent cache) fights the cleared state — the race
                // that hung the page on logout.
                if (unsubscribeSnapshot) {
                    unsubscribeSnapshot();
                    unsubscribeSnapshot = null;
                }
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

    // Keep the agent kill-switch (ADR 0015) live for the command kernel while signed in: mirror
    // system_config/agents into the in-memory cache. A permission-denied (the rule not yet deployed)
    // is the EXPECTED pre-rollout state — swallow it so it never spams the crash log; the cache holds
    // its safe default (enabled), and no client path commits as an agent yet.
    useEffect(() => {
        if (!currentUser?.uid) {
            setAgentsEnabled(true);
            return undefined;
        }
        const unsub = onSnapshot(
            doc(db, 'system_config', 'agents'),
            (snap) => setAgentsEnabled(snap.exists() ? snap.data().enabled !== false : true),
            (err) => { if (err.code !== 'permission-denied') logError(err, { source: 'agentControl.subscribe' }); }
        );
        return () => unsub();
    }, [currentUser?.uid]);

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
                <div className="flex h-screen items-center justify-center bg-surface-base">
                    <div className="flex flex-col items-center gap-4 p-6 text-center">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand"></div>
                        <div>
                            <p className="text-ink font-medium">Paleidžiama programa…</p>
                            <p className="text-ink-muted text-body mt-1">Jungiamasi prie autentifikacijos</p>
                        </div>

                        {showForceButton && (
                            <div className="mt-6 animate-in fade-in">
                                <p className="text-feedback-danger text-body mb-3">Jungimasis užtrunka ilgiau nei įprastai.</p>
                                <button
                                    onClick={() => window.location.reload()}
                                    className="px-4 py-2 bg-surface-card border border-line rounded-control shadow-sm text-body font-medium text-ink hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-brand"
                                >
                                    Perkrauti puslapį
                                </button>
                                {/* Debug-only escape hatch: bypassing the auth-loading guard renders the
                                    protected tree before auth resolves, so it must never ship to users. */}
                                {import.meta.env.DEV && (
                                    <button
                                        onClick={() => setLoading(false)}
                                        className="ml-2 px-4 py-2 bg-surface-card border border-line rounded-control shadow-sm text-body font-medium text-ink hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-brand"
                                    >
                                        Skip Loading (Debug)
                                    </button>
                                )}
                                <p className="text-ink-muted text-caption mt-4">
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
