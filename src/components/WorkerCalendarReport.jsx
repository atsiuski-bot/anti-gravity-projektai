import React, { useState, useEffect, useMemo } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay, startOfMonth, endOfMonth, isSameDay, getWeek, getYear, eachDayOfInterval } from 'date-fns';
import { lt } from 'date-fns/locale';
import { db } from '../firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { formatDisplayName } from '../utils/formatters';
import { Download, User, ChevronLeft, ChevronRight, Calendar as CalendarIcon, Clock } from 'lucide-react';
import 'react-big-calendar/lib/css/react-big-calendar.css';

const locales = {
    'lt': lt,
};

const localizer = dateFnsLocalizer({
    format,
    parse,
    startOfWeek,
    getDay,
    locales,
});

export default function WorkerCalendarReport({ users }) {
    const [selectedUserId, setSelectedUserId] = useState('');
    const [viewDate, setViewDate] = useState(new Date());
    const [events, setEvents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [dailyTotals, setDailyTotals] = useState({});
    const [monthlyTotal, setMonthlyTotal] = useState(0);

    // Default to first user if available and none selected
    useEffect(() => {
        if (!selectedUserId && users && users.length > 0) {
            setSelectedUserId(users[0].id);
        }
    }, [users]);

    useEffect(() => {
        if (selectedUserId) {
            fetchWorkSessions();
        }
    }, [selectedUserId, viewDate]);

    const fetchWorkSessions = async () => {
        setLoading(true);
        try {
            const start = startOfMonth(viewDate);
            const end = endOfMonth(viewDate);
            // Add a buffer to fetch events for surrounding weeks in calendar view
            start.setDate(start.getDate() - 7);
            end.setDate(end.getDate() + 7);

            const startStr = start.toISOString().split('T')[0];
            const endStr = end.toISOString().split('T')[0];

            const q = query(
                collection(db, 'work_sessions'),
                where('workerId', '==', selectedUserId),
                where('date', '>=', startStr),
                where('date', '<=', endStr)
            );

            const querySnapshot = await getDocs(q);
            const sessions = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            // Process events
            const newEvents = sessions.map(session => ({
                id: session.id,
                title: `${formatMinutesToTimeString(session.durationMinutes || 0)} - ${session.taskTitle || 'Darbas'}`,
                start: new Date(session.startTime),
                end: new Date(session.endTime),
                resource: session
            }));

            setEvents(newEvents);

            // Calculate totals
            const totals = {};
            let monthSum = 0;
            const currentMonthStr = format(viewDate, 'yyyy-MM');

            sessions.forEach(session => {
                const dateStr = session.date;
                if (!totals[dateStr]) totals[dateStr] = 0;
                totals[dateStr] += (session.durationMinutes || 0);

                if (dateStr.startsWith(currentMonthStr)) {
                    monthSum += (session.durationMinutes || 0);
                }
            });

            setDailyTotals(totals);
            setMonthlyTotal(monthSum);

        } catch (error) {
            console.error("Error fetching work sessions:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleNavigate = (newDate) => {
        setViewDate(newDate);
    };

    const CustomDateHeader = ({ label, date }) => {
        const dateStr = format(date, 'yyyy-MM-dd');
        const totalMinutes = dailyTotals[dateStr] || 0;

        return (
            <div className="flex flex-col items-center">
                <span className="text-sm font-semibold text-gray-700">{label}</span>
                {totalMinutes > 0 && (
                    <span className="text-xs font-bold text-blue-600 mt-1 bg-blue-50 px-1.5 py-0.5 rounded">
                        {formatMinutesToTimeString(totalMinutes)}
                    </span>
                )}
            </div>
        );
    };

    const exportToCSV = () => {
        if (!selectedUserId) return;

        const user = users.find(u => u.id === selectedUserId);
        const userName = user ? (user.displayName || user.email) : 'Worker';
        const monthStr = format(viewDate, 'yyyy-MM');

        let csvContent = "data:text/csv;charset=utf-8,";
        csvContent += "Data,Darbuotojas,Viso Laiko,Sesijos\n";

        // Generate rows for each day in the month
        const daysInMonth = eachDayOfInterval({
            start: startOfMonth(viewDate),
            end: endOfMonth(viewDate)
        });

        daysInMonth.forEach(day => {
            const dateStr = format(day, 'yyyy-MM-dd');
            const total = dailyTotals[dateStr] || 0;

            // Collect session details for that day
            const daySessions = events.filter(e => format(e.start, 'yyyy-MM-dd') === dateStr);
            const sessionDetails = daySessions.map(s => {
                const start = format(s.start, 'HH:mm');
                const end = format(s.end, 'HH:mm');
                return `${start}-${end} (${s.title})`;
            }).join(' | ');

            if (total > 0) {
                csvContent += `${dateStr},${userName},${formatMinutesToTimeString(total)},"${sessionDetails}"\n`;
            }
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `Darbo_Ataskaita_${userName}_${monthStr}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    // Calculate weekly total for the CURRENTLY selected week in view if we were in week view, 
    // but honestly for Month view, showing Weekly totals per row is hard in big-calendar.
    // Instead, let's just show Month Total clearly.

    return (
        <div className="space-y-6">
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 flex flex-col md:flex-row gap-4 items-center justify-between">
                <div className="flex items-center gap-4 w-full md:w-auto">
                    <div className="relative flex-grow md:flex-grow-0">
                        <select
                            value={selectedUserId}
                            onChange={(e) => setSelectedUserId(e.target.value)}
                            className="pl-9 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm bg-white min-w-[200px] w-full"
                        >
                            <option value="" disabled>Pasirinkite darbuotoją</option>
                            {users?.filter(u => !u.isDisabled).map(u => (
                                <option key={u.id} value={u.id}>
                                    {formatDisplayName(u.displayName || u.email)}
                                </option>
                            ))}
                        </select>
                        <User className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 transform -translate-y-1/2" />
                    </div>
                </div>

                <div className="flex items-center gap-4">
                    <div className="bg-blue-50 px-4 py-2 rounded-lg border border-blue-100 flex items-center gap-2">
                        <Clock className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-medium text-blue-900">Mėnesio Viso:</span>
                        <span className="text-lg font-bold text-blue-700">{formatMinutesToTimeString(monthlyTotal)}</span>
                    </div>

                    <button
                        onClick={exportToCSV}
                        className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium"
                    >
                        <Download className="w-4 h-4" />
                        Eksportuoti CSV
                    </button>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <div className="h-[600px]">
                    <Calendar
                        localizer={localizer}
                        events={events}
                        startAccessor="start"
                        endAccessor="end"
                        style={{ height: '100%' }}
                        date={viewDate}
                        onNavigate={handleNavigate}
                        culture='lt'
                        views={['month', 'week', 'day']}
                        defaultView='month'
                        components={{
                            month: {
                                dateHeader: CustomDateHeader
                            }
                        }}
                        eventPropGetter={(event) => ({
                            style: {
                                backgroundColor: '#EFF6FF',
                                color: '#1E40AF',
                                borderRadius: '2px',
                                fontSize: '11px',
                                padding: '1px 4px',
                                border: 'none',
                                borderLeft: '3px solid #3B82F6'
                            }
                        })}
                        messages={{
                            next: "Kitas",
                            previous: "Ankstesnis",
                            today: "Šiandien",
                            month: "Mėnuo",
                            week: "Savaitė",
                            day: "Diena",
                            agenda: "Darbotvarkė",
                            date: "Data",
                            time: "Laikas",
                            event: "Įvykis",
                            noEventsInRange: "Nėra sesijų."
                        }}
                    />
                </div>
            </div>
        </div>
    );
}
