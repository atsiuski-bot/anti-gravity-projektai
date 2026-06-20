import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot } from 'firebase/firestore';
import { Calendar, ChevronDown, ChevronUp, Clock } from 'lucide-react';
import { formatDisplayName } from '../utils/formatters';
import { formatMinutesToTimeString } from '../utils/timeUtils';

export default function MonthlyHours({ users }) {
    const [sessions, setSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isCollapsed, setIsCollapsed] = useState(true);
    const [expandedMonth, setExpandedMonth] = useState(null);

    useEffect(() => {
        setLoading(true);
        // We listen to ALL work_sessions. 
        // In a large production app, this should probably be a backend aggregation or 
        // limited by date (e.g., last 12 months).
        // Since we want robust calculation of history, we fetch all.
        const q = query(collection(db, 'work_sessions'));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const data = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(session => !session.isDeleted);
            setSessions(data);
            setLoading(false);
        }, (error) => {
            console.error("MonthlyHours: Error fetching sessions:", error);
            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    const monthlyStats = useMemo(() => {
        const stats = {};

        sessions.forEach(session => {
            if (!session.startTime) return;

            // Extract Year-Month from startTime (safest) or date field
            const dateObj = new Date(session.startTime);
            if (isNaN(dateObj.getTime())) return;

            const year = dateObj.getFullYear();
            const month = String(dateObj.getMonth() + 1).padStart(2, '0');
            const key = `${year}-${month}`;

            if (!stats[key]) {
                stats[key] = {
                    monthKey: key,
                    totalMinutes: 0,
                    users: {}
                };
            }

            const uid = session.userId;
            // Filter out invalid duration
            const duration = Number(session.durationMinutes) || 0;

            stats[key].totalMinutes += duration;

            if (!stats[key].users[uid]) {
                // Try to find user info from props
                const user = users.find(u => u.id === uid);
                stats[key].users[uid] = {
                    userId: uid,
                    name: user ? (user.displayName || user.email) : (session.userName || 'Nežinomas'),
                    minutes: 0
                };
            }
            stats[key].users[uid].minutes += duration;
        });

        // Convert to array and sort descending (newest month first)
        return Object.values(stats)
            .sort((a, b) => b.monthKey.localeCompare(a.monthKey));

    }, [sessions, users]);

    if (loading) return <div className="p-4 text-center text-gray-500">Kraunami duomenys...</div>;

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-6">
            <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-indigo-600" />
                    <h3 className="font-semibold text-gray-900">Mėnesinė komandos ataskaita</h3>
                </div>
                {isCollapsed ? <ChevronDown className="w-5 h-5 text-gray-500" /> : <ChevronUp className="w-5 h-5 text-gray-500" />}
            </button>

            {!isCollapsed && (
                <div className="border-t border-gray-200">
                    {monthlyStats.length === 0 ? (
                        <div className="p-8 text-center text-gray-500 italic">
                            Nėra duomenų.
                        </div>
                    ) : (
                        <div className="divide-y divide-gray-100">
                            {monthlyStats.map((stat) => (
                                <div key={stat.monthKey} className="bg-white">
                                    <button
                                        onClick={() => setExpandedMonth(expandedMonth === stat.monthKey ? null : stat.monthKey)}
                                        className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors text-left"
                                    >
                                        <div className="flex items-center gap-4">
                                            <span className="text-lg font-bold text-gray-800">
                                                {stat.monthKey}
                                            </span>
                                            <span className="text-sm font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                                                Viso: {formatMinutesToTimeString(stat.totalMinutes)}
                                            </span>
                                        </div>
                                        {expandedMonth === stat.monthKey ?
                                            <ChevronUp className="w-4 h-4 text-gray-400" /> :
                                            <ChevronDown className="w-4 h-4 text-gray-400" />
                                        }
                                    </button>

                                    {expandedMonth === stat.monthKey && (
                                        <div className="px-4 pb-4">
                                            <div className="overflow-x-auto rounded-lg border border-gray-200">
                                                <table className="min-w-full divide-y divide-gray-200">
                                                    <thead className="bg-gray-50/50">
                                                        <tr>
                                                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Darbuotojas</th>
                                                            <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Valandos</th>
                                                            <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider md:w-32">% nuo bendro</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y divide-gray-200 bg-white">
                                                        {Object.values(stat.users)
                                                            .sort((a, b) => b.minutes - a.minutes)
                                                            .map((user) => (
                                                                <tr key={user.userId} className="hover:bg-gray-50">
                                                                    <td className="px-4 py-2">
                                                                        <div className="text-sm font-medium text-gray-900">
                                                                            {formatDisplayName(user.name)}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-4 py-2 text-right">
                                                                        <div className="flex items-center justify-end gap-1.5 font-mono text-sm font-semibold text-indigo-700">
                                                                            <Clock className="w-3.5 h-3.5 opacity-50" />
                                                                            {formatMinutesToTimeString(user.minutes)}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-4 py-2 text-right">
                                                                        <div className="text-xs text-gray-500">
                                                                            {stat.totalMinutes > 0
                                                                                ? Math.round((user.minutes / stat.totalMinutes) * 100)
                                                                                : 0}%
                                                                        </div>
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
