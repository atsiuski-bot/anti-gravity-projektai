import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, getDocs } from 'firebase/firestore';
import { Clock, AlertTriangle } from 'lucide-react';

export default function DailyHoursSummary() {
    const [users, setUsers] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);

    const dayNames = ['Pirmadienis', 'Antradienis', 'Trečiadienis', 'Ketvirtadienis', 'Penktadienis', 'Šeštadienis', 'Sekmadienis'];
    const dayAbbr = ['Pir', 'Ant', 'Tre', 'Ket', 'Pen', 'Šeš', 'Sek'];

    useEffect(() => {
        const fetchData = async () => {
            try {
                const [usersSnapshot, tasksSnapshot] = await Promise.all([
                    getDocs(collection(db, 'users')),
                    getDocs(collection(db, 'tasks'))
                ]);

                const usersData = usersSnapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));

                const tasksData = tasksSnapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));

                setUsers(usersData);
                setTasks(tasksData);
            } catch (error) {
                console.error('Error fetching data:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, []);

    // Parse time string to hours (e.g., "2h 30m" -> 2.5)
    const parseTimeToHours = (timeStr) => {
        if (!timeStr) return 0;
        let hours = 0;
        const hourMatch = timeStr.match(/(\d+\.?\d*)\s*h/);
        const minMatch = timeStr.match(/(\d+)\s*m/);
        if (hourMatch) hours += parseFloat(hourMatch[1]);
        if (minMatch) hours += parseInt(minMatch[1]) / 60;
        return hours;
    };

    // Calculate daily stats for each user
    const dailyStats = useMemo(() => {
        const stats = {};

        users.forEach(user => {
            stats[user.id] = {
                name: user.displayName || user.email,
                color: user.color || '#3b82f6',
                days: {}
            };

            // Initialize all days
            dayNames.forEach(day => {
                stats[user.id].days[day] = {
                    available: 0,
                    planned: 0
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

            // Add planned hours from tasks
            tasks.forEach(task => {
                if (task.assignedWorkerId === user.id && task.dayOfWeek && stats[user.id].days[task.dayOfWeek] !== undefined) {
                    stats[user.id].days[task.dayOfWeek].planned += parseTimeToHours(task.estimatedTime);
                }
            });
        });

        return stats;
    }, [users, tasks]);

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
                <p className="text-xs text-gray-500 mt-1">Planuotos / Galimos valandos kiekvienai dienai</p>
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
                                                            {dayData.planned.toFixed(1)}h / {dayData.available.toFixed(1)}h
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
