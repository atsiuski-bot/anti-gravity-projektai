import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { startOfDay, endOfDay, format } from 'date-fns';

export default function DailyStatsHeader({ currentUser }) {
    const [plannedHours, setPlannedHours] = useState(0);
    const [workedHours, setWorkedHours] = useState(0);

    useEffect(() => {
        if (!currentUser) return;

        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const startToday = startOfDay(new Date());
        const endToday = endOfDay(new Date());

        // 1. Fetch Work Sessions (Actual Worked Hours Today)
        const sessionsQuery = query(
            collection(db, 'work_sessions'),
            where('workerId', '==', currentUser.uid),
            where('date', '==', todayStr)
        );

        const unsubSessions = onSnapshot(sessionsQuery, (snapshot) => {
            let totalMinutes = 0;
            snapshot.docs.forEach(doc => {
                totalMinutes += doc.data().durationMinutes || 0;
            });
            setWorkedHours(totalMinutes / 60);
        });

        // 2. Fetch Work Hours (Planned Hours Today)
        // Note: work_hours stores start/end as ISO strings. 
        // We can't easily query by range on string if it's full ISO.
        // But usually we query by userId and then filter in memory for calendar events.
        // Let's optimize if possible, or just fetch all user's hours? No, too many.
        // Assuming we store hours reasonably.
        // WorkPlanner fetches: where('userId', '==', currentUser.uid)
        // If we want ONLY today, we might need value based filtering.
        // Let's fetch all (or recent) and filter for today.

        // Optimization: Maybe add a 'dateStr' field to work_hours?
        // Checking WorkPlanner: It uses `start` and `end` ISO strings. 
        // It DOES NOT save `dateStr` (it saves `dateStr` in editingEvent state but likely not in DB or maybe yes?). 
        // L118 in WorkPlanner adds `start`, `end`, `title`, `type`. No `dateStr`.

        // So we must fetch matching range or all.
        // Let's fetch all for user. Only scaling issue if years of data.
        // Better: Query where `start` >= startToday.toISOString(). 
        // But Firestore string generic comparison works for ISO 8601.

        const plannedQuery = query(
            collection(db, 'work_hours'),
            where('userId', '==', currentUser.uid),
            where('start', '>=', startToday.toISOString()),
            where('start', '<=', endToday.toISOString())
        );

        const unsubPlanned = onSnapshot(plannedQuery, (snapshot) => {
            let totalMillis = 0;
            snapshot.docs.forEach(doc => {
                const data = doc.data();
                const start = new Date(data.start);
                const end = new Date(data.end);
                totalMillis += (end - start);
            });
            setPlannedHours(totalMillis / (1000 * 60 * 60));
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

    return (
        <div className="flex justify-between items-center bg-white p-4 rounded-xl shadow-sm border border-gray-200 mb-4 mx-0 sm:mx-0">
            <div className="flex flex-col items-start">
                <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Suplanuota šiandien</span>
                <span className="text-xl font-bold text-gray-800">{formatTime(plannedHours)}</span>
            </div>
            <div className="h-8 w-px bg-gray-200"></div>
            <div className="flex flex-col items-end">
                <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Išdirbta šiandien</span>
                <span className="text-xl font-bold text-blue-600">{formatTime(workedHours)}</span>
            </div>
        </div>
    );
}
