import React, { useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import {
    ListTodo,
    UserCheck,
    Calendar as CalendarIcon,
    Users as UsersIcon,
    History,
    UserCog,
    Plus
} from 'lucide-react';
import BreakTimer from './BreakTimer';
import CallTimer from './CallTimer';
import QuickWorkTimer from './QuickWorkTimer';
import clsx from 'clsx';

const BottomNavigation = () => {
    const { userRole, currentUser } = useAuth();
    const { activeTab, setActiveTab } = useNavigation();

    // Memoize tabs configuration to prevent unnecessary recalculations
    const tabs = useMemo(() => {
        const managerTabs = [
            { id: 'my-tasks', label: 'Darbai', icon: ListTodo },
            { id: 'my-calendar', label: 'Kalendorius', icon: CalendarIcon },
            { id: 'my-reports', label: 'Ataskaitos', icon: History },
            { type: 'separator' },
            { id: 'tasks', label: 'Kom. darbai', icon: UserCheck },
            { id: 'team-calendar', label: 'Kom. kalendorius', icon: UsersIcon },
            { id: 'reports', label: 'Kom. ataskaitos', icon: History },
            ...(userRole === 'admin' ? [{ id: 'users', label: 'Vartotojai', icon: UserCog }] : [])
        ];

        const workerTabs = [
            { id: 'tasks', label: 'Darbai', icon: ListTodo },
            { id: 'calendar', label: 'Kalendorius', icon: CalendarIcon },
            { id: 'reports', label: 'Ataskaitos', icon: History },
            { id: 'team-calendar', label: 'Kom. Kalendorius', icon: UsersIcon },
        ];

        return userRole === 'manager' || userRole === 'admin' ? managerTabs : workerTabs;
    }, [userRole]);

    const showCreateButton = (userRole === 'worker') || (userRole === 'manager' || userRole === 'admin');

    const CreateButton = () => (
        <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-task-modal'))}
            className="flex flex-col items-center justify-center p-2 rounded-lg text-blue-600 hover:bg-blue-50 transition-colors active:scale-95"
            title="Sukurti užduotį"
        >
            <div className="bg-blue-100 p-1.5 rounded-lg mb-1">
                <Plus className="w-5 h-5" />
            </div>
            <span className="text-[9px] font-bold leading-none uppercase tracking-wide text-center">
                Sukurti
            </span>
        </button>
    );


    if (!currentUser) return null;

    return (
        <>
            {/* Work Controls Floating Pill (Visible on All Screens) */}
            <div className="fixed bottom-[64px] left-0 right-0 z-50 px-2 pb-2 pointer-events-none flex justify-center w-full">
                {/*  Using pointer-events-none on container, events-auto on inner box */}
                <div className="pointer-events-auto bg-white/95 backdrop-blur-sm border border-gray-200 shadow-xl rounded-2xl p-2 flex items-center gap-3 overflow-x-auto mx-2 max-w-full">
                    {showCreateButton && (
                        <div className="flex-shrink-0">
                            <CreateButton />
                        </div>
                    )}
                    {showCreateButton && <div className="h-8 w-px bg-gray-200 flex-shrink-0"></div>}

                    <div className="flex items-center gap-2">
                        <QuickWorkTimer compact={true} />
                        <CallTimer compact={true} />
                        <BreakTimer currentUser={currentUser} compact={true} />
                    </div>
                </div>
            </div>

            {/* Main Bottom Bar */}
            <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]">
                <div className="max-w-7xl mx-auto px-2 relative h-16 flex items-center justify-between gap-2">



                    {/* Desktop: Tabs (Centered and larger) */}
                    <div className="hidden sm:flex items-center justify-center flex-1 gap-2">
                        {tabs.map((tab, idx) => {
                            if (tab.type === 'separator') {
                                return <div key={`sep-${idx}`} className="w-px h-10 bg-gray-200 mx-3" />;
                            }
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={clsx(
                                        "flex flex-col items-center justify-center min-w-[90px] transition-colors py-2.5 px-4 rounded-lg hover:bg-gray-50",
                                        activeTab === tab.id ? "text-blue-600 bg-blue-50" : "text-gray-500"
                                    )}
                                >
                                    <tab.icon className="w-6 h-6 mb-1.5" />
                                    <span className="text-[11px] font-medium leading-tight whitespace-nowrap">
                                        {tab.label}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {/* Mobile: Tabs (Fill the bar) */}
                    <div className="flex sm:hidden flex-1 justify-around items-center overflow-x-auto no-scrollbar">
                        {tabs.map((tab, idx) => {
                            if (tab.type === 'separator') {
                                return <div key={`sep-${idx}`} className="w-px h-8 bg-gray-200 mx-1 flex-shrink-0" />;
                            }
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={clsx(
                                        "flex flex-col items-center justify-center min-w-[50px] transition-colors py-1 px-1 rounded-lg",
                                        activeTab === tab.id ? "text-blue-600" : "text-gray-500 hover:text-gray-700"
                                    )}
                                >
                                    <tab.icon className="w-5 h-5 mb-1" />
                                    <span className="text-[9px] font-medium leading-none whitespace-nowrap text-center">
                                        {tab.label.split(' ').map((word, i) => (
                                            <React.Fragment key={i}>
                                                {word}
                                                {i < tab.label.split(' ').length - 1 && <br />}
                                            </React.Fragment>
                                        ))}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>
        </>
    );
};

export default React.memo(BottomNavigation);
