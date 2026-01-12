import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot, getDocs } from 'firebase/firestore';
import { Users, Clock, AlertTriangle } from 'lucide-react';
import { startOfWeek, endOfWeek } from 'date-fns';

export default function CombinedHoursSummary() {
    const [users, setUsers] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [workHours, setWorkHours] = useState([]);
    const [workSessions, setWorkSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const dayNames = ['Pirmadienis', 'Antradienis', 'Trečiadienis', 'Ketvirtadienis', 'Penktadienis', 'Šeštadienis', 'Sekmadienis'];
    const dayAbbr = ['Pir', 'Ant', 'Tre', 'Ket', 'Pen', 'Šeš', 'Sek'];

    useEffect(() => {
        setLoading(true);

        const now = new Date();
        const weekStart = startOfWeek(now, { weekStartsOn: 0 });
        const weekEnd = endOfWeek(now, { weekStartsOn: 0 });

        // 1. Listen to Users
        const unsubUsers = onSnapshot(collection(db, 'users'), (snap) => {
            const usersData = snap.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(u => !u.isDisabled); // Filter out blocked users
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

        // 4. Listen to Work Hours
        const workHoursQuery = query(collection(db, 'work_hours'));
        const unsubWorkHours = onSnapshot(workHoursQuery, (snapshot) => {
            const hoursData = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(wh => {
                    const start = new Date(wh.start);
                    return start >= weekStart && start <= weekEnd;
                });
            setWorkHours(hoursData);
        }, (err) => {
            console.error('Error fetching work hours:', err);
            setError('Nepavyko užkrauti duomenų');
        });

        // 5. Listen to Work Sessions (Actual task time)
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
                weeklyActualMinutes: 0
            };

            // Calculate weekly work hours from work_hours collection
            workHours.forEach(wh => {
                if (wh.userId === user.id) {
                    const start = new Date(wh.start);
                    const end = new Date(wh.end);
                    const durationHours = (end - start) / (1000 * 60 * 60);

                    // Add to weekly total
                    stats[user.id].weeklyWorkHours += durationHours;
                }
            });

            // Calculate weekly task planning
            tasks.forEach(task => {
                if (task.assignedWorkerId === user.id && task.estimatedTime) {
                    const hours = parseTimeToHours(task.estimatedTime);
                    stats[user.id].weeklyTaskDuration += hours;
                }
            });

            // Calculate weekly actual sessions
            workSessions.forEach(session => {
                if (session.workerId === user.id) {
                    stats[user.id].weeklyActualMinutes += (session.durationMinutes || 0);
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
                <p className="text-xs text-gray-500 mt-1">Savaitės darbo valandos ir užduočių trukmė</p>
            </div>

            <div className="overflow-x-auto">
                {/* Changed to w-auto to shrink columns to content, keeping them close to names */}
                <table className="w-auto divide-y divide-gray-200">
                    <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider sticky left-0 bg-gray-50 z-10 w-[200px]">
                                Vartotojas
                            </th>
                            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[120px]">
                                <div className="flex items-center justify-start gap-1">
                                    <Clock className="w-3 h-3" />
                                    <span>Darbo val.</span>
                                </div>
                            </th>
                            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[120px]">
                                <div className="flex items-center justify-start gap-1">
                                    <Clock className="w-3 h-3" />
                                    <span>Planuota u.</span>
                                </div>
                            </th>
                            <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-[120px]">
                                <div className="flex items-center justify-start gap-1">
                                    <Clock className="w-3 h-3 text-green-600" />
                                    <span>Faktinė u.</span>
                                </div>
                            </th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {Object.entries(combinedStats).map(([userId, userData]) => (
                            <tr key={userId} className="hover:bg-gray-50">
                                <td className="px-4 py-3 whitespace-nowrap sticky left-0 bg-white border-r border-gray-100 max-w-[200px]">
                                    <div className="flex items-center gap-2">
                                        <div
                                            className="w-3 h-3 rounded-full flex-shrink-0"
                                            style={{ backgroundColor: userData.color }}
                                        />
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium text-gray-900 truncate">
                                                {userData.name}
                                            </div>
                                            <div className="text-xs text-gray-500 truncate">
                                                {userData.email}
                                            </div>
                                        </div>
                                    </div>
                                </td>
                                <td className="px-3 py-3 text-left whitespace-nowrap">
                                    <span className="text-sm font-semibold text-blue-900">
                                        {userData.weeklyWorkHours.toFixed(1)}h
                                    </span>
                                </td>
                                <td className="px-3 py-3 text-left whitespace-nowrap">
                                    <span className="text-sm font-semibold text-purple-900">
                                        {userData.weeklyTaskDuration.toFixed(1)}h
                                    </span>
                                </td>
                                <td className="px-3 py-3 text-left whitespace-nowrap">
                                    <span className="text-sm font-bold text-green-700">
                                        {(userData.weeklyActualMinutes / 60).toFixed(1)}h
                                    </span>
                                </td>
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
