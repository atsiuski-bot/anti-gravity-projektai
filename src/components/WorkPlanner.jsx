import { useState, useEffect } from 'react';
import clsx from 'clsx';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { lt } from 'date-fns/locale';
import { db } from '../firebase';
import { collection, addDoc, deleteDoc, updateDoc, doc, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { isManagerRole } from '../utils/formatters';
import { Clock, Plus, Trash2, AlertCircle, Info, ChevronLeft, ChevronRight, Home, Palmtree } from 'lucide-react';
import { logCalendarChange } from '../utils/calendarNotifications';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { DeleteConfirmationModal } from './TaskDetailsModals';

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

                {/* Right: Today & Manual Add */}
                <div className="flex flex-col gap-2 items-end">
                    <button
                        onClick={goToToday}
                        className="w-[90px] sm:w-[100px] h-[40px] text-sm font-bold bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 rounded-lg shadow-sm transition-all active:scale-95 flex items-center justify-center"
                    >
                        Šiandien
                    </button>
                    <button
                        onClick={toolbar.onManualClick}
                        className="flex items-center justify-center bg-blue-600 text-white px-2 py-1 rounded-md hover:bg-blue-700 transition-all active:scale-90 shadow-sm text-[10px] font-semibold"
                    >
                        <Plus className="w-3 h-3 mr-1" />
                        Pridėti rankiniu būdu
                    </button>
                </div>
            </div>

            {/* Date Label & Navigation */}
            <div className="flex items-center justify-center gap-4 py-2">
                <button
                    onClick={() => toolbar.onNavigate('PREV')}
                    className="p-1 hover:bg-gray-200 rounded-full transition-colors text-gray-600"
                    aria-label="Atgal"
                >
                    <ChevronLeft className="w-6 h-6" />
                </button>

                <span className="text-lg font-bold text-gray-800 capitalize select-none min-w-[140px] text-center">
                    {toolbar.label}
                </span>

                <button
                    onClick={() => toolbar.onNavigate('NEXT')}
                    className="p-1 hover:bg-gray-200 rounded-full transition-colors text-gray-600"
                    aria-label="Pirmyn"
                >
                    <ChevronRight className="w-6 h-6" />
                </button>
            </div>
        </div>
    );
};

