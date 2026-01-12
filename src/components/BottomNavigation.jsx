import React from 'react';
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
import clsx from 'clsx';

export default function BottomNavigation() {
    const { userRole, currentUser } = useAuth();
    const { activeTab, setActiveTab } = useNavigation();

    if (!currentUser) return null;

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

    const tabs = userRole === 'manager' || userRole === 'admin' ? managerTabs : workerTabs;

    return (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50 pb-[env(safe-area-inset-bottom)]">
            <div className="max-w-7xl mx-auto px-1 relative">
                {/* Floating Add Task Button */}
                {((userRole === 'worker' && activeTab === 'tasks') || ((userRole === 'manager' || userRole === 'admin') && activeTab === 'my-tasks')) && (
                    <div className="absolute left-4 bottom-[104px] group z-[60]">
                        <button
                            onClick={() => window.dispatchEvent(new CustomEvent('open-task-modal'))}
                            className="bg-blue-600 p-3 sm:p-4 rounded-full shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-blue-500 ring-4 ring-white/80 transition-all hover:scale-110 active:scale-95 flex flex-col items-center justify-center text-white min-w-[64px] min-h-[64px] sm:min-w-[72px] sm:min-h-[72px]"
                            title="Sukurti užduotį"
                        >
                            <Plus className="w-5 h-5 mb-1" />
                            <span className="text-[9px] sm:text-[10px] font-bold leading-tight uppercase tracking-wider text-center">
                                Sukurti<br />darbą
                            </span>
                        </button>
                    </div>
                )}

                {/* Floating Break Button */}
                <div className="absolute right-4 bottom-[104px] group z-[60]">
                    <div className="bg-white p-2 rounded-full shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-100 ring-4 ring-white/80 transition-transform group-hover:scale-110 active:scale-95">
                        <BreakTimer currentUser={currentUser} compact={true} />
                    </div>
                </div>

                <div className="flex items-center justify-between h-14 sm:h-16">
                    {/* All Tabs and Separator */}
                    <div className="flex flex-1 justify-around items-center overflow-x-auto no-scrollbar">
                        {tabs.map((tab, idx) => {
                            if (tab.type === 'separator') {
                                return <div key={`sep-${idx}`} className="w-px h-8 bg-gray-200 mx-1" />;
                            }
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={clsx(
                                        "flex flex-col items-center justify-center min-w-[50px] sm:min-w-[64px] transition-colors py-1",
                                        activeTab === tab.id ? "text-blue-600" : "text-gray-500 hover:text-gray-700"
                                    )}
                                >
                                    <tab.icon className="w-4 h-4 sm:w-5 sm:h-5 mb-1" />
                                    <span className="text-[9px] sm:text-[10px] font-medium leading-none whitespace-nowrap text-center px-1">
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
        </div>
    );
}
