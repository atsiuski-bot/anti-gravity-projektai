import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { Clock } from 'lucide-react';
import { startOfWeek, endOfWeek } from 'date-fns';

export default function WeeklyHoursSummary() {
    const { currentUser } = useAuth();
    const [totalHours, setTotalHours] = useState(0);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!currentUser) return;

        // Query only by userId to avoid composite index requirement
        const q = query(
            collection(db, 'work_hours'),
            where('userId', '==', currentUser.uid)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            // Get current week range (Sunday to Saturday)
            const now = new Date();
            const weekStart = startOfWeek(now, { weekStartsOn: 0 }); // Sunday
            const weekEnd = endOfWeek(now, { weekStartsOn: 0 }); // Saturday

            let total = 0;
            snapshot.docs.forEach(doc => {
                const data = doc.data();
                const start = new Date(data.start);

                // Filter client-side for current week
                if (start >= weekStart && start <= weekEnd) {
                    const end = new Date(data.end);
                    const durationHours = (end - start) / (1000 * 60 * 60);
                    total += durationHours;
                }
            });
            setTotalHours(total);
            setError('');
        }, (err) => {
            console.error("Error fetching weekly hours:", err);
            setError("Nepavyko užkrauti savaitės valandų.");
        });

        return () => unsubscribe();
    }, [currentUser]);

    return (
        <div className="bg-blue-50 border-l-4 border-blue-500 p-4 mb-6 rounded-lg">
            <div className="flex items-center gap-3">
                <div className="bg-blue-100 p-2 rounded-full">
                    <Clock className="w-6 h-6 text-blue-600" />
                </div>
                <div>
                    <h3 className="text-sm font-medium text-blue-900">Šios savaitės valandos</h3>
                    {error ? (
                        <p className="text-xs text-red-600">{error}</p>
                    ) : (
                        <p className="text-2xl font-bold text-blue-700">{totalHours.toFixed(1)} val.</p>
                    )}
                </div>
            </div>
        </div>
    );
}
