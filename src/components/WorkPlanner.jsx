import React, { useState, useEffect } from 'react';
import clsx from 'clsx';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { lt } from 'date-fns/locale';
import { db } from '../firebase';
import { collection, addDoc, deleteDoc, updateDoc, doc, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { Clock, Plus, Trash2, AlertCircle, Info } from 'lucide-react';
import { logCalendarChange } from '../utils/calendarNotifications';
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

const CustomToolbar = (toolbar) => {
    const goToToday = () => { toolbar.onNavigate('TODAY'); };
    const toggleView = (view) => { toolbar.onView(view); };

    return (
        <div className="flex flex-col gap-1 mb-2">
            {/* Top Row: Buttons */}
            <div className="flex justify-between items-center w-full">
                {/* Left: Week/Day */}
                <div className="flex items-center bg-gray-100 rounded-lg overflow-hidden border border-gray-200 shadow-sm">
                    <button
                        onClick={() => toggleView('week')}
                        className={clsx(
                            "w-[90px] sm:w-[100px] h-[40px] text-sm font-semibold transition-colors flex items-center justify-center",
                            toolbar.view === 'week' ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-200"
                        )}
                    >
                        Savaitė
                    </button>
                    <div className="w-[1px] h-[40px] bg-gray-200"></div>
                    <button
                        onClick={() => toggleView('day')}
                        className={clsx(
                            "w-[90px] sm:w-[100px] h-[40px] text-sm font-semibold transition-colors flex items-center justify-center",
                            toolbar.view === 'day' ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-200"
                        )}
                    >
                        Diena
                    </button>
                </div>

                {/* Right: Today */}
                <button
                    onClick={goToToday}
                    className="w-[90px] sm:w-[100px] h-[40px] text-sm font-bold bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 rounded-lg shadow-sm transition-all active:scale-95 flex items-center justify-center"
                >
                    Šiandien
                </button>
            </div>

            {/* Date Label */}
            <div className="text-center py-2">
                <span className="text-lg font-bold text-gray-800 capitalize select-none">
                    {toolbar.label}
                </span>
            </div>
        </div>
    );
};

export default function WorkPlanner() {
    const { currentUser } = useAuth();
    const [events, setEvents] = useState([]);
    const [showManualInput, setShowManualInput] = useState(false);
    const [manualDate, setManualDate] = useState('');
    const [manualStart, setManualStart] = useState('');
    const [manualEnd, setManualEnd] = useState('');
    const [error, setError] = useState('');
    const [editingEvent, setEditingEvent] = useState(null);

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
            await logCalendarChange(currentUser, 'add', start, end);
            setError('');
        } catch (err) {
            console.error("Error adding work hours:", err);
            setError("Nepavyko pridėti darbo valandų.");
        }
    };

    const handleSelectEvent = (event) => {
        setEditingEvent({
            ...event,
            dateStr: format(event.start, 'yyyy-MM-dd'),
            startStr: format(event.start, 'HH:mm'),
            endStr: format(event.end, 'HH:mm')
        });
    };

    const handleUpdateEvent = async (e) => {
        e.preventDefault();
        if (!currentUser || !editingEvent) return;

        try {
            const startDateTime = new Date(`${editingEvent.dateStr}T${editingEvent.startStr}`);
            const endDateTime = new Date(`${editingEvent.dateStr}T${editingEvent.endStr}`);

            if (endDateTime <= startDateTime) {
                setError('Pabaigos laikas turi būti vėlesnis už pradžios laiką.');
                return;
            }

            const eventRef = doc(db, 'work_hours', editingEvent.id);
            await updateDoc(eventRef, {
                start: startDateTime.toISOString(),
                end: endDateTime.toISOString()
            });

            await logCalendarChange(currentUser, 'edit', startDateTime, endDateTime);

            setEditingEvent(null);
            setError('');
        } catch (err) {
            console.error("Error updating work hours:", err);
            setError("Nepavyko atnaujinti darbo valandų.");
        }
    };

    const handleDeleteEvent = async () => {
        if (!currentUser || !editingEvent) return;

        if (window.confirm('Ar tikrai norite ištrinti šį įrašą?')) {
            try {
                await deleteDoc(doc(db, 'work_hours', editingEvent.id));
                await logCalendarChange(currentUser, 'delete', editingEvent.start, editingEvent.end);
                setEditingEvent(null);
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
            await logCalendarChange(currentUser, 'add', startDateTime, endDateTime);

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

    // Generate time options (24h format, 30min intervals)
    const timeOptions = [];
    for (let i = 0; i < 24; i++) {
        const hour = i.toString().padStart(2, '0');
        timeOptions.push(`${hour}:00`);
        timeOptions.push(`${hour}:30`);
    }

    return (
        <div className="w-full relative">
            {/* Floating Add Button */}
            <div className="fixed top-[113px] right-4 z-[60] sm:absolute sm:top-[-40px] sm:right-0">
                <button
                    onClick={() => setShowManualInput(!showManualInput)}
                    className="flex items-center justify-center bg-blue-600 text-white w-12 h-12 rounded-full hover:bg-blue-700 transition-all active:scale-90 shadow-lg border-2 border-white sm:w-auto sm:h-auto sm:px-4 sm:py-2 sm:rounded-lg sm:border-0"
                >
                    <Plus className="w-6 h-6 sm:w-4 sm:h-4" />
                    <span className="hidden sm:inline ml-1.5 text-sm font-semibold">Pridėti rankiniu būdu</span>
                </button>
            </div>

            {error && (
                <div className="mb-3 bg-red-50 border-l-4 border-red-500 p-3 rounded flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-red-500" />
                    <p className="text-xs text-red-700">{error}</p>
                </div>
            )}

            {showManualInput && (
                <form onSubmit={handleManualSubmit} className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-100 shadow-inner">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                            <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">Data</label>
                            <input
                                type="date"
                                value={manualDate}
                                onChange={(e) => setManualDate(e.target.value)}
                                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">Pradžia</label>
                            <input
                                type="time"
                                value={manualStart}
                                onChange={(e) => setManualStart(e.target.value)}
                                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">Pabaiga</label>
                            <input
                                type="time"
                                value={manualEnd}
                                onChange={(e) => setManualEnd(e.target.value)}
                                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                                required
                            />
                        </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                        <button
                            type="submit"
                            className="bg-blue-600 text-white px-4 py-1.5 rounded-md text-sm font-bold hover:bg-blue-700 transition-colors shadow-sm"
                        >
                            Išsaugoti
                        </button>
                        <button
                            type="button"
                            onClick={() => setShowManualInput(false)}
                            className="bg-gray-200 text-gray-700 px-4 py-1.5 rounded-md text-sm font-bold hover:bg-gray-300 transition-colors"
                        >
                            Atšaukti
                        </button>
                    </div>
                </form>
            )}

            <div className="h-[820px] sm:h-[650px] md:h-[750px]">
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
                    min={new Date(1970, 1, 1, 7)}
                    scrollToTime={new Date(1970, 1, 1, 8)}
                    components={{
                        toolbar: CustomToolbar
                    }}
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

            {/* Edit Event Modal */}
            {editingEvent && (
                <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 relative animate-in fade-in zoom-in duration-200">
                        <h3 className="text-lg font-bold text-gray-900 mb-4">Redaguoti laiką</h3>

                        <form onSubmit={handleUpdateEvent}>
                            <div className="grid grid-cols-1 gap-4 mb-6">
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Data</label>
                                    <input
                                        type="date"
                                        value={editingEvent.dateStr}
                                        onChange={(e) => setEditingEvent({ ...editingEvent, dateStr: e.target.value })}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                                        required
                                    />
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Pradžia</label>
                                        <select
                                            value={editingEvent.startStr}
                                            onChange={(e) => setEditingEvent({ ...editingEvent, startStr: e.target.value })}
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white appearance-none"
                                            required
                                        >
                                            {timeOptions.map(time => (
                                                <option key={`start-${time}`} value={time}>{time}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Pabaiga</label>
                                        <select
                                            value={editingEvent.endStr}
                                            onChange={(e) => setEditingEvent({ ...editingEvent, endStr: e.target.value })}
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white appearance-none"
                                            required
                                        >
                                            {timeOptions.map(time => (
                                                <option key={`end-${time}`} value={time}>{time}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center justify-between gap-3">
                                <button
                                    type="button"
                                    onClick={handleDeleteEvent}
                                    className="flex items-center gap-2 px-4 py-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-lg font-medium transition-colors"
                                >
                                    <Trash2 className="w-4 h-4" />
                                    Ištrinti
                                </button>
                                <div className="flex items-center gap-3">
                                    <button
                                        type="button"
                                        onClick={() => setEditingEvent(null)}
                                        className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg font-medium transition-colors"
                                    >
                                        Atšaukti
                                    </button>
                                    <button
                                        type="submit"
                                        className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold shadow-sm transition-transform active:scale-95"
                                    >
                                        Išsaugoti
                                    </button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            <div className="mt-8 p-3 bg-blue-50/30 rounded-lg border border-blue-100/50">
                <p className="text-xs font-bold text-blue-800/70 mb-2 flex items-center gap-1.5">
                    <Info className="w-4 h-4" /> Instrukcija:
                </p>
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-gray-500 list-disc list-inside">
                    <li>Tempkite kalendoriuje laikui žymėti</li>
                    <li>Naudokite "Pridėti" rankiniu būdu</li>
                    <li>Bakstelėkite įrašą trynimui</li>
                    <li>Braukite aukštyn/žemyn laiko pasirinkimui</li>
                </ul>
            </div>
        </div>
    );
}
