import { useState, useEffect } from 'react';
import clsx from 'clsx';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay, endOfWeek, subWeeks, addDays } from 'date-fns';
import { lt } from 'date-fns/locale';
import { db } from '../firebase';
import { collection, addDoc, deleteDoc, updateDoc, doc, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { isManagerRole } from '../utils/formatters';
import { Clock, Plus, Trash2, AlertCircle, ChevronLeft, ChevronRight, Home, Palmtree, CheckCircle2, Copy } from 'lucide-react';
import { logCalendarChange } from '../utils/calendarNotifications';
import { preventEnterSubmit } from '../utils/formUtils';
import { absenceLabel, absenceTypeForWrite, ABSENCE_GENERIC_LABEL } from '../utils/absence';
import { workLocationLabel, defaultIsWorkFromHome } from '../utils/workLocation';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { DeleteConfirmationModal } from './TaskDetailsModals';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import Modal from './ui/Modal';
import InfoPopover from './ui/InfoPopover';
import Select from './ui/Select';
import DatePicker from './ui/DatePicker';

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
        <div className="flex items-center gap-2 shrink-0">
            {/* Usage tips tucked behind an info icon, left of the primary create action. */}
            <InfoPopover label="Instrukcija" align="right">
                <p className="mb-1.5 font-bold text-brand">Instrukcija:</p>
                <ul className="list-disc space-y-1 pl-5 marker:text-ink-muted">
                    <li>Tempkite kalendoriuje laikui žymėti</li>
                    <li>Naudokite &quot;Pridėti&quot; rankiniu būdu</li>
                    <li>Bakstelėkite įrašą trynimui</li>
                    <li>Braukite aukštyn/žemyn laiko pasirinkimui</li>
                </ul>
            </InfoPopover>
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
        </div>
    );

    return (
        <div className="flex flex-col gap-2 mb-2">
            {/* Phone / tablet (<lg): two compact rows — view + create on top, then the
                navigation cluster — so nothing gets squeezed on a ~360px viewport. */}
            <div className="flex flex-col gap-2 lg:hidden">
                {/* The create action sits flush at the right edge: the profile avatar now lives
                    in the sticky AppHeader bar above the content (Layout), not a floating bubble
                    overlapping it, so no right-side clearance is needed. */}
                <div className="flex items-center justify-between gap-2">
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
    const [manualIsWorkFromHome, setManualIsWorkFromHome] = useState(() => defaultIsWorkFromHome(userData?.defaultWorkLocation));
    const [manualIsVacation, setManualIsVacation] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);

    // Absence (reason-agnostic "not working") sub-form. An absence may span a date RANGE — booking a
    // week off is one action — and may be marked "visą dieną" (whole-day, 00:00–24:00) so the worker
    // need not invent start/end clock times for a day they simply are not available.
    const [manualEndDate, setManualEndDate] = useState('');
    const [manualAllDay, setManualAllDay] = useState(true);

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

    useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return undefined;
        const mql = window.matchMedia('(max-width: 767px)');
        const onChange = (e) => setIsPhone(e.matches);
        setIsPhone(mql.matches);
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, []);

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
                    absenceType: data.absenceType || (data.isVacation ? 'vacation' : null),
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
            // New entries start on the user's chosen default location; still freely toggled below.
            isWorkFromHome: defaultIsWorkFromHome(userData?.defaultWorkLocation),
            isVacation: false,
            absenceType: 'vacation'
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
            isVacation: event.isVacation || false,
            absenceType: event.absenceType || 'vacation'
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

    // <!-- DECISION 2026-06-23: Approval gate now keys on the AFFECTED TIME, not only the day of
    // week. A brand-new FUTURE entry is harmless forward planning and is saved directly, even
    // mid-week; only touching past/current time (the retroactive-gaming risk) still routes through
    // approval. Previously every weekday action — including adding a future shift — demanded a
    // manager's sign-off, which mislabelled a new entry as a "Pakeitimas" and blocked plain planning. -->
    // Approval exists to protect ELAPSED / CURRENT time from retroactive manipulation — not to
    // gate harmless forward planning. So an action whose affected time is entirely in the FUTURE
    // is saved directly (auto-approved); anything that touches the past or the current moment
    // falls back to the weekly planning-window gate above (free Fri 13:00–Sun 21:00, else approval).
    const isFutureInstant = (d) => d instanceof Date && !Number.isNaN(d.getTime()) && d.getTime() > Date.now();

    // type: 'add' | 'edit' | 'delete'. `start` = the new entry's start; `originalStart` = the
    // existing entry's start (edit/delete). A future-only touch bypasses approval entirely.
    const actionNeedsApproval = ({ type, start, originalStart }) => {
        if (type === 'add' && isFutureInstant(start)) return false;
        if (type === 'edit' && isFutureInstant(start) && isFutureInstant(originalStart)) return false;
        if (type === 'delete' && isFutureInstant(originalStart)) return false;
        return isApprovalFeatureActive();
    };

    // User-facing nouns kept in one place so add/edit/delete are labelled consistently — the worker
    // side used to call every action a "Pakeitimas" even when creating a brand-new entry.
    const ACTION_NOUN_ACC = { add: 'Naują įrašą', edit: 'Pakeitimą', delete: 'Atšaukimą' };
    const REASON_PROMPT = {
        add: 'Prašome nurodyti, kodėl pridedate šį įrašą',
        edit: 'Prašome nurodyti, kodėl darote šį pakeitimą',
        delete: 'Prašome nurodyti, kodėl atšaukiate šį įrašą',
    };
    const approvalFootnote = (needsApproval, type) =>
        needsApproval
            ? `${ACTION_NOUN_ACC[type] || 'Įrašą'} turės patvirtinti vadovas — reikės nurodyti priežastį.`
            : 'Įrašas išsaugomas ir patvirtinamas iš karto.';

    // Name the entry an action collides with, so the overlap error points at the real culprit
    // instead of a generic "something overlaps" the worker then has to hunt for.
    const describeEvent = (ev) => {
        const typeLabel = ev.isVacation ? (absenceLabel(ev) || ABSENCE_GENERIC_LABEL) : workLocationLabel(ev.isWorkFromHome);
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
                    isVacation: ev.isVacation || false,
                    absenceType: absenceTypeForWrite(ev.isVacation, ev.absenceType)
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
                // An add carries a synthetic id:null (a real id exists only for edit/delete). Strip it
                // so it never lands on the work_hours doc — a future reader doing {id: doc.id, ...data}
                // would otherwise have its real doc id clobbered to null.
                const addData = { ...action.data, userId: currentUser.uid, type: 'planned' };
                delete addData.id;
                await addDoc(collection(db, 'work_hours'), addData);
            } else if (action.type === 'edit') {
                await updateDoc(doc(db, 'work_hours', action.data.id), {
                    start: action.data.start,
                    end: action.data.end,
                    title: action.data.title,
                    isWorkFromHome: action.data.isWorkFromHome,
                    isVacation: action.data.isVacation,
                    absenceType: action.data.absenceType ?? null
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

            const title = editingEvent.isVacation
                ? absenceLabel({ isVacation: true, absenceType: editingEvent.absenceType })
                : workLocationLabel(editingEvent.isWorkFromHome);

            const actionDetails = {
                type: editingEvent.id ? 'edit' : 'add',
                data: {
                    id: editingEvent.id || null,
                    start: startDateTime.toISOString(),
                    end: endDateTime.toISOString(),
                    title: title,
                    isWorkFromHome: editingEvent.isWorkFromHome || false,
                    isVacation: editingEvent.isVacation || false,
                    absenceType: absenceTypeForWrite(editingEvent.isVacation, editingEvent.absenceType)
                },
                originalEvent: editingEvent.id ? events.find(e => e.id === editingEvent.id) : null
            };

            const needsApproval = actionNeedsApproval({
                type: actionDetails.type,
                start: startDateTime,
                originalStart: actionDetails.originalEvent ? new Date(actionDetails.originalEvent.start) : null
            });

            if (needsApproval) {
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
                isVacation: editingEvent.isVacation,
                absenceType: absenceTypeForWrite(editingEvent.isVacation, editingEvent.absenceType)
            },
            originalEvent: editingEvent
        };
        setShowDeleteModal(false);
        setEditingEvent(null);

        // Deleting a still-future plan is harmless; deleting past/current logged time keeps the gate.
        if (actionNeedsApproval({ type: 'delete', start: editingEvent.start, originalStart: editingEvent.start })) {
            setPendingAction(actionDetails);
            setShowReasonModal(true);
        } else {
            await executeDirectCalendarUpdate(actionDetails);
        }
    };

    // Build one absence work_hours payload for a single calendar day. All-day uses the whole local
    // day (00:00 → next-day 00:00) so a day-off needs no invented clock times; otherwise the chosen
    // start/end clock is applied to that day. Every payload still carries the load-bearing
    // isVacation:true gate + the neutral default absenceType (reason-agnostic model), so report
    // exclusions, server aggregation and workerStats absence counting all keep reading it unchanged.
    const buildAbsenceDayData = (dateStr) => {
        const start = manualAllDay
            ? new Date(`${dateStr}T00:00`)
            : new Date(`${dateStr}T${manualStart}`);
        const end = manualAllDay
            ? new Date(`${dateStr}T00:00`)
            : new Date(`${dateStr}T${manualEnd}`);
        if (manualAllDay) end.setDate(end.getDate() + 1); // exclusive end at next local midnight
        return {
            start,
            end,
            data: {
                id: null,
                start: start.toISOString(),
                end: end.toISOString(),
                title: absenceLabel({ isVacation: true }) || ABSENCE_GENERIC_LABEL,
                isWorkFromHome: false,
                isVacation: true,
                // absenceTypeForWrite(true, undefined) -> the neutral default, so the worker never
                // picks a reason yet legacy readers keep a valid type to bucket on.
                absenceType: absenceTypeForWrite(true, undefined),
            },
        };
    };

    // Submit the absence sub-form: generate one work_hours doc PER DAY across [manualDate, manualEndDate]
    // inclusive. Each day runs the same overlap + approval routing as a single add, so booking a week
    // off is one action without weakening either guard. If any day needs approval, the whole batch is
    // routed through approval (one reason for the span); otherwise all days are saved directly.
    const handleAbsenceSubmit = async () => {
        const endDateStr = manualEndDate || manualDate;
        if (endDateStr < manualDate) {
            setError('Pabaigos data turi būti ne ankstesnė už pradžios datą.');
            return;
        }
        if (!manualAllDay && (!manualStart || !manualEnd)) {
            setError('Užpildykite visus laukus.');
            return;
        }

        // Collect each day's payload, validating clock order + overlaps against existing events AND
        // the days already queued in THIS submit (so two days in the range can't collide either).
        const days = [];
        const queued = []; // {start, end} accumulators for in-batch overlap detection
        let cursor = manualDate;
        // Guard the loop against a pathological range; a year of days is far beyond any real booking.
        for (let guard = 0; guard < 400 && cursor <= endDateStr; guard += 1) {
            const day = buildAbsenceDayData(cursor);
            if (day.end <= day.start) {
                setError('Pabaigos laikas turi būti vėlesnis už pradžios laiką.');
                return;
            }
            const conflict = events.find((ev) => day.start < ev.end && day.end > ev.start)
                || queued.find((q) => day.start < q.end && day.end > q.start);
            if (conflict && conflict.start !== undefined && conflict.title !== undefined) {
                setError(overlapMessage(conflict));
                return;
            }
            if (conflict) {
                setError('Pasirinktas laikotarpis persidengia su esamu įrašu.');
                return;
            }
            days.push(day);
            queued.push({ start: day.start, end: day.end });
            // Advance one local day via the yyyy-MM-dd string (date math avoids DST drift).
            const next = new Date(`${cursor}T00:00`);
            next.setDate(next.getDate() + 1);
            cursor = format(next, 'yyyy-MM-dd');
        }

        if (days.length === 0) {
            setError('Užpildykite visus laukus.');
            return;
        }

        // The span needs approval if ANY day touches past/current time; a fully-future span is direct.
        const needsApproval = days.some((d) => actionNeedsApproval({ type: 'add', start: d.start }));

        if (needsApproval) {
            // Route the whole span through one approval request (the existing single-action path).
            // The reason modal applies one reason to the batch; on approve, every day is written.
            setPendingAction({ type: 'add', data: days.map((d) => d.data), batch: true });
            setShowReasonModal(true);
            setShowManualInput(false);
        } else {
            for (const d of days) {
                await executeDirectCalendarUpdate({ type: 'add', data: d.data });
            }
            setShowManualInput(false);
            // A fully-future span is saved directly with no approval round-trip. Mirror every other
            // direct-write path (single add, copy-last-week, batch self-approve) and surface the same
            // success confirmation, so the worker sees their day(s) off were booked rather than getting
            // a silent no-op.
            setError('');
            setFeedbackVariant('approved');
            setShowApprovalFeedback(true);
        }
    };

    const handleManualSubmit = async (e) => {
        e.preventDefault();
        if (!currentUser) return;

        try {
            // Absence path: reason-agnostic, optionally multi-day / all-day. Delegated wholesale so
            // the work path below stays the simple single-shift add it always was.
            if (manualIsVacation) {
                if (!manualDate) {
                    setError('Užpildykite visus laukus.');
                    return;
                }
                await handleAbsenceSubmit();
                // Reset form
                setManualDate('');
                setManualEndDate('');
                setManualStart('');
                setManualEnd('');
                setManualAllDay(true);
                setManualIsWorkFromHome(false);
                setManualIsVacation(false);
                setError('');
                return;
            }

            if (!manualDate || !manualStart || !manualEnd) {
                setError('Užpildykite visus laukus.');
                return;
            }

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

            // Work-only path: absences are routed to handleAbsenceSubmit above and return early, so
            // every entry reaching here is worked time. Name it via the unified work-location label
            // (main's Veikla / Veikla namuose vocabulary) sourced from the home toggle.
            const actionDetails = {
                type: 'add',
                data: {
                    id: null,
                    start: startDateTime.toISOString(),
                    end: endDateTime.toISOString(),
                    title: workLocationLabel(manualIsWorkFromHome),
                    isWorkFromHome: manualIsWorkFromHome || false,
                    isVacation: false,
                    absenceType: null
                }
            };

            if (actionNeedsApproval({ type: 'add', start: startDateTime })) {
                setPendingAction(actionDetails);
                setShowReasonModal(true);
                setShowManualInput(false);
            } else {
                await executeDirectCalendarUpdate(actionDetails);
                setShowManualInput(false);
            }

            // Reset form
            setManualDate('');
            setManualEndDate('');
            setManualStart('');
            setManualEnd('');
            setManualAllDay(true);
            setManualIsWorkFromHome(defaultIsWorkFromHome(userData?.defaultWorkLocation));
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
            // Calendar/shift requests concern the PERSON, so they fan out to ALL of the worker's
            // managers (any may approve; the first to act flips the status and clears it for the
            // rest). `managerId` stays the primary (FCM fallback / legacy); `managerIds` is the
            // array the bell queries with array-contains.
            const managerIds = Array.isArray(userData?.teamManagerIds) && userData.teamManagerIds.length
                ? userData.teamManagerIds
                : (managerId ? [managerId] : []);

            // A multi-day absence arrives as a BATCH (pendingAction.data is an array of per-day adds).
            // We emit ONE standard calendar_request per day so the manager-side approval flow — which
            // reads a single requestedEvent object — stays untouched; the worker only had to give one
            // reason for the whole span. Auto-approval (manager booking their own) writes each day's
            // work_hours immediately, exactly like the single-add path.
            if (pendingAction.batch) {
                const selfApprove = isManagerOrAdmin && managerId === currentUser.uid;
                const baseRequest = {
                    userId: currentUser.uid,
                    userName: userData?.displayName || currentUser.displayName || currentUser.email,
                    managerId: managerId,
                    managerIds: managerIds,
                    type: 'add',
                    reason: reasonValue,
                    userDismissed: false,
                    createdAt: new Date().toISOString(),
                    originalEvent: null,
                };
                for (const dayData of pendingAction.data) {
                    const req = { ...baseRequest, requestedEvent: dayData };
                    if (selfApprove) {
                        const addData = { ...dayData, userId: currentUser.uid, type: 'planned' };
                        delete addData.id;
                        await addDoc(collection(db, 'work_hours'), addData);
                        req.status = 'approved';
                        req.approvedAt = new Date().toISOString();
                        req.approvedBy = currentUser.uid;
                    } else {
                        req.status = 'pending';
                    }
                    await addDoc(collection(db, 'calendar_requests'), JSON.parse(JSON.stringify(req)));
                    if (selfApprove) {
                        await logCalendarChange(
                            currentUser,
                            'add',
                            new Date(dayData.start),
                            new Date(dayData.end)
                        );
                    }
                }
                setShowReasonModal(false);
                setReasonValue('');
                setPendingAction(null);
                setError('');
                setFeedbackVariant(selfApprove ? 'approved' : 'sent');
                setShowApprovalFeedback(true);
                return;
            }

            const requestData = {
                userId: currentUser.uid,
                userName: userData?.displayName || currentUser.displayName || currentUser.email,
                managerId: managerId,
                managerIds: managerIds,
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
                    // Strip the synthetic id:null (see executeDirectCalendarUpdate) before it lands on the doc.
                    const addData = { ...pendingAction.data, userId: currentUser.uid, type: 'planned' };
                    delete addData.id;
                    await addDoc(collection(db, 'work_hours'), addData);
                } else if (pendingAction.type === 'edit') {
                    await updateDoc(doc(db, 'work_hours', pendingAction.data.id), {
                        start: pendingAction.data.start,
                        end: pendingAction.data.end,
                        title: pendingAction.data.title,
                        isWorkFromHome: pendingAction.data.isWorkFromHome,
                        isVacation: pendingAction.data.isVacation,
                        absenceType: pendingAction.data.absenceType ?? null
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

    // Drives only the copy-last-week toolbar control (bulk weekend planning op).
    const approvalActive = isApprovalFeatureActive();

    // Per-form approval preview: the save buttons + footnotes reflect whether THIS specific entry
    // will be saved directly (future plan, or weekend window) or submitted for approval. The manual
    // form is always an add; the edit modal is an edit or an add depending on whether it has an id.
    // For an absence the relevant instant is the FIRST day's start (all-day -> that day's midnight,
    // else the chosen start clock); a span is approved if its earliest day already needs approval.
    const manualStartDate = (() => {
        if (!manualDate) return null;
        if (manualIsVacation) {
            return manualAllDay
                ? new Date(`${manualDate}T00:00`)
                : (manualStart ? new Date(`${manualDate}T${manualStart}`) : null);
        }
        return manualStart ? new Date(`${manualDate}T${manualStart}`) : null;
    })();
    const manualNeedsApproval = manualStartDate
        ? actionNeedsApproval({ type: 'add', start: manualStartDate })
        : false;

    const editType = editingEvent?.id ? 'edit' : 'add';
    const editStartDate = (editingEvent?.dateStr && editingEvent?.startStr)
        ? new Date(`${editingEvent.dateStr}T${editingEvent.startStr}`)
        : null;
    const editOriginalStart = editingEvent?.start instanceof Date
        ? editingEvent.start
        : (editingEvent?.start ? new Date(editingEvent.start) : null);
    const editNeedsApproval = editStartDate
        ? actionNeedsApproval({ type: editType, start: editStartDate, originalStart: editOriginalStart })
        : false;

    const components = {
        event: ({ event }) => {
            // Horizontal layout: time first (always readable), then icon + state label.
            // Vacation is a calm "free" state — soft brand (indigo) tint + label, never a
            // near-black block (color is never the sole signal, §5).
            const isVacation = event.isVacation;
            const isWfh = !isVacation && event.isWorkFromHome;
            const absLabel = absenceLabel(event) || ABSENCE_GENERIC_LABEL;
            const stateLabel = isVacation ? absLabel : workLocationLabel(isWfh);
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
                        // text-brand (not -hover) so the dark-theme foreground-decoupling in
                        // index.css lightens it to indigo-300 — indigo-700 was illegible on the
                        // dark indigo-950 brand-soft wash. Light theme keeps indigo-600 on indigo-50.
                        isVacation ? 'bg-brand-soft text-brand' : 'text-white'
                    )}
                >
                    <span className="text-caption font-mono font-semibold tabular-nums">
                        {format(event.start, 'HH:mm')}
                    </span>
                    <span className="flex items-center gap-1 text-caption font-semibold">
                        {isVacation ? (
                            <>
                                <Palmtree className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                                <span>{absLabel}</span>
                            </>
                        ) : isWfh ? (
                            <>
                                <Home className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                                <span>{workLocationLabel(true)}</span>
                            </>
                        ) : (
                            <span>{workLocationLabel(false)}</span>
                        )}
                    </span>
                </div>
            );
        },
        toolbar: (props) => (
            <CustomToolbar
                {...props}
                onManualClick={() => {
                    const next = !showManualInput;
                    // Seed the toggle from the saved default each time the manual panel opens.
                    if (next) setManualIsWorkFromHome(defaultIsWorkFromHome(userData?.defaultWorkLocation));
                    setShowManualInput(next);
                }}
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
                <form onSubmit={handleManualSubmit} onKeyDown={preventEnterSubmit} className="mb-4 p-3 bg-surface-base rounded-card border border-line shadow-inner">
                    {/* Date row. For an absence the worker may book a whole RANGE (Nuo … Iki), so a
                        second "Iki" date appears; for work it stays a single day. The time columns
                        below collapse to one date column when an all-day absence makes clock times
                        irrelevant. */}
                    <div className={clsx(
                        'grid grid-cols-1 gap-3',
                        manualIsVacation
                            ? (manualAllDay ? 'sm:grid-cols-2' : 'sm:grid-cols-4')
                            : 'sm:grid-cols-3'
                    )}>
                        <div>
                            <label htmlFor="manualDate" className="block text-caption uppercase tracking-wider font-bold text-ink-muted mb-1">
                                {manualIsVacation ? 'Nuo' : 'Data'}
                            </label>
                            <DatePicker
                                id="manualDate"
                                value={manualDate}
                                onChange={setManualDate}
                            />
                        </div>
                        {manualIsVacation && (
                            <div>
                                <label htmlFor="manualEndDate" className="block text-caption uppercase tracking-wider font-bold text-ink-muted mb-1">Iki</label>
                                <DatePicker
                                    id="manualEndDate"
                                    value={manualEndDate}
                                    onChange={setManualEndDate}
                                    min={manualDate || undefined}
                                    placeholder="Ta pati diena"
                                />
                            </div>
                        )}
                        {!(manualIsVacation && manualAllDay) && (
                            <>
                                <div>
                                    <label htmlFor="manualStart" className="block text-caption uppercase tracking-wider font-bold text-ink-muted mb-1">Pradžia</label>
                                    <input
                                        id="manualStart"
                                        type="time"
                                        value={manualStart}
                                        onChange={(e) => setManualStart(e.target.value)}
                                        className="w-full px-2 py-2 text-body-lg border border-line rounded-input focus:ring-2 focus:ring-brand outline-none transition-all"
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
                                    />
                                </div>
                            </>
                        )}
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
                            <span className="text-body font-medium text-ink">Veikla namuose</span>
                        </label>
                        {/* Reason-agnostic absence: one neutral "I'm not working" toggle — the worker
                            never has to declare WHY (vacation / sick / …), only THAT they are off. */}
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
                            <span className="text-body font-medium text-ink">Pažymėti, kad nedirbu</span>
                        </label>
                    </div>
                    {manualIsVacation && (
                        <div className="mt-3">
                            <label className="flex min-h-touch items-center gap-2 cursor-pointer w-fit">
                                <input
                                    type="checkbox"
                                    checked={manualAllDay}
                                    onChange={(e) => setManualAllDay(e.target.checked)}
                                    className="w-5 h-5 text-brand rounded border-line focus-visible:ring-2 focus-visible:ring-brand"
                                />
                                <span className="text-body font-medium text-ink">Visą dieną</span>
                            </label>
                            <p className="mt-1 text-caption text-ink-muted">
                                {(manualEndDate && manualEndDate > manualDate)
                                    ? 'Bus pažymėta, kad nedirbate kiekvieną dieną nuo pasirinktos pradžios iki pabaigos.'
                                    : 'Pažymėkite „Iki", jei nedirbsite kelias dienas iš eilės.'}
                            </p>
                        </div>
                    )}
                    <div className="flex gap-2 mt-4">
                        <Button type="submit" variant="primary" size="md">
                            {manualNeedsApproval ? 'Pateikti tvirtinimui' : 'Išsaugoti'}
                        </Button>
                        <Button type="button" variant="secondary" size="md" onClick={() => setShowManualInput(false)}>
                            Atšaukti
                        </Button>
                    </div>
                    <p className="mt-2 text-caption text-ink-muted">
                        {approvalFootnote(manualNeedsApproval, 'add')}
                    </p>
                </form>
            )
            }

            {/* The calendar is given a fixed pixel height tall enough to hold the entire working
                day at a comfortable row height. Because react-big-calendar flexes its hour rows to
                fill exactly this box, the grid renders in full with no internal scrollbar of its
                own. On a screen too short to show the whole box, the *page* scrolls (the container
                simply grows past the viewport) — the calendar no longer traps the scroll. Phones
                use the day view, which is naturally shorter. */}
            {/* Card chrome mirrors the team calendar (AllUsersCalendar): a rounded surface-card
                panel with a subtle line border, so in both themes the personal planner reads as
                the same component family rather than a bare library grid. The grid stays
                transparent and inherits this surface; padding gives the toolbar + grid breathing
                room without eating the fixed height (the inner box keeps its own height). */}
            <div className="bg-surface-card rounded-card border border-line shadow-lg overflow-hidden p-2 sm:p-3">
            <div className="h-[820px] sm:h-[650px] md:h-[750px] lg:h-[880px]">
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
            </div>

            {/* Edit Event Modal — canonical Modal (bare) keeps the bespoke form chrome while
                inheriting the shared scrim, focus-trap, Escape and portal. closeOnBackdrop={false}
                so a stray backdrop tap can't discard unsaved edits; Escape + buttons still close. */}
            {
                editingEvent && (
                    <Modal
                        bare
                        size="md"
                        level="top"
                        closeOnBackdrop={false}
                        ariaLabelledby="edit-event-title"
                        onClose={() => setEditingEvent(null)}
                    >
                        <div className="flex-1 min-h-0 overflow-y-auto p-6">
                            <h3 id="edit-event-title" className="text-h2 text-ink-strong mb-4">
                                {editingEvent.id ? 'Redaguoti laiką' : 'Pridėti darbo laiką'}
                            </h3>

                            <form onSubmit={handleUpdateEvent} onKeyDown={preventEnterSubmit}>
                                <div className="grid grid-cols-1 gap-4 mb-6">
                                    <div>
                                        <label htmlFor="editDate" className="block text-caption font-bold text-ink-muted uppercase tracking-wider mb-1">Data</label>
                                        <DatePicker
                                            id="editDate"
                                            value={editingEvent.dateStr}
                                            onChange={(v) => setEditingEvent({ ...editingEvent, dateStr: v })}
                                        />
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label htmlFor="editStart" className="block text-caption font-bold text-ink-muted uppercase tracking-wider mb-1">Pradžia</label>
                                            <Select
                                                id="editStart"
                                                value={editingEvent.startStr}
                                                onChange={(val) => setEditingEvent({ ...editingEvent, startStr: val })}
                                                options={timeOptions.map((time) => ({ value: time, label: time }))}
                                                label="Pradžia"
                                                ariaLabel="Pradžia"
                                                alwaysSheet
                                            />
                                        </div>
                                        <div>
                                            <label htmlFor="editEnd" className="block text-caption font-bold text-ink-muted uppercase tracking-wider mb-1">Pabaiga</label>
                                            <Select
                                                id="editEnd"
                                                value={editingEvent.endStr}
                                                onChange={(val) => setEditingEvent({ ...editingEvent, endStr: val })}
                                                options={timeOptions.map((time) => ({ value: time, label: time }))}
                                                label="Pabaiga"
                                                ariaLabel="Pabaiga"
                                                alwaysSheet
                                            />
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
                                        <span className="text-body font-medium text-ink">Veikla namuose</span>
                                    </label>
                                    {/* Reason-agnostic: one neutral "not working" toggle, no kind picker.
                                        Editing a legacy typed absence preserves its original absenceType
                                        on save (handleUpdateEvent reads editingEvent.absenceType), so old
                                        Liga/Šventė entries keep their label and never get rewritten. */}
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
                                        <span className="text-body font-medium text-ink">Nedirbu</span>
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
                                            {editNeedsApproval ? 'Pateikti tvirtinimui' : 'Išsaugoti'}
                                        </Button>
                                    </div>
                                </div>
                                <p className="mt-3 text-caption text-ink-muted">
                                    {approvalFootnote(editNeedsApproval, editType)}
                                </p>
                            </form>
                        </div>
                    </Modal>
                )
            }


            {/* Approval Logic Confirmation Modal — pure acknowledgement (no unsaved input), so it
                keeps the default backdrop-tap-to-dismiss alongside Escape and the button. */}
            {showApprovalFeedback && (
                <Modal
                    bare
                    size="sm"
                    level="top"
                    ariaLabelledby="approval-feedback-title"
                    onClose={() => setShowApprovalFeedback(false)}
                >
                    <div className="flex-1 min-h-0 overflow-y-auto p-8 text-center">
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
                            {feedbackVariant === 'approved' ? 'Išsaugota' : 'Užklausa išsiųsta'}
                        </h3>
                        <p className="text-body text-ink-muted mb-6">
                            {feedbackVariant === 'approved'
                                ? 'Veiksmas atliktas ir automatiškai patvirtintas.'
                                : 'Jūsų užklausą turi patvirtinti vadovas.'}
                        </p>
                        <Button variant="primary" size="lg" fullWidth onClick={() => setShowApprovalFeedback(false)}>
                            Supratau
                        </Button>
                    </div>
                </Modal>
            )}

            {/* Reason Modal — captures a required change reason (unsaved text), so
                closeOnBackdrop={false} guards it; Escape and the buttons still close. */}
            {showReasonModal && (
                <Modal
                    bare
                    size="md"
                    closeOnBackdrop={false}
                    ariaLabelledby="reason-modal-title"
                    onClose={() => {
                        setShowReasonModal(false);
                        setReasonValue('');
                        setPendingAction(null);
                    }}
                >
                    <div className="flex-1 min-h-0 overflow-y-auto p-6">
                        <h3 id="reason-modal-title" className="text-h2 text-ink-strong mb-2">Veiksmo priežastis</h3>
                        <label htmlFor="reasonValue" className="block text-body text-ink-muted mb-4">{REASON_PROMPT[pendingAction?.type] || 'Prašome nurodyti priežastį'} (min. 10 simbolių).</label>

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
                </Modal>
            )}

            {/* level="top" so the confirm stacks ABOVE the Edit Event modal (also z-top), which
                stays mounted behind it — without it the confirm (default z-modal) renders hidden
                behind the edit overlay. */}
            <DeleteConfirmationModal
                isOpen={showDeleteModal}
                onClose={() => setShowDeleteModal(false)}
                onConfirm={confirmDelete}
                taskTitle={editingEvent?.title || 'Darbo laiko įrašą'}
                isTask={false}
                level="top"
            />
        </div >
    );
}