export default function WorkPlanner() {
    const { currentUser, userData, userRole } = useAuth();
    const [events, setEvents] = useState([]);
    const [showManualInput, setShowManualInput] = useState(false);
    const [manualDate, setManualDate] = useState('');
    const [manualStart, setManualStart] = useState('');
    const [manualEnd, setManualEnd] = useState('');
    const [error, setError] = useState('');
    const [editingEvent, setEditingEvent] = useState(null);
    const [manualIsWorkFromHome, setManualIsWorkFromHome] = useState(false);
    const [manualIsVacation, setManualIsVacation] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);

    // Approval workflow states
    const [showReasonModal, setShowReasonModal] = useState(false);
    const [reasonValue, setReasonValue] = useState('');
    const [pendingAction, setPendingAction] = useState(null); // { type: 'add'|'edit'|'delete', data: {} }
    const [showApprovalFeedback, setShowApprovalFeedback] = useState(false);

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
                    isWorkFromHome: data.isWorkFromHome || false,
                    isVacation: data.isVacation || false,
                };
            });
            setEvents(hoursData);
        }, (err) => {
            console.error("Error fetching work hours:", err);
            setError("Nepavyko užkrauti darbo valandų.");
        });

        return () => unsubscribe();
    }, [currentUser]);

    const handleSelectSlot = ({ start, end }) => {
        if (!currentUser) return;

        // Check for overlaps
        const hasOverlap = events.some(event => {
            return (start < event.end && end > event.start);
        });

        if (hasOverlap) {
            setError('Pasirinktas laikas persidengia su jau esamu įrašu.');
            return;
        }

        setEditingEvent({
            id: null, // null ID indicates new event
            start,
            end,
            dateStr: format(start, 'yyyy-MM-dd'),
            startStr: format(start, 'HH:mm'),
            endStr: format(end, 'HH:mm'),
            isWorkFromHome: false,
            isVacation: false
        });
        setError('');
    };

    const handleSelectEvent = (event) => {
        setEditingEvent({
            ...event,
            dateStr: format(event.start, 'yyyy-MM-dd'),
            startStr: format(event.start, 'HH:mm'),
            endStr: format(event.end, 'HH:mm'),
            isWorkFromHome: event.isWorkFromHome || false,
            isVacation: event.isVacation || false
        });
    };

    const isApprovalFeatureActive = () => {
        const now = new Date();
        const day = now.getDay(); // 0 is Sunday, 5 is Friday
        const hour = now.getHours();
        
        // Disable from Friday 13:00 to Sunday 21:00 inclusive
        if (day === 5 && hour >= 13) return false; // Friday after 13:00
        if (day === 6) return false; // Saturday all day
        if (day === 0 && hour < 21) return false; // Sunday before 21:00
        
        return true;
    };

    const executeDirectCalendarUpdate = async (action) => {
        try {
            if (action.type === 'add') {
                await addDoc(collection(db, 'work_hours'), {
                    ...action.data,
                    userId: currentUser.uid,
                    type: 'planned'
                });
            } else if (action.type === 'edit') {
                await updateDoc(doc(db, 'work_hours', action.data.id), {
                    start: action.data.start,
                    end: action.data.end,
                    title: action.data.title,
                    isWorkFromHome: action.data.isWorkFromHome,
                    isVacation: action.data.isVacation
                });
            } else if (action.type === 'delete') {
                await deleteDoc(doc(db, 'work_hours', action.data.id));
            }

            // Atviro lango metu sistemos atlikti automatiniai patvirtinimai 
            const requestData = {
                userId: currentUser.uid,
                userName: currentUser.displayName || currentUser.email,
                managerId: null, // Sistema automatiškai tvirtina, nereikia vadovo pranešimams per kraštą lipti
                type: action.type,
                reason: 'PlanningTime', // Specialus žymėjimas 
                status: 'approved',
                userDismissed: true,    // Kad nerodytu floating toaster
                createdAt: new Date().toISOString(),
                approvedAt: new Date().toISOString(),
                approvedBy: 'system',
                requestedEvent: action.data,
                originalEvent: action.originalEvent || null
            };

            const cleanRequestData = JSON.parse(JSON.stringify(requestData));
            await addDoc(collection(db, 'calendar_requests'), cleanRequestData);

            await logCalendarChange(
                currentUser, 
                action.type === 'edit' ? 'edit' : action.type, 
                new Date(action.data.start), 
                new Date(action.data.end)
            );
        } catch (err) {
            console.error("Error direct updating calendar:", err);
            setError("Nepavyko atnaujinti kalendoriaus.");
        }
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

            // Check for overlaps
            const hasOverlap = events.some(event => {
                if (event.id === editingEvent.id) return false; // Skip current event if editing
                return (startDateTime < event.end && endDateTime > event.start);
            });

            if (hasOverlap) {
                setError('Pasirinktas laikas persidengia su jau esamu įrašu.');
                return;
            }

            const title = editingEvent.isVacation ? 'Atostogos' : 'Darbas';
            
            const actionDetails = {
                type: editingEvent.id ? 'edit' : 'add',
                data: {
                    id: editingEvent.id || null,
                    start: startDateTime.toISOString(),
                    end: endDateTime.toISOString(),
                    title: title,
                    isWorkFromHome: editingEvent.isWorkFromHome || false,
                    isVacation: editingEvent.isVacation || false
                },
                originalEvent: editingEvent.id ? events.find(e => e.id === editingEvent.id) : null
            };

            if (isApprovalFeatureActive()) {
                setPendingAction(actionDetails);
                setShowReasonModal(true);
            } else {
                await executeDirectCalendarUpdate(actionDetails);
            }
            
            setEditingEvent(null);
            setError('');
        } catch (err) {
            console.error("Error preparing work hours:", err);
            setError("Nepavyko paruošti duomenų.");
        }
    };

    const handleDeleteEvent = () => {
        if (!currentUser || !editingEvent) return;
        setShowDeleteModal(true);
    };

    const confirmDelete = async () => {
        if (!currentUser || !editingEvent) return;
        const actionDetails = {
            type: 'delete',
            data: {
                id: editingEvent.id,
                start: editingEvent.start.toISOString(),
                end: editingEvent.end.toISOString(),
                title: editingEvent.title,
                isWorkFromHome: editingEvent.isWorkFromHome,
                isVacation: editingEvent.isVacation
            },
            originalEvent: editingEvent
        };
        setShowDeleteModal(false);
        setEditingEvent(null);
        
        if (isApprovalFeatureActive()) {
            setPendingAction(actionDetails);
            setShowReasonModal(true);
        } else {
            await executeDirectCalendarUpdate(actionDetails);
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

            // Check for overlaps
            const hasOverlap = events.some(event => {
                return (startDateTime < event.end && endDateTime > event.start);
            });

            if (hasOverlap) {
                setError('Pasirinktas laikas persidengia su jau esamu įrašu.');
                return;
            }

            const title = manualIsVacation ? 'Atostogos' : 'Darbas';

            const actionDetails = {
                type: 'add',
                data: {
                    id: null,
                    start: startDateTime.toISOString(),
                    end: endDateTime.toISOString(),
                    title: title,
                    isWorkFromHome: manualIsWorkFromHome || false,
                    isVacation: manualIsVacation || false
                }
            };

            if (isApprovalFeatureActive()) {
                setPendingAction(actionDetails);
                setShowReasonModal(true);
                setShowManualInput(false);
            } else {
                await executeDirectCalendarUpdate(actionDetails);
                setShowManualInput(false);
            }

            // Reset form
            setManualDate('');
            setManualStart('');
            setManualEnd('');
            setManualIsWorkFromHome(false);
            setManualIsVacation(false);
            setError('');
        } catch (err) {
            console.error("Error preparing manual work hours:", err);
            setError("Nepavyko paruošti duomenų.");
        }
    };

    const submitCalendarRequest = async () => {
        if (!currentUser || !pendingAction || reasonValue.length < 10) return;

        try {
            const isManagerOrAdmin = isManagerRole(userRole);
            const managerId = userData?.defaultManager || (isManagerOrAdmin ? currentUser.uid : null);

            const requestData = {
                userId: currentUser.uid,
                userName: userData?.displayName || currentUser.displayName || currentUser.email,
                managerId: managerId,
                type: pendingAction.type,
                reason: reasonValue,
                status: 'pending',
                userDismissed: false,
                createdAt: new Date().toISOString(),
                requestedEvent: pendingAction.data,
                originalEvent: pendingAction.originalEvent || null
            };

            // If user is manager/admin and approving themselves
            let isAutoApproved = false;
            if (isManagerOrAdmin && managerId === currentUser.uid) {
                // Auto-approve logic
                if (pendingAction.type === 'add') {
                    await addDoc(collection(db, 'work_hours'), {
                        ...pendingAction.data,
                        userId: currentUser.uid,
                        type: 'planned'
                    });
                } else if (pendingAction.type === 'edit') {
                    await updateDoc(doc(db, 'work_hours', pendingAction.data.id), {
                        start: pendingAction.data.start,
                        end: pendingAction.data.end,
                        title: pendingAction.data.title,
                        isWorkFromHome: pendingAction.data.isWorkFromHome,
                        isVacation: pendingAction.data.isVacation
                    });
                } else if (pendingAction.type === 'delete') {
                    await deleteDoc(doc(db, 'work_hours', pendingAction.data.id));
                }
                
                requestData.status = 'approved';
                requestData.approvedAt = new Date().toISOString();
                requestData.approvedBy = currentUser.uid;
                isAutoApproved = true;
            }

            // Clean data of undefined fields to prevent Firebase errors
            const cleanRequestData = JSON.parse(JSON.stringify(requestData));
            await addDoc(collection(db, 'calendar_requests'), cleanRequestData);

            if (isAutoApproved) {
                // Legacy logging
                await logCalendarChange(
                    currentUser, 
                    pendingAction.type === 'edit' ? 'edit' : pendingAction.type, 
                    new Date(pendingAction.data.start), 
                    new Date(pendingAction.data.end)
                );

                // Instantly clean up
                setShowReasonModal(false);
                setReasonValue('');
                setPendingAction(null);
                setError('');
                // Give a visual indication, or just alert/toast
                alert('Pakeitimas išsaugotas ir automatiškai patvirtintas.');
            } else {
                setShowReasonModal(false);
                setReasonValue('');
                setPendingAction(null);
                setShowApprovalFeedback(true);
            }
        } catch (err) {
            console.error("Error submitting calendar request:", err);
            setError("Nepavyko pateikti užklausos: " + (err.message || 'Įvyko klaida'));
            setShowReasonModal(false);
            setReasonValue('');
        }
    };


    // Generate time options (24h format, 30min intervals)
    const timeOptions = [];
    for (let i = 0; i < 24; i++) {
        const hour = i.toString().padStart(2, '0');
        timeOptions.push(`${hour}:00`);
        timeOptions.push(`${hour}:30`);
    }

    const components = {
        event: ({ event }) => (
            <div className={`flex flex-col h-full justify-center px-1 leading-tight ${event.isVacation ? 'bg-black/10' : ''}`} style={{ writingMode: 'vertical-rl', textOrientation: 'sideways' }}>
                <div className="font-semibold text-xs flex items-center gap-1">
                    {event.isVacation ? (
                        <>
                            <Palmtree className="w-3 h-3 rotate-90" />
                            <span>Atostogos</span>
                        </>
                    ) : event.isWorkFromHome ? (
                        <>
                            <Home className="w-3 h-3 rotate-90" />
                            <span>Iš namų</span>
                        </>
                    ) : (
                        <span>Dirbtuvėse</span>
                    )}
                </div>
            </div>
        ),
        toolbar: (props) => (
            <CustomToolbar
                {...props}
                onManualClick={() => setShowManualInput(!showManualInput)}
            />
        )
    };

    return (
        <div className="w-full relative">
            {/* Floating button removed */}

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
                    <div className="mt-3 flex gap-4">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={manualIsWorkFromHome}
                                onChange={(e) => {
                                    setManualIsWorkFromHome(e.target.checked);
                                    if (e.target.checked) setManualIsVacation(false);
                                }}
                                className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                            />
                            <span className="text-sm font-medium text-gray-700">Darbas iš namų</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={manualIsVacation}
                                onChange={(e) => {
                                    setManualIsVacation(e.target.checked);
                                    if (e.target.checked) setManualIsWorkFromHome(false);
                                }}
                                className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                            />
                            <span className="text-sm font-medium text-gray-700">Atostogos</span>
                        </label>
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
            )
            }

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
                    components={components}
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
            {
                editingEvent && (
                    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
                        <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 relative animate-in fade-in zoom-in duration-200">
                            <h3 className="text-lg font-bold text-gray-900 mb-4">
                                {editingEvent.id ? 'Redaguoti laiką' : 'Pridėti darbo laiką'}
                            </h3>

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
                                <div className="mt-4 flex gap-4">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={editingEvent.isWorkFromHome}
                                            onChange={(e) => setEditingEvent({
                                                ...editingEvent,
                                                isWorkFromHome: e.target.checked,
                                                isVacation: e.target.checked ? false : editingEvent.isVacation
                                            })}
                                            className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                                        />
                                        <span className="text-sm font-medium text-gray-700">Darbas iš namų</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={editingEvent.isVacation}
                                            onChange={(e) => setEditingEvent({
                                                ...editingEvent,
                                                isVacation: e.target.checked,
                                                isWorkFromHome: e.target.checked ? false : editingEvent.isWorkFromHome
                                            })}
                                            className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                                        />
                                        <span className="text-sm font-medium text-gray-700">Atostogos</span>
                                    </label>
                                </div>


                                <div className="flex items-center justify-between gap-3 pt-2">
                                    {editingEvent.id ? (
                                        <button
                                            type="button"
                                            onClick={handleDeleteEvent}
                                            className="flex items-center gap-2 px-4 py-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-lg font-medium transition-colors"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                            <span className="hidden sm:inline">Ištrinti</span>
                                            <span className="sm:hidden">Trinti</span>
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => setEditingEvent(null)}
                                            className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors"
                                        >
                                            Atšaukti
                                        </button>
                                    )}

                                    <div className="flex items-center gap-3">
                                        {editingEvent.id && (
                                            <button
                                                type="button"
                                                onClick={() => setEditingEvent(null)}
                                                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg font-medium transition-colors"
                                            >
                                                Atšaukti
                                            </button>
                                        )}
                                        <button
                                            type="submit"
                                            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold shadow-sm transition-transform active:scale-95"
                                        >
                                            Išsaugoti
                                        </button>
                                    </div>
                                </div>
                            </form>
                        </div >
                    </div >
                )
            }

            <div className="mt-8 p-3 bg-blue-50/30 rounded-lg border border-blue-100/50">
                <p className="text-xs font-bold text-blue-800/70 mb-2 flex items-center gap-1.5">
                    <Info className="w-4 h-4" /> Instrukcija:
                </p>
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-gray-500 list-disc list-inside">
                    <li>Tempkite kalendoriuje laikui žymėti</li>
                    <li>Naudokite &quot;Pridėti&quot; rankiniu būdu</li>
                    <li>Bakstelėkite įrašą trynimui</li>
                    <li>Braukite aukštyn/žemyn laiko pasirinkimui</li>
                </ul>
            </div>

            {/* Approval Logic Confirmation Modal */}
            {showApprovalFeedback && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-8 text-center animate-in zoom-in duration-300">
                        <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Clock className="w-8 h-8" />
                        </div>
                        <h3 className="text-xl font-bold text-gray-900 mb-2">Užklausa išsiųsta</h3>
                        <p className="text-gray-600 mb-6">Jūsų pakeitimus turi patvirtinti vadovas.</p>
                        <button
                            onClick={() => setShowApprovalFeedback(false)}
                            className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold transition-transform active:scale-95 shadow-lg shadow-blue-200"
                        >
                            Supratau
                        </button>
                    </div>
                </div>
            )}

            {/* Reason Modal */}
            {showReasonModal && (
                <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
                        <h3 className="text-xl font-bold text-gray-900 mb-2">Pakeitimų priežastis</h3>
                        <p className="text-sm text-gray-500 mb-4">Prašome nurodyti kodėl darote šį pakeitimą (min. 10 simbolių).</p>
                        
                        <textarea
                            value={reasonValue}
                            onChange={(e) => setReasonValue(e.target.value)}
                            placeholder="Pvz.: Keičiamas darbo laikas dėl vizito pas gydytoją..."
                            className="w-full h-32 px-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none resize-none text-sm transition-all"
                            autoFocus
                        />
                        
                        <div className="mt-2 flex justify-end">
                            <span className={clsx(
                                "text-[10px] font-bold uppercase tracking-wider",
                                reasonValue.length >= 10 ? "text-green-500" : "text-gray-400"
                            )}>
                                Simbolių: {reasonValue.length}/10
                            </span>
                        </div>

                        <div className="flex gap-3 mt-6">
                            <button
                                onClick={() => {
                                    setShowReasonModal(false);
                                    setReasonValue('');
                                    setPendingAction(null);
                                }}
                                className="flex-1 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-bold transition-colors"
                            >
                                Atšaukti
                            </button>
                            <button
                                onClick={submitCalendarRequest}
                                disabled={reasonValue.length < 10}
                                className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-xl font-bold transition-all shadow-lg shadow-blue-200 active:scale-95"
                            >
                                Pateikti
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <DeleteConfirmationModal
                isOpen={showDeleteModal}
                onClose={() => setShowDeleteModal(false)}
                onConfirm={confirmDelete}
                taskTitle={editingEvent?.title || 'Darbo laiko įrašą'}
                isTask={false}
            />
        </div >
    );
}

