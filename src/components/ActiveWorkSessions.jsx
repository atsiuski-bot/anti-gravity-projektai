import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { ChevronDown, ChevronUp, Activity } from 'lucide-react';
import SessionTypeIcon from './SessionTypeIcon';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString } from '../utils/timeUtils';
import { useUsers } from '../context/UsersContext';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import { getSessionColors } from '../utils/sessionColors';

export default function ActiveWorkSessions() {
    const { users: allUsers, loading: usersLoading } = useUsers();
    const [tasks, setTasks] = useState([]);
    const [isCollapsed, setIsCollapsed] = useState(false);

    // Filter out disabled users
    const users = useMemo(() => allUsers.filter(u => !u.isDisabled), [allUsers]);

    useEffect(() => {
        // Only need tasks listener for currently active or pending tasks to map titles
        const tasksQuery = query(collection(db, 'tasks'), where('status', 'in', ['pending', 'in-progress']));
        const unsubTasks = onSnapshot(tasksQuery, (snap) => {
            const tasksData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setTasks(tasksData);
        }, (error) => {
            console.error("ActiveWorkSessions: Tasks Listener Error:", error);
        });

        return () => {
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
                        type: 'break',
                        label: 'Pertrauka',
                        colorClass: `${getSessionColors('break').surface} ${getSessionColors('break').accent}`,
                        startTime: user.activeSession.startTime
                    };
                    break;
                case 'call':
                    displayProps = {
                        type: 'call',
                        label: 'Skambutis',
                        colorClass: `${getSessionColors('call').surface} ${getSessionColors('call').accent}`,
                        startTime: user.activeSession.startTime
                    };
                    break;
                case 'quickWork':
                    displayProps = {
                        type: 'quickWork',
                        label: 'Greitas darbas',
                        colorClass: `${getSessionColors('quickWork').surface} ${getSessionColors('quickWork').accent}`,
                        startTime: user.activeSession.startTime
                    };
                    break;
                case 'task': {
                    // Find generic task title if available
                    let title = user.activeSession.taskTitle || 'Užduotis';
                    // Try to find specific task in loaded tasks if ID matches
                    const foundTask = tasks.find(t => t.id === user.activeSession.taskId);
                    if (foundTask) {
                        title = foundTask.title;
                    }
                    displayProps = {
                        type: 'task',
                        label: title,
                        colorClass: `${getSessionColors('task').surface} ${getSessionColors('task').accent}`,
                        startTime: user.activeSession.startTime,
                        task: foundTask || null
                    };
                    break;
                }
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
                userColor: user.color || WORKER_FALLBACK_COLOR,
                ...displayProps
            };
        }).filter(Boolean);
    }, [users, tasks]);

    if (usersLoading) return null;
    if (activeSessions.length === 0) return null; // Hide completely if empty? Or show empty state? Let's hide to reduce clutter.

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-6">
            <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                aria-expanded={!isCollapsed}
                aria-controls="active-work-sessions-panel"
                className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
                <div className="flex items-center gap-2">
                    <Activity className="w-5 h-5 text-brand" />
                    <h3 className="font-semibold text-gray-900">Aktyvi veikla</h3>
                </div>
                {isCollapsed ? <ChevronDown className="w-5 h-5 text-gray-500" /> : <ChevronUp className="w-5 h-5 text-gray-500" />}
            </button>

            {!isCollapsed && (
                <div id="active-work-sessions-panel" className="p-4 space-y-2">
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
            if (session.type === 'task' && session.task) {
                // Use global task total time calculation for accurate cross-device time
                const totalMinutes = calculateCurrentTotalMinutes(session.task);
                setDurationStr(formatMinutesToTimeString(totalMinutes));
                return;
            }

            // Fallback for non-task sessions (breaks, calls, quick_work)
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
        // Update more frequently (every 10 seconds) to ensure synchronization with other timers
        const interval = setInterval(updateTime, 10000);

        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve timer re-arm timing; session.type is stable for a given session row
    }, [session.startTime, session.task]);

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
                <div className="text-xs truncate">
                    {session.label}
                </div>
            </div>
            <span className="font-mono font-bold text-base ml-4 whitespace-nowrap">
                {durationStr}
            </span>
        </div>
    );
});

ActiveSessionRow.displayName = 'ActiveSessionRow';

