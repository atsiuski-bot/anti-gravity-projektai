import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot, getDocs } from 'firebase/firestore';
import { Users, Clock, AlertTriangle } from 'lucide-react';
import { startOfWeek, endOfWeek } from 'date-fns';

export default function CombinedHoursSummary() {
    const [users, setUsers] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [workHours, setWorkHours] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const dayNames = ['Pirmadienis', 'Antradienis', 'Trečiadienis', 'Ketvirtadienis', 'Penktadienis', 'Šeštadienis', 'Sekmadienis'];
    const dayAbbr = ['Pir', 'Ant', 'Tre', 'Ket', 'Pen', 'Šeš', 'Sek'];

    useEffect(() => {
        const fetchData = async () => {
            try {
                // Get current week range
                const now = new Date();
                const weekStart = startOfWeek(now, { weekStartsOn: 0 });
                const weekEnd = endOfWeek(now, { weekStartsOn: 0 });

                // Fetch users
                const usersSnap = await getDocs(collection(db, 'users'));
                const usersData = usersSnap.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));
                setUsers(usersData);

                // Fetch tasks
                const tasksSnap = await getDocs(collection(db, 'tasks'));
                const tasksData = tasksSnap.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));
                setTasks(tasksData);

                // Subscribe to work hours
                const workHoursQuery = query(collection(db, 'work_hours'));
                const unsubscribe = onSnapshot(workHoursQuery, (snapshot) => {
                    const hoursData = snapshot.docs
                        .map(doc => ({ id: doc.id, ...doc.data() }))
                        .filter(wh => {
                            const start = new Date(wh.start);
                            return start >= weekStart && start <= weekEnd;
                        });
                    setWorkHours(hoursData);
                    setLoading(false);
                });

                return unsubscribe;
            } catch (err) {
                console.error('Error fetching data:', err);
                setError('Nepavyko užkrauti duomenų');
                setLoading(false);
            }
        };

        const unsubscribe = fetchData();
        return () => {
            if (unsubscribe && typeof unsubscribe.then === 'function') {
                unsubscribe.then(unsub => unsub && unsub());
            }
        };
    }, []);

    // Parse time string to hours
    const parseTimeToHours = (timeStr) => {
        if (!timeStr) return 0;
        let hours = 0;
        const hourMatch = timeStr.match(/(\d+\.?\d*)\s*h/);
        const minMatch = timeStr.match(/(\d+)\s*m/);
        if (hourMatch) hours += parseFloat(hourMatch[1]);
        if (minMatch) hours += parseInt(minMatch[1]) / 60;
        return hours;
    };

    // Calculate combined stats
    const combinedStats = useMemo(() => {
        const stats = {};

        users.forEach(user => {
            stats[user.id] = {
                name: user.displayName || user.email,
                email: user.email,
                color: user.color || '#3b82f6',
                weeklyWorkHours: 0,
                weeklyTaskDuration: 0,
                days: {}
            };

            // Initialize days
            dayNames.forEach(day => {
                stats[user.id].days[day] = {
                    calendarHours: 0,  // Planned hours from calendar
                    taskHours: 0       // Planned hours from tasks
                };
            });

            // Calculate weekly work hours and daily calendar hours from work_hours collection
            workHours.forEach(wh => {
                if (wh.userId === user.id) {
                    const start = new Date(wh.start);
                    const end = new Date(wh.end);
                    const durationHours = (end - start) / (1000 * 60 * 60);

                    // Add to weekly total
                    stats[user.id].weeklyWorkHours += durationHours;

                    // Add to daily calendar hours
                    const dayOfWeek = start.getDay(); // 0 = Sunday, 1 = Monday, etc.
                    const dayMap = {
                        0: 'Sekmadienis',
                        1: 'Pirmadienis',
                        2: 'Antradienis',
                        3: 'Trečiadienis',
                        4: 'Ketvirtadienis',
                        5: 'Penktadienis',
                        6: 'Šeštadienis'
                    };
                    const dayName = dayMap[dayOfWeek];
                    if (dayName && stats[user.id].days[dayName]) {
                        stats[user.id].days[dayName].calendarHours += durationHours;
                    }
                }
            });

            // Calculate task planning
            tasks.forEach(task => {
                if (task.assignedWorkerId === user.id && task.estimatedTime) {
                    const hours = parseTimeToHours(task.estimatedTime);
                    stats[user.id].weeklyTaskDuration += hours;

                    // Add to daily task hours if day is specified
                    if (task.dayOfWeek && stats[user.id].days[task.dayOfWeek] !== undefined) {
                        stats[user.id].days[task.dayOfWeek].taskHours += hours;
                    }
                }
            });
        });

        return stats;
    }, [users, tasks, workHours]);

    if (loading) {
        return (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
                <div className="flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-red-50 border-l-4 border-red-500 p-4 mb-6">
                <p className="text-sm text-red-700">{error}</p>
            </div>
        );
    }

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-6">
            <div className="p-4 border-b border-gray-200 bg-gray-50">
                <div className="flex items-center gap-2">
                    <Users className="w-5 h-5 text-blue-600" />
                    <h3 className="font-semibold text-gray-900">Vartotojų valandų suvestinė</h3>
                </div>
                <p className="text-xs text-gray-500 mt-1">Savaitės darbo valandos, užduočių trukmė ir dienų planavimas (kalendorius+užduotys)</p>
            </div>

            <div className="overflow-x-auto">
                <table className="min-w-full">
                    <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider sticky left-0 bg-gray-50 z-10">
                                Vartotojas
                            </th>
                            <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                <div className="flex items-center justify-end gap-1">
                                    <Clock className="w-3 h-3" />
                                    <span>Darbo val.</span>
                                </div>
                            </th>
                            <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                <div className="flex items-center justify-end gap-1">
                                    <Clock className="w-3 h-3" />
                                    <span>Užd. val.</span>
                                </div>
                            </th>
                            {dayAbbr.map((day, idx) => (
                                <th key={idx} className="px-2 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    <div className="hidden lg:block">{dayNames[idx]}</div>
                                    <div className="lg:hidden">{day}</div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {Object.entries(combinedStats).map(([userId, userData]) => (
                            <tr key={userId} className="hover:bg-gray-50">
                                <td className="px-4 py-3 whitespace-nowrap sticky left-0 bg-white">
                                    <div className="flex items-center gap-2">
                                        <div
                                            className="w-3 h-3 rounded-full flex-shrink-0"
                                            style={{ backgroundColor: userData.color }}
                                        />
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium text-gray-900 truncate max-w-[150px]">
                                                {userData.name}
                                            </div>
                                            <div className="text-xs text-gray-500 truncate max-w-[150px]">
                                                {userData.email}
                                            </div>
                                        </div>
                                    </div>
                                </td>
                                <td className="px-3 py-3 text-right whitespace-nowrap">
                                    <div className="flex items-center justify-end gap-1">
                                        <span className="text-sm font-semibold text-blue-900">
                                            {userData.weeklyWorkHours.toFixed(1)}h
                                        </span>
                                    </div>
                                </td>
                                <td className="px-3 py-3 text-right whitespace-nowrap">
                                    <div className="flex items-center justify-end gap-1">
                                        <span className="text-sm font-semibold text-purple-900">
                                            {userData.weeklyTaskDuration.toFixed(1)}h
                                        </span>
                                    </div>
                                </td>
                                {dayNames.map((day, idx) => {
                                    const dayData = userData.days[day];
                                    const totalPlanned = dayData.calendarHours + dayData.taskHours;
                                    const showWarning = dayData.taskHours > dayData.calendarHours && dayData.calendarHours > 0;

                                    return (
                                        <td key={idx} className="px-2 py-3 whitespace-nowrap text-center">
                                            {totalPlanned > 0 ? (
                                                <div className={`text-xs font-medium ${showWarning ? 'text-orange-600' : 'text-gray-700'}`}>
                                                    <div className="flex items-center justify-center gap-1">
                                                        {showWarning && <AlertTriangle className="w-3 h-3 flex-shrink-0" />}
                                                        <span className="whitespace-nowrap">
                                                            {dayData.calendarHours.toFixed(1)}+{dayData.taskHours.toFixed(1)}
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

            {Object.keys(combinedStats).length === 0 && (
                <div className="p-8 text-center text-gray-500">
                    Nėra vartotojų duomenų
                </div>
            )}
        </div>
    );
}
