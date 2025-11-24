import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot, getDocs } from 'firebase/firestore';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { lt } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { Users } from 'lucide-react';

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

export default function AllWorkersCalendars() {
    const [userCalendars, setUserCalendars] = useState([]);
    const [error, setError] = useState('');

    useEffect(() => {
        const fetchWorkHours = async () => {
            try {
                const workHoursQuery = query(collection(db, 'work_hours'));

                const unsubscribe = onSnapshot(workHoursQuery, async (workHoursSnapshot) => {
                    try {
                        // Fetch all users
                        const usersSnapshot = await getDocs(collection(db, 'users'));
                        const usersMap = {};
                        usersSnapshot.docs.forEach(doc => {
                            usersMap[doc.id] = doc.data();
                        });

                        // Group work hours by user
                        const hoursByUser = {};
                        workHoursSnapshot.docs.forEach(doc => {
                            const data = doc.data();
                            const userId = data.userId;

                            if (!hoursByUser[userId]) {
                                hoursByUser[userId] = [];
                            }

                            hoursByUser[userId].push({
                                id: doc.id,
                                title: data.title || 'Darbas',
                                start: new Date(data.start),
                                end: new Date(data.end),
                                type: data.type || 'work'
                            });
                        });

                        // Create calendar data for each user
                        const calendars = Object.entries(hoursByUser).map(([userId, events]) => ({
                            userId,
                            displayName: usersMap[userId]?.displayName || 'Nežinomas',
                            email: usersMap[userId]?.email || '',
                            events: events.sort((a, b) => b.start - a.start)
                        }));

                        // Sort by display name
                        calendars.sort((a, b) => a.displayName.localeCompare(b.displayName));

                        setUserCalendars(calendars);
                        setError('');
                    } catch (err) {
                        console.error("Error processing calendars:", err);
                        setError("Klaida apdorojant duomenis.");
                    }
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

        const unsubscribe = fetchWorkHours();
        return () => {
            if (unsubscribe && typeof unsubscribe.then === 'function') {
                unsubscribe.then(unsub => unsub && unsub());
            }
        };
    }, []);

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
                <Users className="w-5 h-5 text-blue-600" />
                <h3 className="text-lg font-semibold text-gray-900">Darbuotojų kalendoriai</h3>
            </div>

            {error && (
                <div className="bg-red-50 border-l-4 border-red-500 p-4 mb-4">
                    <p className="text-sm text-red-700">{error}</p>
                </div>
            )}

            {userCalendars.length === 0 ? (
                <p className="text-gray-500 text-sm">Nėra užregistruotų darbo valandų.</p>
            ) : (
                <div className="space-y-8">
                    {userCalendars.map((userCal) => (
                        <div key={userCal.userId} className="border border-gray-200 rounded-lg p-4">
                            <div className="mb-4">
                                <h4 className="text-md font-semibold text-gray-900">{userCal.displayName}</h4>
                                <p className="text-sm text-gray-500">{userCal.email}</p>
                            </div>

                            <div style={{ height: '500px' }}>
                                <Calendar
                                    localizer={localizer}
                                    events={userCal.events}
                                    startAccessor="start"
                                    endAccessor="end"
                                    style={{ height: '100%' }}
                                    culture='lt'
                                    views={['month', 'week', 'day']}
                                    defaultView='week'
                                    eventPropGetter={(event) => ({
                                        style: {
                                            backgroundColor: '#3b82f6',
                                            borderRadius: '4px',
                                            opacity: 0.8,
                                            color: 'white',
                                            border: '0px',
                                            display: 'block'
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
                                        noEventsInRange: "Nėra įvykių šiame periode."
                                    }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
