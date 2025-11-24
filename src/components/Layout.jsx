import React from 'react';
import { useAuth } from '../context/AuthContext';
import { LogOut, User } from 'lucide-react';

export default function Layout({ children }) {
    const { currentUser, userRole, logout } = useAuth();

    const roleNames = {
        manager: 'Vadovas',
        worker: 'Darbuotojas',
        admin: 'Administratorius'
    };

    return (
        <div className="min-h-screen bg-gray-50">
            <nav className="bg-white shadow-sm border-b border-gray-200">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex justify-between h-16">
                        <div className="flex items-center">
                            <img src="/logo.jpg" alt="Viduramžiai.LT wORKZ" className="h-10" />
                            <span className="ml-4 px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 capitalize">
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
                                <span className="text-sm font-medium text-gray-700 hidden sm:block">
                                    {currentUser?.displayName}
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
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 relative">
                {/* Background watermark */}
                <div
                    className="fixed inset-0 pointer-events-none z-0"
                    style={{
                        backgroundImage: 'url(/logo.jpg)',
                        backgroundRepeat: 'no-repeat',
                        backgroundPosition: 'center 20px',
                        backgroundSize: '13%',
                        opacity: 0.25,
                        filter: 'grayscale(100%)'
                    }}
                />
                <div className="relative z-10">
                    {children}
                </div>
            </main>
        </div>
    );
}
