import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { WifiOff } from 'lucide-react';
import BottomNavigation from './BottomNavigation';
import InstallPrompt from './InstallPrompt';
import Avatar from './ui/Avatar';
import { runDailyAutomation } from '../utils/automationUtils';
import { isManagerRole } from '../utils/formatters';
import { useSessionNotification } from '../hooks/useSessionNotification';
import { getSessionColors, IDLE_SHELL } from '../utils/sessionColors';
import { cn } from '../utils/cn';
import QuickWorkDescribePrompt from './QuickWorkDescribePrompt';

export default function Layout({ children }) {
    const { currentUser, userData, userRole, isTakingBreak, workStatus } = useAuth();
    const { setActiveTab } = useNavigation();

    // Run the full daily automation (promote + archive) once per day for managers/admins.
    // Both this and Dashboard call the same gated entry point, so neither can consume the
    // daily latch with only a partial subset of the work.
    useEffect(() => {
        if (isManagerRole(userRole)) {
            runDailyAutomation();
        }
    }, [userRole]);

    const [isOnline, setIsOnline] = useState(navigator.onLine);

    useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => setIsOnline(false);

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    // Derive active session type — activeSession is the primary source of truth.
    // Legacy flags are only used as a fallback when no activeSession exists.
    const sessionType = userData?.activeSession?.type || null;

    const isQuickWorking = sessionType === 'quickWork' || (!sessionType && (userData?.quickWorkState?.isQuickWorking || false));
    const isCalling = sessionType === 'call' || (!sessionType && (userData?.callState?.isCalling || false));
    const isRunning = sessionType === 'task' || (!sessionType && workStatus?.status === 'running');

    // Resolve a single effective session type (precedence: quick work > call > break > task),
    // then read ALL presentation from the one SESSION_COLORS map so the shell, label and icon
    // can never drift (DESIGN_SYSTEM §4-B).
    let effectiveSessionType = null;
    if (sessionType) {
        effectiveSessionType = getSessionColors(sessionType) ? sessionType : null;
    } else if (isQuickWorking) {
        effectiveSessionType = 'quickWork';
    } else if (isCalling) {
        effectiveSessionType = 'call';
    } else if (isTakingBreak) {
        effectiveSessionType = 'break';
    } else if (isRunning) {
        effectiveSessionType = 'task';
    }

    const session = getSessionColors(effectiveSessionType);
    const bgColor = session?.shell || IDLE_SHELL;

    // Use system notification hook to show notification in phone's status bar.
    // Honor the per-user toggle from the profile page (missing field => enabled).
    useSessionNotification({
        isQuickWorking,
        isCalling,
        isTakingBreak,
        isRunning,
        enabled: userData?.notificationsEnabled !== false,
    });

    return (
        <div className={cn('min-h-screen transition-colors duration-slow pb-navclear sm:pb-navclear-lg', bgColor)}>
            {/* Offline banner — neutral slate, NOT red, so it never collides with the
                quick-work shell (DESIGN_SYSTEM §4-C). Paired with a wifi-off icon. */}
            {!isOnline && (
                <div className="relative z-toast flex items-center justify-center gap-2 bg-feedback-offline px-4 py-1 text-center text-caption font-medium text-white shadow-sm">
                    <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Jūs esate neprisijungęs. Duomenys bus išsaugoti telefone ir sinchronizuoti vėliau.</span>
                </div>
            )}

            {/* Top bar — a single entry point to the profile. Role, name, install and logout
                all moved INTO the profile page; the header is just the avatar (per product
                decision 2026-06-22). */}
            <nav className="bg-surface-card shadow-sm border-b border-line">
                <div className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8">
                    <div className="flex h-14 sm:h-16 items-center justify-end">
                        <button
                            type="button"
                            onClick={() => setActiveTab('profile')}
                            aria-label="Atidaryti profilį"
                            className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-full transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                        >
                            <Avatar
                                src={userData?.photoURL || currentUser?.photoURL}
                                name={currentUser?.displayName}
                                email={currentUser?.email}
                                size="sm"
                            />
                        </button>
                    </div>
                </div>
            </nav>

            {/* PWA install — a slim, dismissible banner shown only when the browser offers an
                install (or on iOS, manual steps). Replaces the old header button. */}
            <InstallPrompt />

            {/* Persistent session-state label: color is never the sole signal (DESIGN_SYSTEM §4-A,
                WCAG 1.4.1). Always visible while a session is active, regardless of the shell color. */}
            {session && (
                <div
                    role="status"
                    className="flex items-center justify-center gap-2 border-b border-line bg-surface-card px-4 py-1.5 text-caption font-semibold text-ink-strong"
                >
                    <session.Icon className={cn('h-4 w-4', session.accent)} aria-hidden="true" />
                    <span>{session.label}</span>
                </div>
            )}

            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-2 pb-8 relative">
                <div className="relative z-10">
                    {/* Retroactive description for quick-work sessions ended on another device —
                        a calm prompt that never collides with the active-session shell above. */}
                    <QuickWorkDescribePrompt />
                    {children}
                </div>
            </main>
            <BottomNavigation />
        </div>
    );
}
