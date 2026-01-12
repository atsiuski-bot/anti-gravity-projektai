import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { LogOut, User } from 'lucide-react';
import BottomNavigation from './BottomNavigation';
import { checkAndPromoteTasks, shouldRunAutomation } from '../utils/automationUtils';
import { formatDisplayName } from '../utils/formatters';

export default function Layout({ children }) {
    const { currentUser, userRole, logout, isTakingBreak, workStatus } = useAuth();

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

    const taskStatus = workStatus?.status;
    const isRunning = taskStatus === 'running' || (workStatus?.isWorking && !taskStatus);
    const isPaused = taskStatus === 'paused';

    return (
        <div className={`min-h-screen ${isTakingBreak ? 'bg-amber-100' : isRunning ? 'bg-green-200' : isPaused ? 'bg-yellow-50' : 'bg-gray-50'} transition-colors duration-300 pb-20 sm:pb-24`}>
            <nav className="bg-white shadow-sm border-b border-gray-200">
                <div className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8">
                    {/* Mobile Layout - User Info & Logout */}
                    <div className="flex flex-col sm:hidden py-2 gap-2">
                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 text-blue-800">
                                    {roleNames[userRole] || userRole}
                                </span>
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
