import React, { useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { LogOut, User } from 'lucide-react';
import BottomNavigation from './BottomNavigation';
import InstallPrompt from './InstallPrompt';
import { checkAndPromoteTasks, shouldRunAutomation } from '../utils/automationUtils';
import { formatDisplayName } from '../utils/formatters';
import { useSessionNotification } from '../hooks/useSessionNotification';

export default function Layout({ children }) {
    const { currentUser, userData, userRole, logout, isTakingBreak, workStatus } = useAuth(); // userData added

    const roleNames = {
        manager: 'Vadovas',
        worker: 'Darbuotojas',
        admin: 'Administratorius'
    };

    // Run task automation once per day for managers/admins
    useEffect(() => {
        if ((userRole === 'manager' || userRole === 'admin') && shouldRunAutomation()) {
            checkAndPromoteTasks();
        }
    }, [userRole]);

    const [isOnline, setIsOnline] = React.useState(navigator.onLine);

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

    // Extract state values with memoization to prevent unnecessary re-renders
    const isCalling = useMemo(() => userData?.callState?.isCalling || false, [userData?.callState?.isCalling]);
    const isQuickWorking = useMemo(() => userData?.quickWorkState?.isQuickWorking || false, [userData?.quickWorkState?.isQuickWorking]);
    const isRunning = useMemo(() => workStatus?.status === 'running', [workStatus?.status]);

    // Determine background color based on state priority (memoized for performance)
    // Priority: Quick Work (Red) > Call (Blue) > Break (Amber) > Working (Green) > Default (White)
    const bgColor = useMemo(() => {
        if (isQuickWorking) return 'bg-red-500'; // Much more intense red for Quick Work
        if (isCalling) return 'bg-blue-100'; // Light Blue for Call
        if (isTakingBreak) return 'bg-amber-100'; // Break
        if (isRunning) return 'bg-green-200'; // Actively working
        return 'bg-white'; // Default (idle or paused)
    }, [isQuickWorking, isCalling, isTakingBreak, isRunning]);

    // Use system notification hook to show notification in phone's status bar
    useSessionNotification({ isQuickWorking, isCalling, isTakingBreak, isRunning });

    return (
        <div className={`min-h-screen ${bgColor} transition-colors duration-300 pb-32 sm:pb-36`}>
            {/* Offline Banner */}
            {!isOnline && (
                <div className="bg-red-500 text-white px-4 py-1 text-xs text-center font-medium shadow-sm z-50 relative animate-in fade-in slide-in-from-top-2">
                    Jūs esate neprisijungęs. Duomenys bus išsaugoti telefone ir sinchronizuoti vėliau.
                </div>
            )}
            <nav className="bg-white shadow-sm border-b border-gray-200">
                <div className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8">
                    {/* Mobile Layout - User Info & Logout */}
                    <div className="flex flex-col sm:hidden py-2 gap-2">
                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 text-blue-800">
                                    {roleNames[userRole] || userRole}
                                </span>
                                <InstallPrompt />
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-medium text-gray-700">
                                    {formatDisplayName(currentUser?.displayName)}
                                </span>
                                <button
                                    onClick={() => logout()}
                                    className="p-1.5 rounded-full text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                                    title="Sign out"
                                >
                                    <LogOut className="h-4 w-4" />
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Desktop Layout - Single Row */}
                    <div className="hidden sm:flex justify-between h-16">
                        <div className="flex items-center gap-3">
                            <span className="px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 capitalize">
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
                            <button
                                onClick={() => logout()}
                                className="p-2 rounded-full text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                                title="Sign out"
                            >
                                <LogOut className="h-5 w-5" />
                            </button>
                        </div>
                    </div>
                </div>
            </nav>
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-2 pb-8 relative">
                <div className="relative z-10">
                    {children}
                </div>
            </main>
            <BottomNavigation />
        </div>
    );
}
