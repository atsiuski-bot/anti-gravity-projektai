import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { ChevronDown, ChevronUp, Activity } from 'lucide-react';
import SessionTypeIcon from './SessionTypeIcon';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString, MAX_SESSION_MINUTES } from '../utils/timeUtils';
import { useUsers } from '../context/UsersContext';
import { useAuth } from '../context/AuthContext';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import { getSessionColors } from '../utils/sessionColors';
import UserChip from './UserChip';
import { isScopedOverseer, scopeRoster } from '../utils/teamScope';

export default function ActiveWorkSessions() {
    const { users: allUsers, loading: usersLoading } = useUsers();
    const { currentUser, userData } = useAuth();
    const [tasks, setTasks] = useState([]);
    const [isCollapsed, setIsCollapsed] = useState(false);

    // A scoped manager only sees their own team's live activity; admin/unscoped see everyone.
    const scoped = isScopedOverseer(userData);
    const uid = currentUser?.uid;

    // Active (non-disabled) users, narrowed to the viewer's team when scoped.
    const users = useMemo(
        () => scopeRoster(allUsers.filter(u => !u.isDisabled), userData, uid),
        [allUsers, scoped, uid] // eslint-disable-line react-hooks/exhaustive-deps -- userData read via the stable `scoped` flag
    );

    useEffect(() => {
        // Tasks listener only maps active task titles. A scoped manager must constrain it to their
        // team (array-contains) — the broad status-'in' query would be denied once the rules tighten.
        const tasksQuery = scoped && uid
            ? query(collection(db, 'tasks'), where('teamManagerIds', 'array-contains', uid))
            : query(collection(db, 'tasks'), where('status', 'in', ['pending', 'in-progress']));
        const unsubTasks = onSnapshot(tasksQuery, (snap) => {
            const tasksData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setTasks(tasksData);
        }, (error) => {
            console.error("ActiveWorkSessions: Tasks Listener Error:", error);
        });

        return () => {
            unsubTasks();
        };
    }, [scoped, uid]);

    // Active Sessions Logic
    const activeSessions = useMemo(() => {
        return users.map(user => {
            if (!user.activeSession) return null;

            // Map session type to display properties
            let displayProps = {
                label: 'Veikla',
                colorClass: 'bg-surface-sunken text-ink',
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
                        colorClass: 'bg-surface-sunken text-ink',
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
        <div className="bg-surface-card rounded-card shadow-sm border border-line overflow-hidden mb-6">
            <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                aria-expanded={!isCollapsed}
                aria-controls="active-work-sessions-panel"
                className="w-full flex items-center justify-between p-4 bg-surface-sunken hover:bg-surface-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
                <div className="flex items-center gap-2">
                    <Activity className="w-5 h-5 text-brand" />
                    <h3 className="font-semibold text-ink-strong">Aktyvi veikla</h3>
                </div>
                {isCollapsed ? <ChevronDown className="w-5 h-5 text-ink-muted" /> : <ChevronUp className="w-5 h-5 text-ink-muted" />}
            </button>

            {!isCollapsed && (
                <div id="active-work-sessions-panel" className="p-4 space-y-2 animate-in fade-in slide-in-from-top-2">
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
    // A session whose wall-clock start is more than a full max-session ago is almost
    // certainly stale (the worker's app was killed / phone died without ever ending it),
    // not a genuinely live session. We flag it so the manager can tell a 9h "break" caused
    // by a dead phone apart from a real one — the panel otherwise shows them identically.
    const [isStale, setIsStale] = useState(false);

    // Absolute start time ("nuo 08:14") so the manager can sanity-check plausibility instead
    // of only seeing an ever-growing elapsed counter. Stable for the row (startTime is fixed).
    const startLabel = session.startTime
        ? new Date(session.startTime).toLocaleTimeString('lt-LT', {
              hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Vilnius'
          })
        : '';

    useEffect(() => {
        const updateStale = () => {
            if (!session.startTime) { setIsStale(false); return; }
            const ageMs = Date.now() - new Date(session.startTime).getTime();
            setIsStale(Number.isFinite(ageMs) && ageMs > MAX_SESSION_MINUTES * 60 * 1000);
        };

        const updateTime = () => {
            updateStale();
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
        <div className={`p-3 rounded-card flex items-center justify-between shadow-sm transition-all ${session.colorClass} ${isStale ? 'opacity-70 ring-1 ring-amber-300' : ''}`}>
            <div className="flex-shrink-0">
                <SessionTypeIcon type={session.type} className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1 ml-3">
                <div className="flex items-center gap-2">
                    <UserChip
                        userId={session.userId}
                        name={session.userName}
                        className="min-w-0 font-semibold text-sm"
                    />
                    {isStale && (
                        <span className="inline-flex items-center whitespace-nowrap rounded-full border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-caption font-semibold text-amber-800">
                            galimai pasenusi
                        </span>
                    )}
                </div>
                <div className="text-xs truncate">
                    {session.label}
                    {startLabel && <span className="opacity-70"> · nuo {startLabel}</span>}
                </div>
            </div>
            <span className="font-mono font-bold text-body-lg ml-4 whitespace-nowrap">
                {durationStr}
            </span>
        </div>
    );
});

ActiveSessionRow.displayName = 'ActiveSessionRow';

