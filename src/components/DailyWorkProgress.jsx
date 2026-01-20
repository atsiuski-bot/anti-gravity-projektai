import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { startOfWeek, endOfWeek, eachDayOfInterval, format, isSameDay } from 'date-fns';

export default function DailyWorkProgress({ currentUser, tasks = [] }) {
    const [dayPlanned, setDayPlanned] = useState(0);
    const [dayWorked, setDayWorked] = useState(0);
    const [weekPlanned, setWeekPlanned] = useState(0);
    const [weekWorked, setWeekWorked] = useState(0);
    const [currentSessionHours, setCurrentSessionHours] = useState(0);
    const [loading, setLoading] = useState(true);

    // Calculate active session time from running tasks
    useEffect(() => {
        const calculateActiveTime = () => {
            if (!tasks || tasks.length === 0) {
                setCurrentSessionHours(0);
                return;
            }

            let totalActiveMillis = 0;
            const now = new Date();

            tasks.forEach(task => {
                if (task.timerStatus === 'running' && task.timerStartedAt && task.assignedWorkerId === currentUser?.uid) {
                    const start = new Date(task.timerStartedAt);
                    if (!isNaN(start.getTime())) {
                        totalActiveMillis += (now - start);
                    }
                }
            });

            setCurrentSessionHours(totalActiveMillis / (1000 * 60 * 60));
        };

        calculateActiveTime();
        const interval = setInterval(calculateActiveTime, 60000);
        return () => clearInterval(interval);
    }, [tasks, currentUser]);

    useEffect(() => {
        if (!currentUser) return;

        const now = new Date();
        const weekStart = startOfWeek(now, { weekStartsOn: 1 }); // Monday start
        const weekEnd = endOfWeek(now, { weekStartsOn: 1 });
        const todayStr = format(now, 'yyyy-MM-dd');

        // Generate array of date strings for the week to use in 'in' query
        const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd })
            .map(d => format(d, 'yyyy-MM-dd'));

        // 1. Fetch Work Sessions (Actual Worked Hours - FINISHED ONLY)
        const sessionsQuery = query(
            collection(db, 'work_sessions'),
            where('workerId', '==', currentUser.uid),
            where('date', 'in', weekDays)
        );

        const unsubSessions = onSnapshot(sessionsQuery, (snapshot) => {
            let dWorked = 0;
            let wWorked = 0;
            snapshot.docs.forEach(doc => {
                const data = doc.data();
                const duration = (data.durationMinutes || 0) / 60;
                wWorked += duration;
                if (data.date === todayStr) {
                    dWorked += duration;
                }
            });
            setDayWorked(dWorked);
            setWeekWorked(wWorked);
        });

        // 2. Fetch Work Hours (Planned from Calendar)
        const plannedQuery = query(
            collection(db, 'work_hours'),
            where('userId', '==', currentUser.uid),
            where('start', '>=', weekStart.toISOString()),
            where('start', '<=', weekEnd.toISOString())
        );

        const unsubPlanned = onSnapshot(plannedQuery, (snapshot) => {
            let dPlanned = 0;
            let wPlanned = 0;
            snapshot.docs.forEach(doc => {
                try {
                    const data = doc.data();
                    const start = new Date(data.start);
                    const end = new Date(data.end);

                    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
                        const duration = (end - start) / (1000 * 60 * 60);

                        if (Number.isFinite(duration) && duration >= 0) {
                            wPlanned += duration;
                            if (isSameDay(start, now)) {
                                dPlanned += duration;
                            }
                        }
                    }
                } catch (error) {
                    console.warn('Error processing planned work entry:', doc.id, error);
                }
            });
            setDayPlanned(dPlanned);
            setWeekPlanned(wPlanned);
            setLoading(false);
        });

        return () => {
            unsubSessions();
            unsubPlanned();
        };
    }, [currentUser]);

    const formatTime = (decimalHours) => {
        const h = Math.floor(decimalHours);
        const m = Math.round((decimalHours - h) * 60);
        return `${h}h ${m}m`;
    };

    // Calculate totals including current session
    // Current session counts towards both Day and Week
    const totalDayWorked = dayWorked + currentSessionHours;
    const totalWeekWorked = weekWorked + currentSessionHours;

    const renderProgressBar = (label, current, total, colorClass = "bg-blue-600") => {
        // Prevent division by zero
        const percent = total > 0 ? (current / total) * 100 : 0;
        // Cap at 100% for the bar visual, but allow text to show real values? 
        // User might want to see over-achievement.
        // Let's just cap the visual bar at 100%.

        return (
            <div className="relative">
                <div className="flex justify-between text-xs font-medium text-gray-500 mb-1">
                    <span>{label}</span>
                    <span className="text-gray-900">
                        {formatTime(current)} <span className="text-gray-400">/ {formatTime(total)}</span>
                        {currentSessionHours > 0 && label.includes('Dienos') && (
                            <span className="text-xs text-green-600 ml-1">(+vyksta)</span>
                        )}
                    </span>
                </div>
                <div className="h-4 w-full bg-gray-100 rounded-full overflow-hidden">
                    <div
                        className={`h-full ${colorClass} rounded-full transition-all duration-500 ease-in-out`}
                        style={{ width: `${Math.min(percent, 100)}%` }}
                    ></div>
                </div>
            </div>
        );
    };

    return (
        <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 mb-6 relative">
            {loading && (
                <div className="absolute inset-0 bg-white/50 z-10 animate-pulse rounded-xl" />
            )}
            <h3 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
                Darbo Progresas
            </h3>

            <div className="space-y-6">
                {/* Day Progress */}
                {renderProgressBar(
                    "Dienos tikslas",
                    totalDayWorked,
                    dayPlanned,
                    "bg-blue-500"
                )}

                {/* Week Progress */}
                {renderProgressBar(
                    "Savaitės tikslas",
                    totalWeekWorked,
                    weekPlanned,
                    "bg-indigo-500" // Slightly different color for distinction
                )}
            </div>
        </div>
    );
}
