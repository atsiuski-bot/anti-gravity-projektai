import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { LogOut, User, WifiOff } from 'lucide-react';
import BottomNavigation from './BottomNavigation';
import SideRail from './SideRail';
import InstallPrompt from './InstallPrompt';
import IconButton from './ui/IconButton';
import { runDailyAutomation } from '../utils/automationUtils';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import { useSessionNotification } from '../hooks/useSessionNotification';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { getSessionColors, IDLE_SHELL } from '../utils/sessionColors';
import { cn } from '../utils/cn';
import QuickWorkDescribePrompt from './QuickWorkDescribePrompt';

export default function Layout({ children }) {
    const { currentUser, userData, userRole, logout, isTakingBreak, workStatus } = useAuth();

    const roleNames = {
        manager: 'Vadovas',
        worker: 'Darbuotojas',
        admin: 'Administratorius'
    };

    // Run the full daily automation (promote + archive) once per day for managers/admins.
    // Both this and Dashboard call the same gated entry point, so neither can consume the
    // daily latch with only a partial subset of the work.
    useEffect(() => {
        if (isManagerRole(userRole)) {
            runDailyAutomation();
        }
    }, [userRole]);

    const [isOnline, setIsOnline] = useState(navigator.onLine);

    // Desktop (lg+) swaps the bottom bar + floating work pill for a single left rail. Gated by
    // a JS media query rather than CSS so only ONE nav mounts at a time — the session timers
    // can't be duplicated in the DOM (see useMediaQuery).
    const isDesktop = useMediaQuery('(min-width: 1024px)');

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

    // Use system notification hook to show notification in phone's status bar
    useSessionNotification({ isQuickWorking, isCalling, isTakingBreak, isRunning });

    return (
        <div className={cn('min-h-screen transition-colors duration-slow', bgColor, !isDesktop && 'pb-navclear sm:pb-navclear-lg')}>
            {/* Offline banner — neutral slate, NOT red, so it never collides with the
                quick-work shell (DESIGN_SYSTEM §4-C). Paired with a wifi-off icon. */}
            {!isOnline && (
                <div className="relative z-toast flex items-center justify-center gap-2 bg-feedback-offline px-4 py-1 text-center text-caption font-medium text-white shadow-sm">
                    <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Jūs esate neprisijungęs. Duomenys bus išsaugoti telefone ir sinchronizuoti vėliau.</span>
                </div>
            )}

            {/* Desktop (lg+): a single left rail replaces the bottom bar + floating work pill
                (DESIGN_SYSTEM §9). Mounted exclusively opposite BottomNavigation so the session
                timers are never duplicated in the DOM (see useMediaQuery). */}
            <div className={cn(isDesktop && 'flex items-start')}>
                {isDesktop && <SideRail />}

                <div className={cn('min-w-0', isDesktop && 'flex-1')}>
                    {/* Identity + logout bar — shown off-desktop only; the rail owns it on lg+. */}
                    {!isDesktop && (
                        <nav className="bg-surface-card shadow-sm border-b border-line">
                            <div className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8">
                                {/* Mobile Layout - User Info & Logout */}
                                <div className="flex flex-col sm:hidden py-2 gap-2">
                                    <div className="flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <span className="px-2 py-0.5 rounded-full text-caption font-medium bg-brand-soft text-brand-hover">
                                                {roleNames[userRole] || userRole}
                                            </span>
                                            <InstallPrompt />
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-caption font-medium text-ink">
                                                {formatDisplayName(currentUser?.displayName)}
                                            </span>
                                            <IconButton icon={LogOut} label="Atsijungti" onClick={() => logout()} />
                                        </div>
                                    </div>
                                </div>

                                {/* Tablet (sm..lg) Layout - Single Row */}
                                <div className="hidden sm:flex justify-between h-16">
                                    <div className="flex items-center gap-3">
                                        <span className="px-3 py-1 rounded-full text-xs font-medium bg-brand-soft text-brand-hover capitalize">
                                            {roleNames[userRole] || userRole}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-4">
                                        <div className="flex items-center gap-2">
                                            {currentUser?.photoURL ? (
                                                <img
                                                    src={currentUser.photoURL}
                                                    alt={currentUser.displayName}
                                                    className="h-8 w-8 rounded-full"
                                                />
                                            ) : (
                                                <div className="h-8 w-8 rounded-full bg-surface-sunken flex items-center justify-center">
                                                    <User className="h-5 w-5 text-ink-muted" />
                                                </div>
                                            )}
                                            <span className="text-sm font-medium text-ink">
                                                {formatDisplayName(currentUser?.displayName)}
                                            </span>
                                            <InstallPrompt />
                                        </div>
                                        <IconButton icon={LogOut} label="Atsijungti" onClick={() => logout()} />
                                    </div>
                                </div>
                            </div>
                        </nav>
                    )}

                    {/* Persistent session-state label: color is never the sole signal (DESIGN_SYSTEM
                        §4-A, WCAG 1.4.1). Always visible while a session is active. */}
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
                            {/* Retroactive description for quick-work sessions ended on another
                                device — a calm prompt that never collides with the shell above. */}
                            <QuickWorkDescribePrompt />
                            {children}
                        </div>
                    </main>
                </div>
            </div>

            {!isDesktop && <BottomNavigation />}
        </div>
    );
}
