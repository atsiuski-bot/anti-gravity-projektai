import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { LogOut, User, WifiOff } from 'lucide-react';
import BottomNavigation from './BottomNavigation';
import InstallPrompt from './InstallPrompt';
import IconButton from './ui/IconButton';
import { checkAndPromoteTasks, shouldRunAutomation } from '../utils/automationUtils';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import { useSessionNotification } from '../hooks/useSessionNotification';
import { getSessionColors, IDLE_SHELL } from '../utils/sessionColors';
import { cn } from '../utils/cn';

export default function Layout({ children }) {
    const { currentUser, userData, userRole, logout, isTakingBreak, workStatus } = useAuth();

    const roleNames = {
        manager: 'Vadovas',
        worker: 'Darbuotojas',
        admin: 'Administratorius'
    };

    // Run task automation once per day for managers/admins
    useEffect(() => {
        if (isManagerRole(userRole) && shouldRunAutomation()) {
            checkAndPromoteTasks();
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

    // Use system notification hook to show notification in phone's status bar
    useSessionNotification({ isQuickWorking, isCalling, isTakingBreak, isRunning });

    return (
        <div className={cn('min-h-screen transition-colors duration-slow pb-32 sm:pb-36', bgColor)}>
            {/* Offline banner — neutral slate, NOT red, so it never collides with the
                quick-work shell (DESIGN_SYSTEM §4-C). Paired with a wifi-off icon. */}
            {!isOnline && (
                <div className="relative z-toast flex items-center justify-center gap-2 bg-feedback-offline px-4 py-1 text-center text-xs font-medium text-white shadow-sm">
                    <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Jūs esate neprisijungęs. Duomenys bus išsaugoti telefone ir sinchronizuoti vėliau.</span>
                </div>
            )}

            <nav className="bg-white shadow-sm border-b border-gray-200">
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
                                <span className="text-xs font-medium text-gray-700">
                                    {formatDisplayName(currentUser?.displayName)}
                                </span>
                                <IconButton icon={LogOut} label="Atsijungti" onClick={() => logout()} />
                            </div>
                        </div>
                    </div>

                    {/* Desktop Layout - Single Row */}
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
                                    <div className="h-8 w-8 rounded-full bg-gray-200 flex items-center justify-center">
                                        <User className="h-5 w-5 text-gray-500" />
                                    </div>
                                )}
                                <span className="text-sm font-medium text-gray-700">
                                    {formatDisplayName(currentUser?.displayName)}
                                </span>
                                <InstallPrompt />
                            </div>
                            <IconButton icon={LogOut} label="Atsijungti" onClick={() => logout()} />
                        </div>
                    </div>
                </div>
            </nav>

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
                    {children}
                </div>
            </main>
            <BottomNavigation />
        </div>
    );
}
