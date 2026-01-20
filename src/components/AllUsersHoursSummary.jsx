import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot, getDocs } from 'firebase/firestore';
import { Users, Clock } from 'lucide-react';
import { startOfWeek, endOfWeek } from 'date-fns';
import { parseTimeToHours } from '../utils/formatters';

export default function AllUsersHoursSummary() {
    const [userHours, setUserHours] = useState([]);
    const [error, setError] = useState('');

    useEffect(() => {
        const fetchAllUserHours = async () => {
            try {
                // Get current week range (Sunday to Saturday)
                const now = new Date();
                const weekStart = startOfWeek(now, { weekStartsOn: 0 });
                const weekEnd = endOfWeek(now, { weekStartsOn: 0 });

                // Fetch all work hours (no date filtering to avoid index issues)
                const workHoursQuery = query(collection(db, 'work_hours'));

                const unsubscribeWorkHours = onSnapshot(workHoursQuery, async (workHoursSnap) => {
                    try {
                        // Fetch tasks for task duration calculation
                        const tasksSnap = await getDocs(collection(db, 'tasks'));

                        // Group work hours by user, filtering for current week client-side
                        const hoursByUser = {};
                        workHoursSnap.docs.forEach(doc => {
                            try {
                                const data = doc.data();
                                const start = new Date(data.start);

                                if (!isNaN(start.getTime()) && start >= weekStart && start <= weekEnd) {
                                    const userId = data.userId;
                                    const end = new Date(data.end);

                                    if (!isNaN(end.getTime())) {
                                        const durationHours = (end - start) / (1000 * 60 * 60);

                                        if (Number.isFinite(durationHours) && durationHours >= 0) {
                                            if (!hoursByUser[userId]) {
                                                hoursByUser[userId] = { workHours: 0, taskDuration: 0 };
                                            }
                                            hoursByUser[userId].workHours += durationHours;
                                        }
                                    }
                                }
                            } catch (error) {
                                console.warn('Error processing work hour entry:', doc.id, error);
                            }
                        });

                        // Calculate task duration by user for current week
                        const dayMap = {
                            0: 'Sekmadienis',
                            1: 'Pirmadienis',
                            2: 'Antradienis',
                            3: 'Trečiadienis',
                            4: 'Ketvirtadienis',
                            5: 'Penktadienis',
                            6: 'Šeštadienis'
                        };

                        tasksSnap.docs.forEach(doc => {
                            try {
                                const task = doc.data();
                                if (task.assignedWorkerId && task.estimatedTime) {
                                    const hours = parseTimeToHours(task.estimatedTime);

                                    if (hours > 0) { // Already validated in parseTimeToHours
                                        if (!hoursByUser[task.assignedWorkerId]) {
                                            hoursByUser[task.assignedWorkerId] = { workHours: 0, taskDuration: 0 };
                                        }
                                        hoursByUser[task.assignedWorkerId].taskDuration += hours;
                                    }
                                }
                            } catch (error) {
                                console.warn('Error processing task for hours:', doc.id, error);
                            }
                        });

                        // Fetch user details
                        const usersSnapshot = await getDocs(collection(db, 'users'));
                        const usersMap = {};
                        usersSnapshot.docs.forEach(doc => {
                            usersMap[doc.id] = doc.data();
                        });

                        // Combine user info with hours
                        const userHoursArray = Object.entries(hoursByUser).map(([userId, data]) => ({
                            userId,
                            displayName: usersMap[userId]?.displayName || 'Nežinomas',
                            email: usersMap[userId]?.email || '',
                            workHours: data.workHours,
                            taskDuration: data.taskDuration,
                        }));

                        // Sort by work hours descending
                        userHoursArray.sort((a, b) => b.workHours - a.workHours);

                        setUserHours(userHoursArray);
                        setError('');
                    } catch (err) {
                        console.error("Error processing data:", err);
                        setError("Klaida apdorojant duomenis.");
                    }
                }, (err) => {
                    console.error("Error fetching all users hours:", err);
                    setError("Nepavyko užkrauti vartotojų valandų.");
                });

                return unsubscribeWorkHours;
            } catch (err) {
                console.error("Error setting up listener:", err);
                setError("Įvyko klaida.");
            }
        };

        const unsubscribe = fetchAllUserHours();
        return () => {
            if (unsubscribe && typeof unsubscribe.then === 'function') {
                unsubscribe.then(unsub => unsub && unsub());
            }
        };
    }, []);

    // Helper function to parse time strings to hours
    const parseTimeToHours = (timeStr) => {
        if (!timeStr) return 0;

        let totalHours = 0;
        const str = timeStr.toLowerCase().trim();

        // Match patterns like "2h", "1.5h", "90m", "1h 30m"
        const hourMatch = str.match(/(\d+\.?\d*)\s*h/);
        const minMatch = str.match(/(\d+)\s*m/);

        if (hourMatch) {
            totalHours += parseFloat(hourMatch[1]);
        }
        if (minMatch) {
            totalHours += parseInt(minMatch[1]) / 60;
        }

        return totalHours;
    };

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
                <Users className="w-5 h-5 text-blue-600" />
                <h3 className="text-lg font-semibold text-gray-900">Vartotojų savaitės suvestinė</h3>
            </div>

            {error && (
                <div className="bg-red-50 border-l-4 border-red-500 p-4 mb-4">
                    <p className="text-sm text-red-700">{error}</p>
                </div>
            )}

            {userHours.length === 0 ? (
                <p className="text-gray-500 text-sm">Šią savaitę nėra užregistruotų valandų.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Vartotojas
                                </th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Darbo valandos
                                </th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Užduočių trukmė
                                </th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {userHours.map((user) => (
                                <tr key={user.userId} className="hover:bg-gray-50">
                                    <td className="px-4 py-3">
                                        <div className="text-sm font-medium text-gray-900">{user.displayName}</div>
                                        <div className="text-xs text-gray-500">{user.email}</div>
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        <div className="flex items-center justify-end gap-1">
                                            <Clock className="w-4 h-4 text-blue-400" />
                                            <span className="text-sm font-semibold text-blue-900">
                                                {user.workHours ? user.workHours.toFixed(1) : '0.0'} val.
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        <div className="flex items-center justify-end gap-1">
                                            <Clock className="w-4 h-4 text-purple-400" />
                                            <span className="text-sm font-semibold text-purple-900">
                                                {user.taskDuration ? user.taskDuration.toFixed(1) : '0.0'} val.
                                            </span>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
