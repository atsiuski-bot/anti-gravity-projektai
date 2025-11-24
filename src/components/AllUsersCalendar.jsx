import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot, getDocs } from 'firebase/firestore';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay, addDays, isSameDay, startOfDay } from 'date-fns';
import { lt } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { Users, Info } from 'lucide-react';

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

const parseTimeToHours = (timeStr) => {
    if (!timeStr) return 0;
    let totalHours = 0;
    const str = timeStr.toLowerCase().trim();
    const hourMatch = str.match(/(\d+\.?\d*)\s*h/);
    const minMatch = str.match(/(\d+)\s*m/);
    if (hourMatch) totalHours += parseFloat(hourMatch[1]);
    if (minMatch) totalHours += parseInt(minMatch[1]) / 60;
    return totalHours;
};

const dayMap = {
    'Sekmadienis': 0,
    'Pirmadienis': 1,
    'Antradienis': 2,
    'Trečiadienis': 3,
    'Ketvirtadienis': 4,
    'Penktadienis': 5,
    'Šeštadienis': 6
};

export default function AllUsersCalendar() {
    const [events, setEvents] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [users, setUsers] = useState({});
    const [error, setError] = useState('');
    const [currentDate, setCurrentDate] = useState(new Date());

    useEffect(() => {
        const fetchData = async () => {
            try {
                // 1. Fetch Users
                const usersSnapshot = await getDocs(collection(db, 'users'));
                const usersMap = {};
                usersSnapshot.docs.forEach(doc => {
                    usersMap[doc.id] = doc.data();
                });
                setUsers(usersMap);

                // 2. Fetch Tasks
                const tasksSnapshot = await getDocs(collection(db, 'tasks'));
                const tasksData = tasksSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                setTasks(tasksData);

                // 3. Listen to Work Hours
                const workHoursQuery = query(collection(db, 'work_hours'));
                const unsubscribe = onSnapshot(workHoursQuery, (snapshot) => {
                    const allEvents = snapshot.docs.map(doc => {
                        const data = doc.data();
                        const user = usersMap[data.userId];
                        return {
                            id: doc.id,
                            title: `${user?.displayName || 'Nežinomas'} - ${data.title || 'Darbas'}`,
                            start: new Date(data.start),
                            end: new Date(data.end),
                            resourceId: data.userId,
                            color: user?.color || '#3b82f6',
                            userId: data.userId // Store userId for capacity calc
                        };
                    });
                    setEvents(allEvents);
                }, (err) => {
                    console.error("Error fetching work hours:", err);
                    setError("Nepavyko užkrauti darbo valandų.");
                });

                return unsubscribe;
            } catch (err) {
                console.error("Error setting up listener:", err);
                setError("Įvyko klaida.");
            }
        };

        const unsubscribePromise = fetchData();
        return () => {
            unsubscribePromise.then(unsub => unsub && unsub());
        };
    }, []);

    const eventStyleGetter = (event) => {
        const backgroundColor = event.color;
        return {
            style: {
                backgroundColor: backgroundColor,
                borderRadius: '4px',
                opacity: 0.8,
                color: 'white',
                border: '0px',
                display: 'block'
            }
        };
    };

    // Custom Header Component
    const CustomHeader = ({ date, label }) => {
        const stats = useMemo(() => {
            const dayStart = startOfDay(date);
            const dayOfWeek = getDay(date);

            // Calculate Capacity (from events/work_hours)
            const capacityByUser = {};
            events.forEach(event => {
                if (isSameDay(event.start, date)) {
                    const duration = (event.end - event.start) / (1000 * 60 * 60);
                    if (!capacityByUser[event.userId]) capacityByUser[event.userId] = 0;
                    capacityByUser[event.userId] += duration;
                }
            });

            // Calculate Planned (from tasks)
            const plannedByUser = {};
            tasks.forEach(task => {
                if (task.assignedWorkerId && task.estimatedTime && task.dayOfWeek) {
                    const taskDayIndex = dayMap[task.dayOfWeek];
                    // Check if task's day matches current header day
                    // Note: This assumes tasks repeat every week or apply to current week.
                    if (taskDayIndex === dayOfWeek) {
                        const hours = parseTimeToHours(task.estimatedTime);
                        if (!plannedByUser[task.assignedWorkerId]) plannedByUser[task.assignedWorkerId] = 0;
                        plannedByUser[task.assignedWorkerId] += hours;
                    }
                }
            });

            // Merge stats
            const userStats = Object.keys(users).map(userId => {
                const cap = capacityByUser[userId] || 0;
                const plan = plannedByUser[userId] || 0;
                if (cap === 0 && plan === 0) return null;
                return {
                    userId,
                    name: users[userId].displayName || users[userId].email,
                    color: users[userId].color,
                    capacity: cap,
                    planned: plan
                };
            }).filter(Boolean);

            return userStats;
        }, [date, events, tasks, users]);

        return (
            <div className="flex flex-col items-center">
                <span className="text-lg font-semibold mb-1">{label}</span>
                <div className="w-full space-y-1">
                    {stats.map(stat => (
                        <div key={stat.userId} className="flex justify-between items-center text-xs bg-gray-50 rounded px-1 py-0.5 border border-gray-100" style={{ borderLeft: `3px solid ${stat.color || '#ccc'}` }}>
                            <span className="truncate max-w-[60px] font-medium" title={stat.name}>{stat.name.split(' ')[0]}</span>
                            <span className={`${stat.planned > stat.capacity ? 'text-red-600 font-bold' : 'text-gray-600'}`}>
                                {stat.planned.toFixed(1)}h / {stat.capacity.toFixed(1)}h
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    const components = useMemo(() => ({
        week: {
            header: CustomHeader
        },
        day: {
            header: CustomHeader
        }
    }), [events, tasks, users]);

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 h-[800px]">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <Users className="w-5 h-5 text-blue-600" />
                    <h3 className="text-lg font-semibold text-gray-900">Komandos kalendorius</h3>
                </div>
                <div className="flex items-center gap-2 text-sm text-gray-500 bg-blue-50 px-3 py-1.5 rounded-full">
                    <Info className="w-4 h-4 text-blue-600" />
                    <span>Rodoma: Suplanuota (Užduotys) / Pajėgumas (Darbo val.)</span>
                </div>
            </div>

            {error && (
                <div className="bg-red-50 border-l-4 border-red-500 p-4 mb-4">
                    <p className="text-sm text-red-700">{error}</p>
                </div>
            )}

            <Calendar
                localizer={localizer}
                events={events}
                startAccessor="start"
                endAccessor="end"
                style={{ height: 'calc(100% - 60px)' }}
                culture='lt'
                views={['week', 'day']}
                defaultView='week'
                eventPropGetter={eventStyleGetter}
                components={components}
                onNavigate={date => setCurrentDate(date)}
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
                    noEventsInRange: "Nėra įvykių šiame periode."
                }}
            />
        </div>
    );
}
