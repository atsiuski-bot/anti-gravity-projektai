import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { Users, ChevronDown, ChevronUp, Briefcase } from 'lucide-react';
import { startOfWeek, endOfWeek, addDays } from 'date-fns';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import { getLithuanianNow, getLithuanianDateString } from '../utils/timeUtils';

export default function CombinedHoursSummary() {
    const { currentUser } = useAuth();
    const { users: allUsers, loading: usersLoading } = useUsers();
    const users = allUsers;
    const [tasks, setTasks] = useState([]);
    const [workHours, setWorkHours] = useState([]);
    const [workSessions, setWorkSessions] = useState([]);
    const [breakSessions, setBreakSessions] = useState([]);
    const [error, setError] = useState('');
    const [isCollapsed, setIsCollapsed] = useState(true);

    useEffect(() => {
        if (!currentUser || usersLoading) return;

        const now = getLithuanianNow();

        // Standard week starts Monday
        const weekStart = startOfWeek(now, { weekStartsOn: 1 });
        const weekEnd = endOfWeek(now, { weekStartsOn: 1 });
        const weekStartStr = getLithuanianDateString(weekStart);
        const weekEndStr = getLithuanianDateString(weekEnd);

        // 1. Users come from UsersContext — no listener needed here

        // 2. Listen to Tasks (Active)
        let activeTasks = [];
        let archivedTasks = [];
        const updateAllTasks = () => {
            setTasks([...activeTasks, ...archivedTasks]);
        };

        const unsubActive = onSnapshot(collection(db, 'tasks'), (snap) => {
            activeTasks = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            updateAllTasks();
        }, (error) => {
            console.error("CombinedHoursSummary: Active Tasks Listener Error:", error);
        });

        // Add query to limit archived tasks to the current week
        const archivedQuery = query(collection(db, 'archived_tasks'), where('archivedAt', '>=', weekStartStr));

        const unsubArchived = onSnapshot(archivedQuery, (snap) => {
            archivedTasks = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            updateAllTasks();
        }, (error) => {
            console.error("CombinedHoursSummary: Archived Tasks Listener Error:", error);
        });

        // 3. Listen to Work Hours (Planned Calendar Events)
        const workHoursQuery = query(collection(db, 'work_hours'));
        const unsubWorkHours = onSnapshot(workHoursQuery, (snapshot) => {
            const hoursData = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(wh => {
                    const start = new Date(wh.start);
                    // Filter generally relevant events, precise overlap check can be done later if needed, 
                    // but simple range check is efficient for now.
                    return start >= weekStart && start <= weekEnd;
                });
            setWorkHours(hoursData);
        }, (err) => {
            console.error('Error fetching work hours:', err);
            setError('Nepavyko užkrauti duomenų');
        });

        // 4. Listen to Work Sessions — server-side date filter
        const sessionsQuery = query(
            collection(db, 'work_sessions'),
            where('date', '>=', weekStartStr),
            where('date', '<=', weekEndStr)
        );
        const unsubSessions = onSnapshot(sessionsQuery, (snapshot) => {
            const sessionsData = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(s => !s.isDeleted);
            setWorkSessions(sessionsData);
        }, (error) => {
            console.error("CombinedHoursSummary: Work Sessions Listener Error:", error);
        });

        // 5. Listen to Break Sessions — server-side date filter
        const breakQuery = query(
            collection(db, 'break_sessions'),
            where('date', '>=', weekStartStr),
            where('date', '<=', weekEndStr)
        );
        const unsubBreakSessions = onSnapshot(breakQuery, (snapshot) => {
            const breakData = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }));
            setBreakSessions(breakData);
        }, (error) => {
            console.error("CombinedHoursSummary: Break Sessions Listener Error:", error);
        });

        return () => {
            unsubActive();
            unsubArchived();
            unsubWorkHours();
            unsubSessions();
            unsubBreakSessions();
        };
    }, [currentUser, usersLoading]);

    // Calculate stats
    const combinedStats = useMemo(() => {
        const stats = [];
        let maxVal = 0;
        const now = getLithuanianNow();
        const wStart = startOfWeek(now, { weekStartsOn: 1 });
        const wEnd = endOfWeek(now, { weekStartsOn: 1 });

        users.forEach(user => {
            let plannedHours = 0;
            let workedMinutes = 0;

            // Calculate weekly scheduled hours (Calendar)
            workHours.forEach(wh => {
                if (wh.userId === user.id) {
                    const whStart = new Date(wh.start);
                    const whEnd = new Date(wh.end);
                    const duration = (whEnd - whStart) / (1000 * 60 * 60);
                    plannedHours += duration;
                }
            });

            // Calculate weekly actual worked minutes
            // 1. From Sessions
            workSessions.forEach(session => {
                if (session.userId === user.id) {
                    workedMinutes += (session.durationMinutes || 0);
                }
            });

            // 2. From Tasks (Manual Minutes only — NOT Quick Work / Calls)
            // Call and Quick Work tasks already have dedicated work_sessions logged,
            // so including their manualMinutes here would double-count.
            tasks.forEach(t => {
                if (t.assignedUserId === user.id && t.manualMinutes > 0 && !t.isSystemTask && !t.isQuickWork) {
                    const compDate = t.completedAt ? new Date(t.completedAt) : (t.archivedAt ? new Date(t.archivedAt) : null);
                    if (compDate && compDate >= wStart && compDate <= wEnd) {
                        workedMinutes += t.manualMinutes;
                    }
                }
            });

            // 3. From Break Sessions (for progress bar display only)
            breakSessions.forEach(session => {
                if (session.userId === user.id) {
                    workedMinutes += (session.durationMinutes || 0);
                }
            });

            // Add current active break time if user is taking a break right now
            if (user.breakState?.isTakingBreak && user.breakState?.lastStartedAt) {
                const bStart = new Date(user.breakState.lastStartedAt);
                const currentDiff = (now - bStart) / (1000 * 60);
                if (currentDiff > 0) {
                    workedMinutes += currentDiff;
                }
            }

            const workedHours = workedMinutes / 60;
            if (plannedHours > maxVal) maxVal = plannedHours;
            if (workedHours > maxVal) maxVal = workedHours;

            stats.push({
                id: user.id,
                name: user.displayName || user.email,
                color: user.color || '#3b82f6',
                plannedHours,
                workedHours
            });
        });

        // Add buffer to max value for visual spacing
        return { data: stats, max: Math.max(maxVal, 40) }; // Minimum scale 40h
    }, [users, workHours, workSessions, tasks, breakSessions]);

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
                case 'quickWork':
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
                        colorClass: 'bg-green-100 text-green-800', // You can customize generic task color here
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

    if (usersLoading) return null;
    if (error) return null;

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-6">
            <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Users className="w-5 h-5 text-blue-600" />
                    <h3 className="font-semibold text-gray-900">Komandos darbai (Savaitės)</h3>
                </div>
                {isCollapsed ? <ChevronDown className="w-5 h-5 text-gray-500" /> : <ChevronUp className="w-5 h-5 text-gray-500" />}
            </button>

            {!isCollapsed && (
                <div className="p-4 space-y-6">
                    {/* Active Sessions (Veikla) */}
                    {activeSessions.length > 0 && (
                        <div>
                            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 pl-1">
                                Veikla
                            </h4>
                            <div className="space-y-2">
                                {activeSessions.map(session => (
                                    <ActiveSessionRow key={session.userId} session={session} />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Weekly Hours Bars */}
                    <div>
                        {combinedStats.data.length > 0 && (
                            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 pl-1">
                                Savaitės valandos
                            </h4>
                        )}

                        {combinedStats.data.length === 0 ? (
                            <p className="text-gray-500 text-sm italic">Nėra duomenų.</p>
                        ) : (
                            combinedStats.data.map(user => (
                                <div key={user.id} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 mb-3 last:mb-0">
                                    {/* User Info */}
                                    <div className="sm:w-1/4 min-w-[150px] flex items-center gap-2">
                                        <div
                                            className="w-3 h-3 rounded-full flex-shrink-0"
                                            style={{ backgroundColor: user.color }}
                                        />
                                        <span className="text-sm font-medium text-gray-900 truncate" title={user.name}>
                                            {user.name}
                                        </span>
                                    </div>

                                    {/* Bars Area */}
                                    <div className="flex-1 flex flex-col gap-1.5">
                                        {/* Planned Bar */}
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-gray-500 font-mono w-12 text-right">
                                                {user.plannedHours.toFixed(1)}h
                                            </span>
                                            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden relative">
                                                <div
                                                    className="absolute top-0 left-0 h-full bg-blue-300 rounded-full"
                                                    style={{ width: `${(user.plannedHours / combinedStats.max) * 100}%` }}
                                                />
                                            </div>
                                        </div>

                                        {/* Worked Bar */}
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-gray-900 font-bold font-mono w-12 text-right">
                                                {user.workedHours.toFixed(1)}h
                                            </span>
                                            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden relative">
                                                <div
                                                    className="absolute top-0 left-0 h-full bg-green-500 rounded-full"
                                                    style={{ width: `${(user.workedHours / combinedStats.max) * 100}%` }}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// Helper Component for Active Session Row to manage own timer
function ActiveSessionRow({ session }) {
    const [durationStr, setDurationStr] = useState('');

    useEffect(() => {
        const updateTime = () => {
            if (!session.startTime) {
                setDurationStr('');
                return;
            }
            const start = new Date(session.startTime);
            const now = getLithuanianNow();
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
        // Align to minute boundary for better UX? Or just simple interval.
        // Simple interval is fine for "once a minute" requirement.
        const interval = setInterval(updateTime, 60000);

        return () => clearInterval(interval);
    }, [session.startTime]);

    return (
        <div className={`p-3 rounded-lg flex items-center justify-between shadow-sm transition-all ${session.colorClass}`}>
            <div className="flex items-center gap-3 overflow-hidden">
                <div
                    className="w-2 h-2 rounded-full flex-shrink-0 bg-current opacity-50"
                    // Fallback if needed, but usually bg-current works with text color logic or just use user color
                    style={{ backgroundColor: session.userColor || 'currentColor' }}
                />
                <span className="font-semibold text-sm truncate">
                    {session.userName}
                </span>
                <span className="text-sm border-l border-current/20 pl-3 truncate opacity-90">
                    {session.label}
                </span>
            </div>
            <span className="font-mono font-bold text-sm ml-4 whitespace-nowrap opacity-80">
                {durationStr}
            </span>
        </div>
    );
}
