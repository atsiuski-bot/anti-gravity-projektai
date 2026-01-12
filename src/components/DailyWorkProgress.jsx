import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { startOfDay, endOfDay, format } from 'date-fns';

export default function DailyWorkProgress({ currentUser }) {
    const [plannedHours, setPlannedHours] = useState(0);
    const [workedHours, setWorkedHours] = useState(0);
    const [loading, setLoading] = useState(true);

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
        // Similar logic to DailyStatsHeader
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

    // SCALING LOGIC
    // 1. Base scale: plannedHours should be at 70% of the width.
    // scaleMax = plannedHours / 0.7
    // If plannedHours is 0, default to something reasonable (e.g. 8h represents 70% -> scaleMax = 11.4)
    let scaleMax = plannedHours > 0 ? plannedHours / 0.7 : 11.4;

    // 2. If workedHours exceeds the calculated scaleMax (or gets too close), expand the scale.
    // We want workedHours to fit. If workedHours > scaleMax, effectively 'zoom out'.
    // Let's say we always want the bars to fit within 100%.
    if (workedHours > scaleMax) {
        // If worked is bigger, make IT the 95% mark (padding).
        scaleMax = workedHours / 0.95;
    }

    // 3. Percentages
    const plannedPercent = scaleMax > 0 ? (plannedHours / scaleMax) * 100 : 0;
    const workedPercent = scaleMax > 0 ? (workedHours / scaleMax) * 100 : 0;

    if (loading) return null;

    return (
        <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 mb-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">Dienos Progresas</h3>

            <div className="space-y-6">
                {/* Planned Hours Bar */}
                <div className="relative">
                    <div className="flex justify-between text-xs font-medium text-gray-500 mb-1">
                        <span>Suplanuotos valandos</span>
                        <span>{formatTime(plannedHours)}</span>
                    </div>
                    <div className="h-4 w-full bg-gray-100 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-blue-300 rounded-full transition-all duration-500 ease-in-out"
                            style={{ width: `${Math.min(plannedPercent, 100)}%` }}
                        ></div>
                    </div>
                </div>

                {/* Worked Hours Bar */}
                <div className="relative">
                    <div className="flex justify-between text-xs font-medium text-gray-500 mb-1">
                        <span>Išdirbtos valandos</span>
                        <span className="text-blue-700">{formatTime(workedHours)}</span>
                    </div>
                    <div className="h-4 w-full bg-gray-100 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-blue-600 rounded-full transition-all duration-500 ease-in-out"
                            style={{ width: `${Math.min(workedPercent, 100)}%` }}
                        ></div>
                    </div>
                </div>
            </div>
        </div>
    );
}
