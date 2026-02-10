import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { Users, ChevronDown, ChevronUp, Activity } from 'lucide-react';
import SessionTypeIcon from './SessionTypeIcon';

export default function ActiveWorkSessions() {
    const [users, setUsers] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isCollapsed, setIsCollapsed] = useState(false); // Default expanded for visibility

    useEffect(() => {
        setLoading(true);

        // 1. Listen to Users (for activeSession field)
        const unsubUsers = onSnapshot(collection(db, 'users'), (snap) => {
            const usersData = snap.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(u => !u.isDisabled);
            setUsers(usersData);
            setLoading(false);
        }, (error) => {
            console.error("ActiveWorkSessions: Users Listener Error:", error);
            setLoading(false);
        });

        // 2. Listen to Tasks (to resolve Task Titles)
        // We fetch all active tasks to be able to resolve titles referenced in activeSession
        const unsubTasks = onSnapshot(collection(db, 'tasks'), (snap) => {
            const tasksData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setTasks(tasksData);
        }, (error) => {
            console.error("ActiveWorkSessions: Tasks Listener Error:", error);
        });

        return () => {
            unsubUsers();
            unsubTasks();
        };
    }, []);

    // Active Sessions Logic
    const activeSessions = useMemo(() => {
        return users.map(user => {
            if (!user.activeSession) return null;

            // Map session type to display properties
            let displayProps = {
                label: 'Veikla',
                colorClass: 'bg-gray-100 text-gray-800',
                startTime: user.activeSession.startTime
            };

            switch (user.activeSession.type) {
                case 'break':
                    displayProps = {
                        label: 'Pertrauka',
                        colorClass: 'bg-orange-100 text-orange-800',
                        startTime: user.activeSession.startTime
                    };
                    break;
                case 'call':
                    displayProps = {
                        label: 'Skambutis',
                        colorClass: 'bg-sky-100 text-sky-800',
                        startTime: user.activeSession.startTime
                    };
                    break;
                case 'quick_work':
                    displayProps = {
                        label: 'Greitas darbas',
                        colorClass: 'bg-red-100 text-red-800',
                        startTime: user.activeSession.startTime
                    };
                    break;
                case 'task':
                    // Find generic task title if available
                    let title = user.activeSession.taskTitle || 'Užduotis';
                    // Try to find specific task in loaded tasks if ID matches
                    const foundTask = tasks.find(t => t.id === user.activeSession.taskId);
                    if (foundTask) {
                        title = foundTask.title;
                    }
                    displayProps = {
                        label: title,
                        colorClass: 'bg-green-100 text-green-800',
                        startTime: user.activeSession.startTime
                    };
                    break;
                default:
                    // Fallback for unknown types
                    displayProps = {
                        label: user.activeSession.type || 'Veikla',
                        colorClass: 'bg-gray-100 text-gray-800',
                        startTime: user.activeSession.startTime
                    };
            }

            return {
                userId: user.id,
                userName: user.displayName || user.email,
                userColor: user.color || '#3b82f6',
                ...displayProps
            };
        }).filter(Boolean);
    }, [users, tasks]);

    if (loading) return null;
    if (activeSessions.length === 0) return null; // Hide completely if empty? Or show empty state? Let's hide to reduce clutter.

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-6">
            <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Activity className="w-5 h-5 text-blue-600" />
                    <h3 className="font-semibold text-gray-900">Veikla (Active Sessions)</h3>
                </div>
                {isCollapsed ? <ChevronDown className="w-5 h-5 text-gray-500" /> : <ChevronUp className="w-5 h-5 text-gray-500" />}
            </button>

            {!isCollapsed && (
                <div className="p-4 space-y-2">
                    {activeSessions.map(session => (
                        <ActiveSessionRow key={session.userId} session={session} />
                    ))}
                </div>
            )}
        </div>
    );
}

// Helper Component for Active Session Row to manage own timer
const ActiveSessionRow = React.memo(({ session }) => {
    const [durationStr, setDurationStr] = useState('');

    useEffect(() => {
        const updateTime = () => {
            if (!session.startTime) {
                setDurationStr('');
                return;
            }
            const start = new Date(session.startTime);
            const now = new Date();
            const diffMs = now - start;
            if (diffMs < 0) {
                setDurationStr('0m');
                return;
            }

            const diffMinutes = Math.floor(diffMs / (1000 * 60));

            if (diffMinutes < 60) {
                setDurationStr(`${diffMinutes}m`);
            } else {
                const hours = Math.floor(diffMinutes / 60);
                const mins = diffMinutes % 60;
                setDurationStr(`${hours}h ${mins}m`);
            }
        };

        updateTime(); // Initial
        // Update every minute (60,000 ms)
        const interval = setInterval(updateTime, 60000);

        return () => clearInterval(interval);
    }, [session.startTime]);

    return (
        <div className={`p-3 rounded-lg flex items-center justify-between shadow-sm transition-all ${session.colorClass}`}>
            <div className="flex-shrink-0">
                <SessionTypeIcon type={session.type} className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm truncate">
                        {session.userName}
                    </span>
                </div>
                <div className="text-xs truncate opacity-90">
                    {session.label}
                </div>
            </div>
            <span className="font-mono font-bold text-sm ml-4 whitespace-nowrap opacity-80">
                {durationStr}
            </span>
        </div>
    );
});

ActiveSessionRow.displayName = 'ActiveSessionRow';

