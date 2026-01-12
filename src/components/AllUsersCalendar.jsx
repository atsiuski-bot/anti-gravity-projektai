import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot, getDocs } from 'firebase/firestore';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay, addDays, isSameDay, startOfDay } from 'date-fns';
import { lt } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { Users, Info, Clock } from 'lucide-react';

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

const dayNames = ['Sekmadienis', 'Pirmadienis', 'Antradienis', 'Trečiadienis', 'Ketvirtadienis', 'Penktadienis', 'Šeštadienis'];

export default function AllUsersCalendar() {
    const [events, setEvents] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [users, setUsers] = useState({});
    const [error, setError] = useState('');
    const [currentDate, setCurrentDate] = useState(new Date());
    const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

    useEffect(() => {
        const handleResize = () => {
            setIsMobile(window.innerWidth < 768);
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

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
                            userId: data.userId,
                            userName: user?.displayName || 'Nežinomas'
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

    // Custom Header Component for desktop calendar
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

            // Calculate Planned (from tasks - based on deadline if needed, but for now we remove dayOfWeek based planning)
            const plannedByUser = {};
            tasks.forEach(task => {
                if (task.assignedWorkerId && task.deadline && task.estimatedTime) {
                    const taskDate = new Date(task.deadline);
                    if (isSameDay(taskDate, date)) {
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

        // Get day name
        const dayName = dayNames[getDay(date)];

        return (
            <div className="flex flex-col items-center">
                <span className="text-sm font-bold text-blue-600 mb-0.5">{dayName}</span>
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

    // Mobile List View - Horizontal Scrollable Week
    const MobileListView = () => {
        const weekStart = startOfWeek(currentDate, { weekStartsOn: 0 });
        const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

        const groupedEvents = useMemo(() => {
            return weekDays.map((day) => {
                const dayName = dayNames[getDay(day)];
                return {
                    dayName,
                    date: day,
                    events: events.filter(event => isSameDay(event.start, day))
                };
            });
        }, [events, currentDate]);

        return (
            <div className="relative">
                {/* Week Navigation */}
                <div className="flex justify-between items-center mb-3 px-2">
                    <button
                        onClick={() => setCurrentDate(addDays(currentDate, -7))}
                        className="px-3 py-1 bg-blue-100 text-blue-700 rounded-lg text-sm font-medium"
                    >
                        ← Ankstesnė
                    </button>
                    <span className="text-sm font-semibold text-gray-700">
                        {format(weekStart, 'MMM d', { locale: lt })} - {format(addDays(weekStart, 6), 'MMM d', { locale: lt })}
                    </span>
                    <button
                        onClick={() => setCurrentDate(addDays(currentDate, 7))}
                        className="px-3 py-1 bg-blue-100 text-blue-700 rounded-lg text-sm font-medium"
                    >
                        Kita →
                    </button>
                </div>

                {/* Horizontal Scrollable Days */}
                <div className="overflow-x-auto snap-x snap-mandatory scrollbar-hide">
                    <div className="flex gap-3 pb-2">
                        {groupedEvents.map((dayData, idx) => (
                            <div
                                key={idx}
                                className="flex-shrink-0 snap-center bg-white border-2 border-gray-200 rounded-lg overflow-hidden"
                                style={{ width: 'calc(100vw - 3rem)' }}
                            >
                                {/* Day Header */}
                                <div className="bg-blue-50 px-4 py-3 border-b-2 border-blue-200">
                                    <h4 className="font-bold text-gray-900 text-lg">{dayData.dayName}</h4>
                                    <p className="text-sm text-gray-600">{format(dayData.date, 'MMMM d', { locale: lt })}</p>
                                </div>

                                {/* Events List */}
                                <div className="divide-y divide-gray-100 max-h-[500px] overflow-y-auto">
                                    {dayData.events.length > 0 ? (
                                        dayData.events.map(event => (
                                            <div key={event.id} className="p-4 hover:bg-gray-50">
                                                <div className="flex items-start gap-3">
                                                    <div
                                                        className="w-1.5 h-full min-h-[50px] rounded-full flex-shrink-0"
                                                        style={{ backgroundColor: event.color }}
                                                    />
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 mb-2">
                                                            <span className="font-semibold text-gray-900 text-base">
                                                                {event.userName}
                                                            </span>
                                                        </div>
                                                        <div className="flex items-center gap-2 text-sm text-gray-600">
                                                            <Clock className="w-4 h-4 flex-shrink-0" />
                                                            <span className="font-medium">
                                                                {format(event.start, 'HH:mm')} - {format(event.end, 'HH:mm')}
                                                            </span>
                                                            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded font-semibold">
                                                                {((event.end - event.start) / (1000 * 60 * 60)).toFixed(1)}h
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="p-8 text-center text-gray-400">
                                            <p className="text-sm">Nėra suplanuoto darbo</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Scroll Indicator Dots */}
                <div className="flex justify-center gap-1.5 mt-3">
                    {groupedEvents.map((_, idx) => (
                        <div
                            key={idx}
                            className="w-2 h-2 rounded-full bg-gray-300"
                        />
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div className={`w-full ${isMobile ? 'min-h-[500px]' : 'h-[850px]'} max-w-full`}>
            {/* Header removed for more space */}

            {error && (
                <div className="bg-red-50 border-l-4 border-red-500 p-4 mb-4">
                    <p className="text-sm text-red-700">{error}</p>
                </div>
            )}

            {isMobile ? (
                <MobileListView />
            ) : (
                <Calendar
                    localizer={localizer}
                    events={events}
                    startAccessor="start"
                    endAccessor="end"
                    style={{ height: 'calc(100% - 60px)' }}
                    culture='lt'
                    views={['week', 'day']}
                    defaultView='week'
                    scrollToTime={new Date(1970, 1, 1, 8)}
                    min={new Date(1970, 1, 1, 7)}
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
            )}
        </div>
    );
}
