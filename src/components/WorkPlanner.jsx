import { useState, useEffect, useRef } from 'react';
import clsx from 'clsx';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay, endOfWeek, subWeeks, addDays } from 'date-fns';
import { lt } from 'date-fns/locale';
import { db } from '../firebase';
import { collection, addDoc, deleteDoc, updateDoc, doc, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { isManagerRole } from '../utils/formatters';
import { Clock, Plus, Trash2, AlertCircle, Info, ChevronLeft, ChevronRight, Home, Palmtree, CheckCircle2, Copy } from 'lucide-react';
import { logCalendarChange } from '../utils/calendarNotifications';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { DeleteConfirmationModal } from './TaskDetailsModals';
import Button from './ui/Button';
import IconButton from './ui/IconButton';

// Map raw / Firebase errors to friendly Lithuanian copy (DESIGN_SYSTEM §10).
// Never surface raw err.message to the user.
const friendlyCalendarError = (err) => {
    const msg = (err && err.message) ? err.message.toLowerCase() : '';
    if (msg.includes('permission') || msg.includes('insufficient')) {
        return 'Jūs neturite leidimo atlikti šį veiksmą.';
    }
    if (msg.includes('network') || msg.includes('unavailable') || msg.includes('offline')) {
        return 'Tinklo klaida. Patikrinkite ryšį ir bandykite dar kartą.';
    }
    return 'Nepavyko pateikti užklausos. Bandykite dar kartą.';
};

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

    // Copy-last-week only works inside the planning window (Fri 13:00–Sun 21:00); the parent
    // passes copyDisabled=true during the work week. It used to render disabled the rest of the
    // week with a title= explaining when it unlocks — but title tooltips never fire on touch
    // (§7), so on a phone it was a dead, unexplained button hogging vertical space. We surface it
    // ONLY when it can actually run, as a clear full-width CTA, keeping the off-window toolbar to
    // two compact rows.
    const showCopy = Boolean(toolbar.onCopyLastWeek) && !toolbar.copyDisabled;

    // Each control is defined once and reused by both layouts below, so the two
    // arrangements (stacked on phones, single row on desktop) never drift apart.
    const todayButton = (
        <Button
            variant="secondary"
            size="md"
            onClick={goToToday}
            className="shrink-0"
        >
            Šiandien
        </Button>
    );

    const viewToggle = (
        <div className="flex items-center bg-surface-sunken rounded-control overflow-hidden border border-line shadow-sm shrink-0" role="group" aria-label="Rodinio pasirinkimas">
            <button
                onClick={() => toggleView('week')}
                aria-pressed={toolbar.view === 'week'}
                className={clsx(
                    "w-[84px] sm:w-[100px] min-h-touch text-body font-semibold transition-colors flex items-center justify-center",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
                    toolbar.view === 'week' ? "bg-brand text-white" : "text-ink hover:bg-surface-sunken"
                )}
            >
                Savaitė
            </button>
            <div className="w-[1px] self-stretch bg-line"></div>
            <button
                onClick={() => toggleView('day')}
                aria-pressed={toolbar.view === 'day'}
                className={clsx(
                    "w-[84px] sm:w-[100px] min-h-touch text-body font-semibold transition-colors flex items-center justify-center",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
                    toolbar.view === 'day' ? "bg-brand text-white" : "text-ink hover:bg-surface-sunken"
                )}
            >
                Diena
            </button>
        </div>
    );

    const periodNav = (
        <div className="flex flex-1 items-center justify-center gap-1 sm:gap-2 min-w-0">
            <IconButton
                icon={ChevronLeft}
                label="Ankstesnis laikotarpis"
                onClick={() => toolbar.onNavigate('PREV')}
                className="shrink-0"
            />
            <span className="min-w-0 truncate text-center text-body-lg sm:text-h3 font-bold text-ink-strong capitalize select-none">
                {toolbar.label}
            </span>
            <IconButton
                icon={ChevronRight}
                label="Kitas laikotarpis"
                onClick={() => toolbar.onNavigate('NEXT')}
                className="shrink-0"
            />
        </div>
    );

    const addButton = (
        <Button
            variant="primary"
            size="md"
            icon={Plus}
            onClick={toolbar.onManualClick}
            className="shrink-0"
        >
            <span className="sm:hidden">Pridėti</span>
            <span className="hidden sm:inline">Pridėti rankiniu būdu</span>
        </Button>
    );

    return (
        <div className="flex flex-col gap-2 mb-2">
            {/* Phone / tablet (<lg): two compact rows — view + create on top, then the
                navigation cluster — so nothing gets squeezed on a ~360px viewport. */}
            <div className="flex flex-col gap-2 lg:hidden">
                {/* pr-12 keeps the create action clear of the fixed profile-avatar bubble
                    pinned to the top-right corner (Layout) — without it they overlap on phones. */}
                <div className="flex items-center justify-between gap-2 pr-12">
                    {viewToggle}
                    {addButton}
                </div>
                <div className="flex items-center gap-2">
                    {todayButton}
                    {periodNav}
                </div>
            </div>

            {/* Desktop (lg+): everything fits one row — Today, the Week/Day toggle, the
                period readout with arrows (centered, flex-1), then the create action far right. */}
            <div className="hidden lg:flex lg:items-center lg:gap-3">
                {todayButton}
                {viewToggle}
                {periodNav}
                {addButton}
            </div>

            {/* Copy last week's plan — only rendered while it can actually run (planning window),
                as a clear full-width CTA exactly when planning is open. */}
            {showCopy && (
                <Button
                    variant="secondary"
                    size="md"
                    icon={Copy}
                    fullWidth
                    onClick={toolbar.onCopyLastWeek}
                    title="Nukopijuoti praėjusios savaitės darbotvarkę į šią savaitę"
                >
                    Kopijuoti praeitą savaitę
                </Button>
            )}
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
    // Which feedback copy the confirmation modal shows: 'sent' (awaiting a manager) or
    // 'approved' (auto-approved + saved). Replaces a banned window.alert (§10).
    const [feedbackVariant, setFeedbackVariant] = useState('sent');

    // Phone detection mirrors the md: breakpoint (768px). On phones the full week grid is
    // unreadable, so the calendar opens in day view; md+ keeps the week overview. This only
    // drives the calendar's *default* view — the toolbar Savaitė/Diena toggle still works.
    const [isPhone, setIsPhone] = useState(
        typeof window !== 'undefined' && window.innerWidth < 768
    );

    // Refs for the three hand-rolled dialog panels, so each can take focus on open
    // and restore focus to the triggering element on close (4.1.2 focus management).
    const editEventPanelRef = useRef(null);
    const approvalFeedbackPanelRef = useRef(null);
    const reasonPanelRef = useRef(null);

    useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return undefined;
        const mql = window.matchMedia('(max-width: 767px)');
        const onChange = (e) => setIsPhone(e.matches);
        setIsPhone(mql.matches);
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, []);

    // Dialog semantics for the three hand-rolled modals: close the open one on Escape,
    // move focus into it on open, and restore focus to the previously focused element on
    // close (2.1.1 / 4.1.2). Keyed on which modal is open so only one is ever active.
    useEffect(() => {
        const openModal = editingEvent
            ? { panelRef: editEventPanelRef, close: () => setEditingEvent(null) }
            : showApprovalFeedback
                ? { panelRef: approvalFeedbackPanelRef, close: () => setShowApprovalFeedback(false) }
                : showReasonModal
                    ? {
                        panelRef: reasonPanelRef,
                        close: () => {
                            setShowReasonModal(false);
                            setReasonValue('');
                            setPendingAction(null);
                        },
                    }
                    : null;

        if (!openModal) return undefined;

        const previouslyFocused = typeof document !== 'undefined' ? document.activeElement : null;

        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                openModal.close();
            }
        };
        document.addEventListener('keydown', handleKeyDown);

        // Move focus into the dialog on open: prefer the first focusable control, fall back
        // to the panel itself (panels carry tabIndex={-1} so they can hold focus).
        const panel = openModal.panelRef.current;
        if (panel) {
            const focusable = panel.querySelector(
                'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
            );
            (focusable || panel).focus();
        }

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
                previouslyFocused.focus();
            }
        };
    }, [editingEvent, showApprovalFeedback, showReasonModal]);

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
        const conflict = events.find(event => (start < event.end && end > event.start));

        if (conflict) {
            setError(overlapMessage(conflict));
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

    // Name the entry an action collides with, so the overlap error points at the real culprit
    // instead of a generic "something overlaps" the worker then has to hunt for.
    const describeEvent = (ev) => {
        const typeLabel = ev.isVacation ? 'Atostogos' : (ev.isWorkFromHome ? 'Darbas iš namų' : 'Darbas');
        return `${typeLabel} ${format(ev.start, 'MM-dd HH:mm')}–${format(ev.end, 'HH:mm')}`;
    };
    const overlapMessage = (ev) => `Pasirinktas laikas persidengia su įrašu: ${describeEvent(ev)}.`;

    // Copy last week's plan into the current week (each entry shifted +7 days). Available only
    // during the free-planning window (approval inactive): copies are direct, auto-approved
    // adds, so allowing them mid-week would bypass the per-change approval the workflow requires.
    const handleCopyLastWeek = async () => {
        if (!currentUser) return;
        if (isApprovalFeatureActive()) {
            setError('Kopijuoti galima tik planavimo metu (penktadienį nuo 13:00 iki sekmadienio 21:00).');
            return;
        }

        const now = new Date();
        const thisWeekStart = startOfWeek(now, { weekStartsOn: 1 });
        const lastWeekStart = subWeeks(thisWeekStart, 1);
        const lastWeekEnd = endOfWeek(lastWeekStart, { weekStartsOn: 1 });

        const lastWeekEvents = events.filter(ev => ev.start >= lastWeekStart && ev.start <= lastWeekEnd);
        if (lastWeekEvents.length === 0) {
            setError('Praėjusią savaitę nėra įrašų, kuriuos būtų galima kopijuoti.');
            return;
        }

        let copied = 0;
        for (const ev of lastWeekEvents) {
            const newStart = addDays(ev.start, 7);
            const newEnd = addDays(ev.end, 7);
            // Sources never overlap each other (the add path forbids it), so the +7 copies don't
            // either; we only skip a copy that lands on an entry already present this week.
            const conflict = events.some(other => newStart < other.end && newEnd > other.start);
            if (conflict) continue;
            await executeDirectCalendarUpdate({
                type: 'add',
                data: {
                    id: null,
                    start: newStart.toISOString(),
                    end: newEnd.toISOString(),
                    title: ev.title,
                    isWorkFromHome: ev.isWorkFromHome || false,
                    isVacation: ev.isVacation || false
                }
            });
            copied++;
        }

        if (copied > 0) {
            setError('');
            setFeedbackVariant('approved');
            setShowApprovalFeedback(true);
        } else {
            setError('Nėra ką kopijuoti — visi praėjusios savaitės įrašai jau turi atitikmenį šią savaitę.');
        }
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

            // Check for overlaps (ignore the entry being edited)
            const conflict = events.find(event =>
                event.id !== editingEvent.id && (startDateTime < event.end && endDateTime > event.start)
            );

            if (conflict) {
                setError(overlapMessage(conflict));
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
            const conflict = events.find(event => (startDateTime < event.end && endDateTime > event.start));

            if (conflict) {
                setError(overlapMessage(conflict));
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
                // Accessible confirmation instead of a banned window.alert (§10).
                setFeedbackVariant('approved');
                setShowApprovalFeedback(true);
            } else {
                setShowReasonModal(false);
                setReasonValue('');
                setPendingAction(null);
                setFeedbackVariant('sent');
                setShowApprovalFeedback(true);
            }
        } catch (err) {
            console.error("Error submitting calendar request:", err);
            setError(friendlyCalendarError(err));
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

    // Evaluated at render so the save buttons + copy control reflect whether changes will go
    // straight in (weekend planning window) or be submitted for a manager's approval (week).
    const approvalActive = isApprovalFeatureActive();

    const components = {
        event: ({ event }) => {
            // Horizontal layout: time first (always readable), then icon + state label.
            // Vacation is a calm "free" state — soft brand (indigo) tint + label, never a
            // near-black block (color is never the sole signal, §5).
            const isVacation = event.isVacation;
            const isWfh = !isVacation && event.isWorkFromHome;
            const stateLabel = isVacation ? 'Atostogos' : isWfh ? 'Iš namų' : 'Dirbtuvėse';
            const eventAriaLabel = `${stateLabel} ${format(event.start, 'HH:mm')}–${format(event.end, 'HH:mm')}, redaguoti`;
            return (
                <div
                    role="button"
                    tabIndex={0}
                    aria-label={eventAriaLabel}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleSelectEvent(event);
                        }
                    }}
                    className={clsx(
                        'flex h-full flex-wrap items-center gap-x-2 gap-y-0.5 overflow-hidden px-1.5 py-0.5 leading-tight rounded-input',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                        // Vacation = calm indigo "free" state (brand, not a session colour);
                        // work events keep the calendar's own (blue) fill, so white text reads.
                        isVacation ? 'bg-brand-soft text-brand-hover' : 'text-white'
                    )}
                >
                    <span className="text-caption font-mono font-semibold tabular-nums">
                        {format(event.start, 'HH:mm')}
                    </span>
                    <span className="flex items-center gap-1 text-caption font-semibold">
                        {isVacation ? (
                            <>
                                <Palmtree className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                                <span>Atostogos</span>
                            </>
                        ) : isWfh ? (
                            <>
                                <Home className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                                <span>Iš namų</span>
                            </>
                        ) : (
                            <span>Dirbtuvėse</span>
                        )}
                    </span>
                </div>
            );
        },
        toolbar: (props) => (
            <CustomToolbar
                {...props}
                onManualClick={() => setShowManualInput(!showManualInput)}
                onCopyLastWeek={handleCopyLastWeek}
                copyDisabled={approvalActive}
            />
        )
    };

    return (
        <div className="w-full relative">
            {/* Floating button removed */}

            {error && (
                <div role="alert" className="mb-3 bg-feedback-danger/10 border-l-4 border-feedback-danger p-3 rounded-card flex items-start gap-2">
                    <AlertCircle className="w-5 h-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-feedback-danger">
                        <span className="font-semibold">Klaida: </span>{error}
                    </p>
                </div>
            )}

            {showManualInput && (
                <form onSubmit={handleManualSubmit} className="mb-4 p-3 bg-surface-base rounded-card border border-line shadow-inner">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                            <label htmlFor="manualDate" className="block text-caption uppercase tracking-wider font-bold text-ink-muted mb-1">Data</label>
                            <input
                                id="manualDate"
                                type="date"
                                value={manualDate}
                                onChange={(e) => setManualDate(e.target.value)}
                                className="w-full px-2 py-2 text-body-lg border border-line rounded-input focus:ring-2 focus:ring-brand outline-none transition-all"
                                required
                            />
                        </div>
                        <div>
                            <label htmlFor="manualStart" className="block text-caption uppercase tracking-wider font-bold text-ink-muted mb-1">Pradžia</label>
                            <input
                                id="manualStart"
                                type="time"
                                value={manualStart}
                                onChange={(e) => setManualStart(e.target.value)}
                                className="w-full px-2 py-2 text-body-lg border border-line rounded-input focus:ring-2 focus:ring-brand outline-none transition-all"
                                required
                            />
                        </div>
                        <div>
                            <label htmlFor="manualEnd" className="block text-caption uppercase tracking-wider font-bold text-ink-muted mb-1">Pabaiga</label>
                            <input
                                id="manualEnd"
                                type="time"
                                value={manualEnd}
                                onChange={(e) => setManualEnd(e.target.value)}
                                className="w-full px-2 py-2 text-body-lg border border-line rounded-input focus:ring-2 focus:ring-brand outline-none transition-all"
                                required
                            />
                        </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                        <label className="flex min-h-touch items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={manualIsWorkFromHome}
                                onChange={(e) => {
                                    setManualIsWorkFromHome(e.target.checked);
                                    if (e.target.checked) setManualIsVacation(false);
                                }}
                                className="w-5 h-5 text-brand rounded border-line focus-visible:ring-2 focus-visible:ring-brand"
                            />
                            <span className="text-body font-medium text-ink">Darbas iš namų</span>
                        </label>
                        <label className="flex min-h-touch items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={manualIsVacation}
                                onChange={(e) => {
                                    setManualIsVacation(e.target.checked);
                                    if (e.target.checked) setManualIsWorkFromHome(false);
                                }}
                                className="w-5 h-5 text-brand rounded border-line focus-visible:ring-2 focus-visible:ring-brand"
                            />
                            <span className="text-body font-medium text-ink">Atostogos</span>
                        </label>
                    </div>
                    <div className="flex gap-2 mt-4">
                        <Button type="submit" variant="primary" size="md">
                            {approvalActive ? 'Pateikti tvirtinimui' : 'Išsaugoti'}
                        </Button>
                        <Button type="button" variant="secondary" size="md" onClick={() => setShowManualInput(false)}>
                            Atšaukti
                        </Button>
                    </div>
                    <p className="mt-2 text-caption text-ink-muted">
                        {approvalActive
                            ? 'Pakeitimą turės patvirtinti vadovas — reikės nurodyti priežastį.'
                            : 'Planavimo metu pakeitimai išsaugomi ir patvirtinami iš karto.'}
                    </p>
                </form>
            )
            }

            <div className="h-[820px] sm:h-[650px] md:h-[750px]">
                <Calendar
                    key={isPhone ? 'day' : 'week'}
                    localizer={localizer}
                    events={events}
                    startAccessor="start"
                    endAccessor="end"
                    culture="lt"
                    selectable
                    onSelectSlot={handleSelectSlot}
                    onSelectEvent={handleSelectEvent}
                    defaultView={isPhone ? 'day' : 'week'}
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
                    <div className="fixed inset-0 z-top flex items-center justify-center p-4 bg-feedback-scrim backdrop-blur-sm">
                        <div
                            ref={editEventPanelRef}
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="edit-event-title"
                            tabIndex={-1}
                            className="bg-surface-card rounded-modal shadow-xl w-full max-w-md p-6 relative animate-in fade-in zoom-in duration-200 focus-visible:outline-none"
                        >
                            <h3 id="edit-event-title" className="text-h2 text-ink-strong mb-4">
                                {editingEvent.id ? 'Redaguoti laiką' : 'Pridėti darbo laiką'}
                            </h3>

                            <form onSubmit={handleUpdateEvent}>
                                <div className="grid grid-cols-1 gap-4 mb-6">
                                    <div>
                                        <label htmlFor="editDate" className="block text-caption font-bold text-ink-muted uppercase tracking-wider mb-1">Data</label>
                                        <input
                                            id="editDate"
                                            type="date"
                                            value={editingEvent.dateStr}
                                            onChange={(e) => setEditingEvent({ ...editingEvent, dateStr: e.target.value })}
                                            className="w-full px-3 py-2.5 text-body-lg border border-line rounded-input focus:ring-2 focus:ring-brand outline-none"
                                            required
                                        />
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label htmlFor="editStart" className="block text-caption font-bold text-ink-muted uppercase tracking-wider mb-1">Pradžia</label>
                                            <select
                                                id="editStart"
                                                value={editingEvent.startStr}
                                                onChange={(e) => setEditingEvent({ ...editingEvent, startStr: e.target.value })}
                                                className="w-full px-3 py-2.5 text-body-lg border border-line rounded-input focus:ring-2 focus:ring-brand outline-none bg-surface-card appearance-none"
                                                required
                                            >
                                                {timeOptions.map(time => (
                                                    <option key={`start-${time}`} value={time}>{time}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div>
                                            <label htmlFor="editEnd" className="block text-caption font-bold text-ink-muted uppercase tracking-wider mb-1">Pabaiga</label>
                                            <select
                                                id="editEnd"
                                                value={editingEvent.endStr}
                                                onChange={(e) => setEditingEvent({ ...editingEvent, endStr: e.target.value })}
                                                className="w-full px-3 py-2.5 text-body-lg border border-line rounded-input focus:ring-2 focus:ring-brand outline-none bg-surface-card appearance-none"
                                                required
                                            >
                                                {timeOptions.map(time => (
                                                    <option key={`end-${time}`} value={time}>{time}</option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
                                    <label className="flex min-h-touch items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={editingEvent.isWorkFromHome}
                                            onChange={(e) => setEditingEvent({
                                                ...editingEvent,
                                                isWorkFromHome: e.target.checked,
                                                isVacation: e.target.checked ? false : editingEvent.isVacation
                                            })}
                                            className="w-5 h-5 text-brand rounded border-line focus-visible:ring-2 focus-visible:ring-brand"
                                        />
                                        <span className="text-body font-medium text-ink">Darbas iš namų</span>
                                    </label>
                                    <label className="flex min-h-touch items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={editingEvent.isVacation}
                                            onChange={(e) => setEditingEvent({
                                                ...editingEvent,
                                                isVacation: e.target.checked,
                                                isWorkFromHome: e.target.checked ? false : editingEvent.isWorkFromHome
                                            })}
                                            className="w-5 h-5 text-brand rounded border-line focus-visible:ring-2 focus-visible:ring-brand"
                                        />
                                        <span className="text-body font-medium text-ink">Atostogos</span>
                                    </label>
                                </div>


                                <div className="flex items-center justify-between gap-3 pt-4">
                                    {editingEvent.id ? (
                                        <Button
                                            type="button"
                                            variant="danger"
                                            size="md"
                                            icon={Trash2}
                                            onClick={handleDeleteEvent}
                                        >
                                            <span className="hidden sm:inline">Ištrinti</span>
                                            <span className="sm:hidden">Trinti</span>
                                        </Button>
                                    ) : (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            size="md"
                                            onClick={() => setEditingEvent(null)}
                                        >
                                            Atšaukti
                                        </Button>
                                    )}

                                    <div className="flex items-center gap-3">
                                        {editingEvent.id && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="md"
                                                onClick={() => setEditingEvent(null)}
                                            >
                                                Atšaukti
                                            </Button>
                                        )}
                                        <Button type="submit" variant="primary" size="md">
                                            {approvalActive ? 'Pateikti tvirtinimui' : 'Išsaugoti'}
                                        </Button>
                                    </div>
                                </div>
                                <p className="mt-3 text-caption text-ink-muted">
                                    {approvalActive
                                        ? 'Pakeitimą turės patvirtinti vadovas — reikės nurodyti priežastį.'
                                        : 'Planavimo metu pakeitimai išsaugomi ir patvirtinami iš karto.'}
                                </p>
                            </form>
                        </div >
                    </div >
                )
            }

            <div className="mt-8 p-3 bg-brand-soft rounded-card border border-line">
                <p className="text-body font-bold text-brand mb-2 flex items-center gap-1.5">
                    <Info className="w-4 h-4" aria-hidden="true" /> Instrukcija:
                </p>
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-caption text-ink list-disc list-inside">
                    <li>Tempkite kalendoriuje laikui žymėti</li>
                    <li>Naudokite &quot;Pridėti&quot; rankiniu būdu</li>
                    <li>Bakstelėkite įrašą trynimui</li>
                    <li>Braukite aukštyn/žemyn laiko pasirinkimui</li>
                </ul>
            </div>

            {/* Approval Logic Confirmation Modal */}
            {showApprovalFeedback && (
                <div className="fixed inset-0 z-top flex items-center justify-center p-4 bg-feedback-scrim backdrop-blur-sm">
                    <div
                        ref={approvalFeedbackPanelRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="approval-feedback-title"
                        tabIndex={-1}
                        className="bg-surface-card rounded-modal shadow-xl w-full max-w-sm p-8 text-center animate-in zoom-in duration-300 focus-visible:outline-none"
                    >
                        {feedbackVariant === 'approved' ? (
                            <div className="w-16 h-16 bg-feedback-success/10 text-feedback-success rounded-full flex items-center justify-center mx-auto mb-4">
                                <CheckCircle2 className="w-8 h-8" aria-hidden="true" />
                            </div>
                        ) : (
                            <div className="w-16 h-16 bg-brand-soft text-brand rounded-full flex items-center justify-center mx-auto mb-4">
                                <Clock className="w-8 h-8" aria-hidden="true" />
                            </div>
                        )}
                        <h3 id="approval-feedback-title" className="text-h2 text-ink-strong mb-2">
                            {feedbackVariant === 'approved' ? 'Pakeitimas išsaugotas' : 'Užklausa išsiųsta'}
                        </h3>
                        <p className="text-body text-ink-muted mb-6">
                            {feedbackVariant === 'approved'
                                ? 'Pakeitimas išsaugotas ir automatiškai patvirtintas.'
                                : 'Jūsų pakeitimus turi patvirtinti vadovas.'}
                        </p>
                        <Button variant="primary" size="lg" fullWidth onClick={() => setShowApprovalFeedback(false)}>
                            Supratau
                        </Button>
                    </div>
                </div>
            )}

            {/* Reason Modal */}
            {showReasonModal && (
                <div className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-feedback-scrim backdrop-blur-sm">
                    <div
                        ref={reasonPanelRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="reason-modal-title"
                        tabIndex={-1}
                        className="bg-surface-card rounded-modal shadow-xl w-full max-w-md p-6 animate-in fade-in slide-in-from-bottom-4 duration-300 focus-visible:outline-none"
                    >
                        <h3 id="reason-modal-title" className="text-h2 text-ink-strong mb-2">Pakeitimų priežastis</h3>
                        <label htmlFor="reasonValue" className="block text-body text-ink-muted mb-4">Prašome nurodyti kodėl darote šį pakeitimą (min. 10 simbolių).</label>

                        <textarea
                            id="reasonValue"
                            value={reasonValue}
                            onChange={(e) => setReasonValue(e.target.value)}
                            placeholder="Pvz.: Keičiamas darbo laikas dėl vizito pas gydytoją..."
                            className="w-full h-32 px-4 py-3 border border-line rounded-input focus:ring-2 focus:ring-brand outline-none resize-none text-body-lg transition-all"
                            autoFocus
                        />

                        <div className="mt-2 flex justify-end">
                            <span
                                aria-live="polite"
                                className={clsx(
                                    "text-caption font-bold uppercase tracking-wider",
                                    reasonValue.length >= 10 ? "text-feedback-success" : "text-ink-muted"
                                )}
                            >
                                Simbolių: {reasonValue.length}/10
                            </span>
                        </div>

                        <div className="flex gap-3 mt-6">
                            <Button
                                variant="secondary"
                                size="lg"
                                fullWidth
                                onClick={() => {
                                    setShowReasonModal(false);
                                    setReasonValue('');
                                    setPendingAction(null);
                                }}
                            >
                                Atšaukti
                            </Button>
                            <Button
                                variant="primary"
                                size="lg"
                                fullWidth
                                onClick={submitCalendarRequest}
                                disabled={reasonValue.length < 10}
                            >
                                Pateikti
                            </Button>
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

