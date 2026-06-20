import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot, where } from 'firebase/firestore';
import { format, addDays, isSameDay, getDay } from 'date-fns';
import { lt } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, CalendarOff, Home, Palmtree, AlertTriangle } from 'lucide-react';
import { formatDisplayName } from '../utils/formatters';
import { useUsers } from '../context/UsersContext';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import { cn } from '../utils/cn';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import EmptyState from './ui/EmptyState';

// Calm indigo "free" state for vacation events — replaces a near-black (#000000) block so
// vacation reads as time off, not a heavy bar. Paired everywhere with a Palmtree + "Atostogos"
// label so colour is never the sole signal (DESIGN_SYSTEM §4/§16). Inline because the calendar
// positions/fills bars with computed styles, not Tailwind classes.
const VACATION_COLOR = '#A5B4FC'; // indigo-300

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
    const [error, setError] = useState('');

    useEffect(() => {
        setCurrentDate(new Date());
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
                    color: user?.color || WORKER_FALLBACK_COLOR,
                    isWorkFromHome: data.isWorkFromHome || false,
                    isVacation: data.isVacation || false,
                };
            });
            setEvents(allEvents);
            setError('');
        }, (err) => {
            console.error("Error fetching work hours:", err);
            setError("Nepavyko užkrauti darbo valandų. Patikrinkite ryšį ir bandykite dar kartą.");
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

    // Desktop Timeline View
    const hours = Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => START_HOUR + i);

    // Friendly Lithuanian status descriptor for an event (text + icon, never color alone).
    const eventStatus = (event) => {
        if (event.isVacation) return { label: 'Atostogos', Icon: Palmtree };
        if (event.isWorkFromHome) return { label: 'Iš namų', Icon: Home };
        return null;
    };

    return (
        <div className="w-full bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden flex flex-col h-[70vh] min-h-[480px] max-h-[850px]">
            {/* Toolbar */}
            <div className="p-4 border-b border-gray-200 flex flex-col gap-4">
                <div className="flex justify-end items-center">
                    <Button
                        variant="secondary"
                        onClick={() => setCurrentDate(new Date())}
                    >
                        Šiandien
                    </Button>
                </div>

                {/* Date Navigation */}
                <div className="flex items-center justify-center gap-6">
                    <IconButton
                        icon={ChevronLeft}
                        label="Ankstesnė diena"
                        onClick={() => setCurrentDate(addDays(currentDate, -1))}
                    />
                    <div className="text-center">
                        <h2 className="text-2xl font-bold text-gray-900 capitalize">
                            {WEEKDAYS[getDay(currentDate)]}
                        </h2>
                        <p className="text-lg text-gray-500 capitalize">
                            {format(currentDate, 'MMMM d', { locale: lt })}d.
                        </p>
                    </div>
                    <IconButton
                        icon={ChevronRight}
                        label="Sekanti diena"
                        onClick={() => setCurrentDate(addDays(currentDate, 1))}
                    />
                </div>
            </div>

            {/* Load error — friendly Lithuanian copy, never a raw error message (§10) */}
            {error && (
                <div
                    role="alert"
                    className="mx-4 mt-4 flex items-start gap-2 rounded-card border border-red-200 bg-red-50 px-3 py-2.5 text-body text-red-700"
                >
                    <AlertTriangle className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                </div>
            )}

            {/* Timeline Area — desktop only (md+). On phones, data is cards, never an h-scroll timeline (§9). */}
            <div className="hidden md:flex flex-1 overflow-auto relative flex-col">
                <div className="relative flex flex-col min-w-full px-4">
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
                                    <span className="absolute -top-1 left-0 -translate-x-1/2 text-caption text-gray-500 font-medium">
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
                                        const status = eventStatus(event);
                                        const timeRange = `${format(event.start, 'HH:mm')}–${format(event.end, 'HH:mm')}`;
                                        return (
                                            <div
                                                key={event.id}
                                                className="absolute top-1 h-6 rounded-full border border-line shadow-sm flex items-center justify-center hover:brightness-105 transition-all cursor-default z-10"
                                                style={{
                                                    ...style,
                                                    backgroundColor: event.isVacation ? VACATION_COLOR : event.color
                                                }}
                                                title={`${event.title} (${timeRange})`}
                                                aria-label={`${user.displayName}, ${event.title}${status ? `, ${status.label}` : ''}, ${timeRange}`}
                                            >
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-caption font-bold bg-white text-gray-800 border border-white/50 shadow-sm z-20 relative whitespace-nowrap leading-tight">
                                                    <span aria-hidden="true">👤</span>
                                                    {user.displayName}
                                                    {status && (
                                                        <>
                                                            <status.Icon className="w-3.5 h-3.5" aria-hidden="true" />
                                                            ({status.label})
                                                        </>
                                                    )}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}

                            {/* Empty state if no users found */}
                            {usersWithEvents.length === 0 && (
                                <div className="text-center text-ink-muted py-10 w-full text-body">
                                    Šią dieną suplanuotų darbų nėra.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Mobile card stack (< md) — each user's shifts as readable rows, no horizontal scroll (§9) */}
            <div className="md:hidden flex-1 overflow-y-auto p-4 space-y-3">
                {usersWithEvents.length === 0 ? (
                    <EmptyState
                        icon={CalendarOff}
                        title="Nėra suplanuotų darbų"
                        description="Šią dieną suplanuotų darbų nėra."
                    />
                ) : (
                    usersWithEvents.map((user) => (
                        <div
                            key={user.id}
                            className="rounded-card border border-gray-200 bg-white shadow-sm overflow-hidden"
                        >
                            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
                                <span
                                    className="w-3 h-3 rounded-full flex-shrink-0"
                                    style={{ backgroundColor: user.color || WORKER_FALLBACK_COLOR }}
                                    aria-hidden="true"
                                />
                                <h3 className="text-body-lg font-semibold text-ink-strong truncate">
                                    {user.displayName}
                                </h3>
                            </div>
                            <ul className="divide-y divide-line">
                                {user.events.map((event) => {
                                    const status = eventStatus(event);
                                    return (
                                        <li
                                            key={event.id}
                                            className="flex items-start gap-3 px-4 py-3"
                                            style={{
                                                borderLeft: `4px solid ${event.isVacation ? VACATION_COLOR : (event.color || WORKER_FALLBACK_COLOR)}`
                                            }}
                                        >
                                            <div className="min-w-0 flex-1">
                                                <p className="text-body font-semibold text-ink-strong truncate">
                                                    {event.title}
                                                </p>
                                                <p className="text-caption text-ink-muted font-medium tabular-nums">
                                                    {format(event.start, 'HH:mm')}–{format(event.end, 'HH:mm')}
                                                </p>
                                            </div>
                                            {status && (
                                                <span className={cn(
                                                    'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-caption font-medium flex-shrink-0',
                                                    event.isVacation ? 'bg-brand-soft text-brand-hover' : 'bg-amber-100 text-amber-800'
                                                )}>
                                                    <status.Icon className="w-3.5 h-3.5" aria-hidden="true" />
                                                    {status.label}
                                                </span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
