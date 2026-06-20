import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot, where } from 'firebase/firestore';
import { format, addDays, isSameDay, getDay } from 'date-fns';
import { lt } from 'date-fns/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDisplayName } from '../utils/formatters';
import { useUsers } from '../context/UsersContext';

// Constants
const START_HOUR = 7;
const END_HOUR = 22;
const TOTAL_HOURS = END_HOUR - START_HOUR; // 15 hours
const WEEKDAYS = ['Sekmadienis', 'Pirmadienis', 'Antradienis', 'Trečiadienis', 'Ketvirtadienis', 'Penktadienis', 'Šeštadienis'];

// Helper to calculate position and width
const getEventStyle = (start, end) => {
    const startHour = start.getHours() + start.getMinutes() / 60;
    const endHour = end.getHours() + end.getMinutes() / 60;

    // Clamp to view range
    const effectiveStart = Math.max(startHour, START_HOUR);
    const effectiveEnd = Math.min(endHour, END_HOUR);

    if (effectiveEnd <= effectiveStart) return null;

    const leftPercent = ((effectiveStart - START_HOUR) / TOTAL_HOURS) * 100;
    const widthPercent = ((effectiveEnd - effectiveStart) / TOTAL_HOURS) * 100;

    return {
        left: `${leftPercent}%`,
        width: `${widthPercent}%`
    };
};

