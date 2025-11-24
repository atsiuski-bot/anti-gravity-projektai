import React, { useState, useEffect } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { lt } from 'date-fns/locale';
import { db } from '../firebase';
import { collection, addDoc, deleteDoc, doc, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { Clock, Plus, Trash2 } from 'lucide-react';
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

export default function WorkPlanner() {
    const { currentUser } = useAuth();
    const [events, setEvents] = useState([]);
    const [showManualInput, setShowManualInput] = useState(false);
    const [manualDate, setManualDate] = useState('');
    const [manualStart, setManualStart] = useState('');
    const [manualEnd, setManualEnd] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        if (!currentUser) return;

        const q = query(
            collection(db, 'work_hours'),
            where('userId', '==', currentUser.uid)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const hoursData = snapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    title: data.title || 'Darbas',
                    start: new Date(data.start),
                    end: new Date(data.end),
                    userId: data.userId,
                };
            });
            setEvents(hoursData);
        }, (err) => {
            console.error("Error fetching work hours:", err);
            setError("Nepavyko užkrauti darbo valandų.");
        });

        return () => unsubscribe();
    }, [currentUser]);

    const handleSelectSlot = async ({ start, end }) => {
        if (!currentUser) return;

        try {
            await addDoc(collection(db, 'work_hours'), {
                userId: currentUser.uid,
                start: start.toISOString(),
                end: end.toISOString(),
                title: 'Darbas',
                type: 'planned',
            });
            setError('');
        } catch (err) {
            console.error("Error adding work hours:", err);
            setError("Nepavyko pridėti darbo valandų.");
        }
    };

    const handleSelectEvent = async (event) => {
        if (window.confirm('Ar tikrai norite ištrinti šį įrašą?')) {
            try {
                await deleteDoc(doc(db, 'work_hours', event.id));
                setError('');
            } catch (err) {
                console.error("Error deleting work hours:", err);
                setError("Nepavyko ištrinti darbo valandų.");
            }
        }
    };

    const handleManualSubmit = async (e) => {
        e.preventDefault();
        if (!currentUser || !manualDate || !manualStart || !manualEnd) {
            setError('Užpildykite visus laukus.');
            return;
        }

        try {
            const startDateTime = new Date(`${manualDate}T${manualStart}`);
            const endDateTime = new Date(`${manualDate}T${manualEnd}`);

            if (endDateTime <= startDateTime) {
                setError('Pabaigos laikas turi būti vėlesnis už pradžios laiką.');
                return;
            }

            await addDoc(collection(db, 'work_hours'), {
                userId: currentUser.uid,
                start: startDateTime.toISOString(),
                end: endDateTime.toISOString(),
                title: 'Darbas',
                type: 'planned',
            });

            // Reset form
            setManualDate('');
            setManualStart('');
            setManualEnd('');
            setShowManualInput(false);
            setError('');
        } catch (err) {
            console.error("Error adding manual work hours:", err);
            setError("Nepavyko pridėti darbo valandų.");
        }
    };

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Darbo valandų planavimas</h3>
                <button
                    onClick={() => setShowManualInput(!showManualInput)}
                    className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    Pridėti rankiniu būdu
                </button>
            </div>

            {error && (
                <div className="mb-4 bg-red-50 border-l-4 border-red-500 p-4">
                    <p className="text-sm text-red-700">{error}</p>
                </div>
            )}

            {showManualInput && (
                <form onSubmit={handleManualSubmit} className="mb-4 p-4 bg-gray-50 rounded-lg">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Data</label>
                            <input
                                type="date"
                                value={manualDate}
                                onChange={(e) => setManualDate(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Pradžia</label>
                            <input
                                type="time"
                                value={manualStart}
                                onChange={(e) => setManualStart(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Pabaiga</label>
                            <input
                                type="time"
                                value={manualEnd}
                                onChange={(e) => setManualEnd(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                required
                            />
                        </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                        <button
                            type="submit"
                            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
                        >
                            Išsaugoti
                        </button>
                        <button
                            type="button"
                            onClick={() => setShowManualInput(false)}
                            className="bg-gray-200 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-300 transition-colors"
                        >
                            Atšaukti
                        </button>
                    </div>
                </form>
            )}

            <div style={{ height: '600px' }}>
                <Calendar
                    localizer={localizer}
                    events={events}
                    startAccessor="start"
                    endAccessor="end"
                    culture="lt"
                    selectable
                    onSelectSlot={handleSelectSlot}
                    onSelectEvent={handleSelectEvent}
                    defaultView="week"
                    views={['week', 'day']}
                    step={30}
                    timeslots={2}
                    messages={{
                        week: 'Savaitė',
                        day: 'Diena',
                        today: 'Šiandien',
                        previous: 'Atgal',
                        next: 'Pirmyn',
                        showMore: total => `+ Dar ${total}`
                    }}
                />
            </div>

            <div className="mt-4 text-sm text-gray-600">
                <p><strong>Naudojimas:</strong></p>
                <ul className="list-disc list-inside space-y-1 mt-2">
                    <li>Paspauskite ir tempkite kalendoriuje, kad sukurtumėte darbo laiką</li>
                    <li>Arba naudokite "Pridėti rankiniu būdu" mygtuką</li>
                    <li>Paspauskite ant įrašo, kad jį ištrintumėte</li>
                </ul>
            </div>
        </div>
    );
}
