import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { startOfWeek, endOfWeek } from 'date-fns';
import { Clock, AlertTriangle } from 'lucide-react';
import { formatDisplayName, parseTimeToHours } from '../utils/formatters';

export default function DailyHoursSummary() {
    const [users, setUsers] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [workSessions, setWorkSessions] = useState([]);
    const [loading, setLoading] = useState(true);

    const dayNames = ['Pirmadienis', 'Antradienis', 'Trečiadienis', 'Ketvirtadienis', 'Penktadienis', 'Šeštadienis', 'Sekmadienis'];
    const dayAbbr = ['Pir', 'Ant', 'Tre', 'Ket', 'Pen', 'Šeš', 'Sek'];

    useEffect(() => {
        setLoading(true);

        // 1. Listen to Users
        const unsubUsers = onSnapshot(collection(db, 'users'), (snap) => {
            const usersData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setUsers(usersData);
            setLoading(false);
        });

        // 2. Listen to Tasks (Active)
        let activeTasks = [];
        // 3. Listen to Archived Tasks
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

        // 4. Listen to Work Sessions (Actual task time)
        const unsubSessions = onSnapshot(collection(db, 'work_sessions'), (snap) => {
            setWorkSessions(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        });

        return () => {
            unsubUsers();
            unsubActive();
            unsubArchived();
            unsubSessions();
        };
    }, []);

    // Calculate daily stats for each user
    const dailyStats = useMemo(() => {
        const stats = {};

        // Calculate current week range
        // Note: Using ISO string comparison for simple date matching
        const now = new Date();
        const currentParams = { weekStartsOn: 1 };
        // We want to filter for the CURRENT week, matching the column headers Monday-Sunday
        const weekStart = startOfWeek(now, currentParams);
        const weekEnd = endOfWeek(now, currentParams);

        users.forEach(user => {
            stats[user.id] = {
                name: formatDisplayName(user.displayName) || user.email,
                color: user.color || '#3b82f6',
                days: {}
            };

            // Initialize all days
            dayNames.forEach(day => {
                stats[user.id].days[day] = {
                    available: 0,
                    planned: 0,
                    actual: 0
                };
            });

            // Add available hours from work_hours
            if (user.work_hours && Array.isArray(user.work_hours)) {
                user.work_hours.forEach(wh => {
                    if (wh.dayOfWeek && stats[user.id].days[wh.dayOfWeek] !== undefined) {
                        stats[user.id].days[wh.dayOfWeek].available = parseTimeToHours(wh.hours);
                    }
                });
            }

            // A helper to check if a date is in the current week
            const isInCurrentWeek = (dateObj) => {
                return dateObj >= weekStart && dateObj <= weekEnd;
            };

            // Add planned hours from tasks (ONLY if task is scheduled for this week OR generally? 
            // Usually planned tasks are recurring or just per weekday. 
            // The existing logic seemed to just check dayOfWeek property. 
            // If tasks are specific instances, we should check date. 
            // However, the issue described was regarding "Worked" hours (actual).
            // Let's keep planned logic as is for now unless requested, as it seems to rely on "recurring" logic possibly?)
            // Actually, tasks.dayOfWeek implies recurring or specific day planning. 
            // Let's focus on fixing ACTUAL hours first which is the main bug.

            tasks.forEach(task => {
                if (task.assignedWorkerId === user.id && task.dayOfWeek && stats[user.id].days[task.dayOfWeek] !== undefined) {
                    // Start fix: If task has a specific date, ensuring it matches this week?
                    // Currently tasks with dayOfWeek might be recurring or specific. 
                    // Assuming recurring/general for now as 'planned'.
                    stats[user.id].days[task.dayOfWeek].planned += parseTimeToHours(task.estimatedTime);
                }
            });

            // Add actual hours from work_sessions (FILTERED BY CURRENT WEEK)
            workSessions.forEach(session => {
                try {
                    if (session.workerId === user.id && session.date) {
                        const sessionDate = new Date(session.date);

                        // CRITICAL FIX: Filter by current week
                        if (!isNaN(sessionDate.getTime()) && isInCurrentWeek(sessionDate)) {
                            // Map session date to day name
                            const dayName = dayNames[sessionDate.getDay() === 0 ? 6 : sessionDate.getDay() - 1];
                            // Note: getDay() 0=Sun. Our dayNames array: 0=Mon, ... 6=Sun.
                            // Need to map correctly. 
                            // dayNames index: 0->Mon(1), 1->Tue(2)... 5->Sat(6), 6->Sun(0)

                            let mappedDayName = '';
                            const dayNum = sessionDate.getDay();
                            if (dayNum === 0) mappedDayName = 'Sekmadienis';
                            else if (dayNum === 1) mappedDayName = 'Pirmadienis';
                            else if (dayNum === 2) mappedDayName = 'Antradienis';
                            else if (dayNum === 3) mappedDayName = 'Trečiadienis';
                            else if (dayNum === 4) mappedDayName = 'Ketvirtadienis';
                            else if (dayNum === 5) mappedDayName = 'Penktadienis';
                            else if (dayNum === 6) mappedDayName = 'Šeštadienis';

                            if (stats[user.id].days[mappedDayName]) {
                                const durationHours = (session.durationMinutes || 0) / 60;
                                if (Number.isFinite(durationHours) && durationHours >= 0) {
                                    stats[user.id].days[mappedDayName].actual += durationHours;
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.warn('Error processing work session:', session.id, error);
                }
            });
        });

        return stats;
    }, [users, tasks, workSessions]);

    if (loading) {
        return (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
                <div className="flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-6">
            <div className="p-4 border-b border-gray-200 bg-gray-50">
                <div className="flex items-center gap-2">
                    <Clock className="w-5 h-5 text-blue-600" />
                    <h3 className="font-semibold text-gray-900">Dienos valandos pagal vartotoją</h3>
                </div>
                <p className="text-xs text-gray-500 mt-1">Planuotos / Faktinės / Galimos valandos kiekvienai dienai</p>
            </div>

            <div className="overflow-x-auto">
                <table className="min-w-full">
                    <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider sticky left-0 bg-gray-50 z-10">
                                Vartotojas
                            </th>
                            {dayAbbr.map((day, idx) => (
                                <th key={idx} className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    <div className="hidden sm:block">{dayNames[idx]}</div>
                                    <div className="sm:hidden">{day}</div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {Object.entries(dailyStats).map(([userId, userData]) => (
                            <tr key={userId} className="hover:bg-gray-50">
                                <td className="px-4 py-3 whitespace-nowrap sticky left-0 bg-white">
                                    <div className="flex items-center gap-2">
                                        <div
                                            className="w-3 h-3 rounded-full flex-shrink-0"
                                            style={{ backgroundColor: userData.color }}
                                        />
                                        <span className="text-sm font-medium text-gray-900 truncate max-w-[120px]">
                                            {userData.name}
                                        </span>
                                    </div>
                                </td>
                                {dayNames.map((day, idx) => {
                                    const dayData = userData.days[day];
                                    const isOverbooked = dayData.planned > dayData.available && dayData.available > 0;

                                    return (
                                        <td key={idx} className="px-3 py-3 whitespace-nowrap text-center">
                                            {dayData.available > 0 || dayData.planned > 0 ? (
                                                <div className={`text-xs font-medium ${isOverbooked ? 'text-red-600' : 'text-gray-700'}`}>
                                                    <div className="flex items-center justify-center gap-1">
                                                        {isOverbooked && <AlertTriangle className="w-3 h-3" />}
                                                        <span>
                                                            {dayData.planned.toFixed(1)} / <span className="text-green-600 font-bold">{dayData.actual.toFixed(1)}</span> / {dayData.available.toFixed(1)}h
                                                        </span>
                                                    </div>
                                                </div>
                                            ) : (
                                                <span className="text-xs text-gray-400">-</span>
                                            )}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {Object.keys(dailyStats).length === 0 && (
                <div className="p-8 text-center text-gray-500">
                    Nėra vartotojų su darbo valandomis
                </div>
            )}
        </div>
    );
}
