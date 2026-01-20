import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot } from 'firebase/firestore';
import { Users, ChevronDown, ChevronUp, Briefcase } from 'lucide-react';
import { startOfWeek, endOfWeek, addDays } from 'date-fns';

export default function CombinedHoursSummary() {
    const [users, setUsers] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [workHours, setWorkHours] = useState([]);
    const [workSessions, setWorkSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [isCollapsed, setIsCollapsed] = useState(true);

    useEffect(() => {
        setLoading(true);

        const now = new Date();
        const day = now.getDay(); // 0=Sun, 6=Sat
        const hours = now.getHours();
        const minutes = now.getMinutes();

        // Custom Week Logic: Reset at Saturday 18:30
        let targetDate = now;
        // If it's Saturday > 18:30 OR Sunday, we show the next week (starting Monday)
        if ((day === 6 && (hours > 18 || (hours === 18 && minutes >= 30))) || day === 0) {
            // Move to next Monday
            if (day === 6) targetDate = addDays(now, 2);
            else if (day === 0) targetDate = addDays(now, 1);
        }

        // Standard week starts Monday
        const weekStart = startOfWeek(targetDate, { weekStartsOn: 1 });
        const weekEnd = endOfWeek(targetDate, { weekStartsOn: 1 });

        // 1. Listen to Users
        const unsubUsers = onSnapshot(collection(db, 'users'), (snap) => {
            const usersData = snap.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(u => !u.isDisabled);
            setUsers(usersData);
            setLoading(false);
        });

        // 2. Listen to Tasks (Active)
        let activeTasks = [];
        let archivedTasks = [];
        const updateAllTasks = () => {
            setTasks([...activeTasks, ...archivedTasks]);
        };

        const unsubActive = onSnapshot(collection(db, 'tasks'), (snap) => {
            activeTasks = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            updateAllTasks();
        });

        const unsubArchived = onSnapshot(collection(db, 'archived_tasks'), (snap) => {
            archivedTasks = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            updateAllTasks();
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

        // 4. Listen to Work Sessions (Actual Worked Time)
        const unsubSessions = onSnapshot(collection(db, 'work_sessions'), (snapshot) => {
            const sessionsData = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(s => {
                    const start = new Date(s.startTime);
                    return start >= weekStart && start <= weekEnd;
                });
            setWorkSessions(sessionsData);
        });

        return () => {
            unsubUsers();
            unsubActive();
            unsubArchived();
            unsubWorkHours();
            unsubSessions();
        };
    }, []);

    // Calculate stats
    const combinedStats = useMemo(() => {
        const stats = [];
        let maxVal = 0;

        users.forEach(user => {
            let plannedHours = 0;
            let workedMinutes = 0;

            // Calculate weekly scheduled hours (Calendar)
            workHours.forEach(wh => {
                if (wh.userId === user.id) {
                    const start = new Date(wh.start);
                    const end = new Date(wh.end);
                    const duration = (end - start) / (1000 * 60 * 60);
                    plannedHours += duration;
                }
            });

            // Calculate weekly actual worked minutes
            // 1. From Sessions
            workSessions.forEach(session => {
                if (session.workerId === user.id) {
                    workedMinutes += (session.durationMinutes || 0);
                }
            });

            // 2. From Tasks (Quick Work / Calls - Manual Minutes)
            // Filter tasks for this user AND completed/archived within this week
            // Note: We need to filter `tasks` state which contains both active and archived
            tasks.forEach(t => {
                const isAssigned = t.assignedWorkerId === user.id;
                const hasManual = t.manualMinutes && t.manualMinutes > 0;

                if (isAssigned && hasManual) {
                    const compDate = t.completedAt ? new Date(t.completedAt) : (t.archivedAt ? new Date(t.archivedAt) : null);
                    // Check if date falls within weekStart and weekEnd
                    // Note: weekStart and weekEnd are defined in scope above, we need to pass them or rely on closure
                    // weekStart/weekEnd are in useEffect scope. We need them in useMemo.
                    // Actually, weekStart/weekEnd are calculated inside useEffect and used for querying only.
                    // We need to recalculate them or store them in state to use here correctly.

                    // QUICK FIX: Since we filter queries by weekStart/weekEnd, `workSessions` are already filtered.
                    // BUT `tasks` are NOT filtered by date in the listener (we fetch all active and archived? No, fetch ALL).
                    // We fetch ALL tasks in collection? `onSnapshot(collection(db, 'tasks'))`. Yes.
                    // So we MUST check the date here.

                    // We need week range here.
                    // To avoid complexity, we can re-calculate week range inside this loop or move calculation out.
                    // Let's deduce if it fits.
                }
            });
            // ... Actually, I need to properly filter by date.
            // Let's refactor useMemo to include date checking.

            // Re-calc week boundaries for filtering inside useMemo
            // We assume 'targetDate' from useEffect logic is roughly 'now' or 'next week' logic.
            // For simplicity in this display component, let's use the same logic:

            const now = new Date();
            const day = now.getDay();
            const hours = now.getHours();
            const minutes = now.getMinutes();
            let targetDate = now;
            if ((day === 6 && (hours > 18 || (hours === 18 && minutes >= 30))) || day === 0) {
                if (day === 6) targetDate = addDays(now, 2);
                else if (day === 0) targetDate = addDays(now, 1);
            }
            const wStart = startOfWeek(targetDate, { weekStartsOn: 1 });
            const wEnd = endOfWeek(targetDate, { weekStartsOn: 1 });

            tasks.forEach(t => {
                if (t.assignedWorkerId === user.id && t.manualMinutes > 0) {
                    const compDate = t.completedAt ? new Date(t.completedAt) : (t.archivedAt ? new Date(t.archivedAt) : null);
                    if (compDate && compDate >= wStart && compDate <= wEnd) {
                        workedMinutes += t.manualMinutes;
                    }
                }
            });

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
    }, [users, workHours, workSessions, tasks]);

    if (loading) return null;
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
                <div className="p-4 space-y-4">
                    {combinedStats.data.length === 0 ? (
                        <p className="text-gray-500 text-sm italic">Nėra duomenų.</p>
                    ) : (
                        combinedStats.data.map(user => (
                            <div key={user.id} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
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
            )}
        </div>
    );
}