export default function AllUsersCalendar() {
    // Current time state
    const [now, setNow] = useState(new Date());

    useEffect(() => {
        const interval = setInterval(() => setNow(new Date()), 60000);
        return () => clearInterval(interval);
    }, []);

    const [events, setEvents] = useState([]);
    const [users] = useState({});
    const [currentDate, setCurrentDate] = useState(new Date());
    const [, setError] = useState('');
    const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

    useEffect(() => {
        setCurrentDate(new Date());

        const handleResize = () => {
            setIsMobile(window.innerWidth < 768);
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const { activeUsers, usersMap } = useUsers();

    // using usersMap from context

    // Listen to Work Hours for the specific currentDate
    useEffect(() => {
        if (Object.keys(usersMap).length === 0) return;

        const startOfDay = new Date(currentDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(currentDate);
        endOfDay.setHours(23, 59, 59, 999);

        // We use where('start', ...) assuming work shifts start on the day they are displayed.
        const workHoursQuery = query(
            collection(db, 'work_hours'),
            where('start', '>=', startOfDay.toISOString()),
            where('start', '<=', endOfDay.toISOString())
        );

        const unsubscribe = onSnapshot(workHoursQuery, (snapshot) => {
            const allEvents = snapshot.docs.map(doc => {
                const data = doc.data();
                const user = usersMap[data.userId];
                return {
                    id: doc.id,
                    title: data.title || 'Darbas',
                    start: new Date(data.start),
                    end: new Date(data.end),
                    userId: data.userId,
                    userName: user ? formatDisplayName(user.displayName || user.email) : 'Nežinomas',
                    color: user?.color || '#3b82f6',
                    isWorkFromHome: data.isWorkFromHome || false,
                    isVacation: data.isVacation || false,
                };
            });
            setEvents(allEvents);
        }, (err) => {
            console.error("Error fetching work hours:", err);
            setError("Nepavyko užkrauti darbo valandų.");
        });

        return () => unsubscribe();
    }, [currentDate, usersMap]);

    const dayEvents = useMemo(() => {
        return events.filter(event => isSameDay(event.start, currentDate));
    }, [events, currentDate]);

    // Group by User
    const usersWithEvents = useMemo(() => {
        const userList = activeUsers.map(user => ({
            ...user,
            displayName: formatDisplayName(user.displayName || user.email)
        })).sort((a, b) => a.displayName.localeCompare(b.displayName));

        // Let's add any BLOCKED user who has events TODAY to the list, so their historical shift shows up
        const activeUserIds = new Set(userList.map(u => u.id));
        dayEvents.forEach(e => {
            if (!activeUserIds.has(e.userId) && usersMap[e.userId]) {
                const u = usersMap[e.userId];
                userList.push({
                    ...u,
                    id: e.userId,
                    displayName: formatDisplayName(u.displayName || u.email)
                });
                activeUserIds.add(e.userId);
            }
        });

        // Sort again in case blocked users were added
        userList.sort((a, b) => a.displayName.localeCompare(b.displayName));

        return userList.map(user => ({
            ...user,
            events: dayEvents.filter(e => e.userId === user.id)
        })).filter(user => user.events.length > 0); // Filter out users with no events
        // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve current recompute timing; activeUsers/usersMap from context are not stable refs
    }, [users, dayEvents]);

    // Scroll to 9:00 on mount for mobile
    const timelineRef = React.useRef(null);
    useEffect(() => {
        if (isMobile && timelineRef.current) {
            // 9:00 is 2 hours after 7:00 start
            // Total 15 hours. 
            // We want 9-19 (10 hours) to fill screen => min-w-[150%]
            // Scroll to (2 / 15) * width
            const scrollAmount = (timelineRef.current.scrollWidth * 2) / 15;
            timelineRef.current.scrollLeft = scrollAmount;
        }
    }, [isMobile, usersWithEvents]); // Re-run when data loads

    // Desktop Timeline View
    const hours = Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => START_HOUR + i);

    return (
        <div className="w-full bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden flex flex-col h-[850px]">
            {/* Toolbar */}
            <div className="p-4 border-b border-gray-200 flex flex-col gap-4">
                <div className="flex justify-between items-center">
                    {/* Placeholder for left side (was toggle) */}
                    <div className="w-[100px]"></div>

                    {/* Right Side: Today & Manual Add */}
                    <div className="flex flex-col items-end gap-2">
                        <button
                            onClick={() => setCurrentDate(new Date())}
                            className="w-[100px] h-[40px] text-sm font-bold bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 rounded-lg shadow-sm transition-all active:scale-95 flex items-center justify-center"
                        >
                            Šiandien
                        </button>

                    </div>
                </div>

                {/* Date Navigation */}
                <div className="flex items-center justify-center gap-6">
                    <button
                        onClick={() => setCurrentDate(addDays(currentDate, -1))}
                        className="p-2 hover:bg-gray-100 rounded-full text-gray-600 transition-colors"
                    >
                        <ChevronLeft className="w-8 h-8" />
                    </button>
                    <div className="text-center">
                        <h2 className="text-2xl font-bold text-gray-900 capitalize">
                            {WEEKDAYS[getDay(currentDate)]}
                        </h2>
                        <p className="text-lg text-gray-500 capitalize">
                            {format(currentDate, 'MMMM d', { locale: lt })}d.
                        </p>
                    </div>
                    <button
                        onClick={() => setCurrentDate(addDays(currentDate, 1))}
                        className="p-2 hover:bg-gray-100 rounded-full text-gray-600 transition-colors"
                    >
                        <ChevronRight className="w-8 h-8" />
                    </button>
                </div>
            </div>

            {/* Timeline Area */}
            <div className="flex-1 overflow-auto relative flex flex-col" ref={timelineRef}>
                <div className={`relative flex flex-col min-w-full px-4 ${isMobile ? 'min-w-[150%]' : ''}`}>
                    {/* Time Scale Header */}
                    <div className="flex border-b border-gray-300 bg-white sticky top-0 z-20 h-10">
                        <div className="w-full relative">
                            {hours.map((hour, i) => (
                                <div
                                    key={hour}
                                    className="absolute top-0 bottom-0 border-l border-gray-300"
                                    style={{
                                        left: `${(i / TOTAL_HOURS) * 100}%`
                                    }}
                                >
                                    <span className={`absolute -top-1 left-0 -translate-x-1/2 text-[10px] text-gray-500 font-medium ${isMobile && i % 2 !== 0 ? 'hidden' : 'block'}`}>
                                        {hour}:00
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Grid Body */}
                    <div className="flex-1 relative mt-2">
                        {/* Vertical Grid Lines Background */}
                        <div className="absolute inset-0 z-0">
                            {hours.map((hour, i) => (
                                <div
                                    key={`grid-${hour}`}
                                    className="absolute top-0 bottom-0 border-l border-gray-300"
                                    style={{
                                        left: `${(i / TOTAL_HOURS) * 100}%`,
                                        borderColor: i === 0 || i === TOTAL_HOURS ? 'transparent' : '#e5e7eb'
                                    }}
                                />
                            ))}

                            {/* Current Time Indicator */}
                            {(() => {
                                const nowHour = now.getHours() + now.getMinutes() / 60;
                                if (isSameDay(now, currentDate) && nowHour >= START_HOUR && nowHour <= END_HOUR) {
                                    const left = ((nowHour - START_HOUR) / TOTAL_HOURS) * 100;
                                    return (
                                        <div
                                            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-30 pointer-events-none transition-all duration-1000"
                                            style={{ left: `${left}%` }}
                                        >
                                            <div className="absolute -top-1 -translate-x-1/2 w-2 h-2 bg-red-500 rounded-full"></div>
                                        </div>
                                    );
                                }
                                return null;
                            })()}
                        </div>

                        {/* Users Rows */}
                        <div className="relative z-10 space-y-3 py-4 w-full">
                            {usersWithEvents.map((user) => (
                                <div key={user.id} className="relative h-8 w-full">
                                    {/* Events Bar */}
                                    {user.events.map(event => {
                                        const style = getEventStyle(event.start, event.end);
                                        if (!style) return null;
                                        return (
                                            <div
                                                key={event.id}
                                                className="absolute top-1 h-6 rounded-full border border-gray-800/10 shadow-sm flex items-center justify-center hover:brightness-105 transition-all cursor-default z-10"
                                                style={{
                                                    ...style,
                                                    backgroundColor: event.isVacation ? '#000000' : event.color
                                                }}
                                                title={`${event.title} (${format(event.start, 'HH:mm')} - ${format(event.end, 'HH:mm')})`}
                                            >
                                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-white text-gray-800 border border-white/50 shadow-sm z-20 relative whitespace-nowrap leading-tight">
                                                    👤 {user.displayName} {event.isVacation ? '(atostogos)' : event.isWorkFromHome ? '(iš namų)' : ''}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}

                            {/* Empty state if no users found */}
                            {usersWithEvents.length === 0 && (
                                <div className="text-center text-gray-400 py-10 w-full text-sm">
                                    Šią dieną suplanuotų darbų nėra.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
