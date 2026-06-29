import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, orderBy } from 'firebase/firestore';
import { getLithuanianDateString } from '../utils/timeUtils';
import { isManagerRole } from '../utils/formatters';
import { absenceLabel } from '../utils/absence';
import { canSeeWholeTeam, isScopedOverseer, isOverseenBy } from '../utils/teamScope';
import { approveCalendarRequest, declineCalendarRequest } from '../utils/calendarApproval';
import { useAuth } from '../context/AuthContext';
import { Briefcase, AlertTriangle, Check, X } from 'lucide-react';
import { Spinner } from './ui/Loading';
import DatePicker from './ui/DatePicker';
import TaskActionRow from './task/TaskActionRow';
import { PeriodPicker } from './reports/PeriodPicker';
import { PERIOD_PRESETS, resolvePresetRange } from './reports/periodPresets';

// Calendar-change history (the "Kalendoriaus istorija" surface). Lists every approve/edit/delete
// request a worker made against their planned-hours calendar (the `calendar_requests` collection),
// with who approved it and why. Extracted out of Reports so it can live beside the team calendar it
// describes — a calendar-oversight feature, not a work-hours report. Manager/admin team surface;
// workers only ever see their own rows (the role filter below), matching the old in-Reports gate.
export default function CalendarChangeHistory({ users = [] }) {
    const { currentUser, userRole, userData } = useAuth();

    // Same from/to range model as the work report (defaults to the current month so far), driven by
    // the identical collapsible period picker. `historyPeriod` tracks the active preset for the
    // collapsed label; `historyPeriodOpen` toggles the picker panel.
    const [historyRange, setHistoryRange] = useState(() => {
        const today = getLithuanianDateString();
        return { start: `${today.slice(0, 7)}-01`, end: today };
    });
    const [historyPeriod, setHistoryPeriod] = useState('month'); // 'day' | 'week' | 'month' | '3months' | 'year' | 'custom'
    const [historyPeriodOpen, setHistoryPeriodOpen] = useState(false);
    const [calendarHistory, setCalendarHistory] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    // Per-row action state for the inline approve/decline controls (pending rows only).
    const [actionError, setActionError] = useState('');
    const [busyId, setBusyId] = useState(null);

    const fetchCalendarHistory = async () => {
        setLoading(true);
        try {
            const startStr = `${historyRange.start}T00:00:00.000Z`;
            const endStr = `${historyRange.end}T23:59:59.999Z`;

            const q = query(
                collection(db, 'calendar_requests'),
                where('createdAt', '>=', startStr),
                where('createdAt', '<=', endStr),
                orderBy('createdAt', 'desc')
            );

            const snap = await getDocs(q);
            const data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            // A worker only ever sees their own history; a manager/admin sees the whole team.
            if (!isManagerRole(userRole)) {
                setCalendarHistory(data.filter(item => item.userId === currentUser?.uid));
            } else {
                setCalendarHistory(data);
            }
            setError('');
        } catch (err) {
            console.error('Error fetching calendar history:', err);
            setError('Nepavyko užkrauti kalendoriaus istorijos. Patikrinkite ryšį ir bandykite dar kartą.');
        } finally {
            setLoading(false);
        }
    };

    // Refetch on mount and whenever the range changes.
    useEffect(() => {
        fetchCalendarHistory();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchCalendarHistory is recreated each render; intentionally refetch only on range change
    }, [historyRange.start, historyRange.end]);

    // Same collapsible modal + preset logic as the work report, but every preset (including 'day')
    // resolves to a from/to range, since history is always a range query (no daily-timeline mode).
    const chooseHistoryPeriod = (period) => {
        setHistoryPeriod(period);
        setHistoryPeriodOpen(false);
        const range = resolvePresetRange(period);
        if (range) setHistoryRange(range);
    };

    // Who may act on a pending request from this view. This MIRRORS the work_hours write rules an
    // approval must satisfy (firestore.rules): a whole-team viewer (admin / unscoped koordinatorius)
    // may act on anyone; a scoped overseer (scoped koordinatorius OR vyr. koordinatorius) only on a
    // worker inside their oversight closure. Keying on the worker's overseer set — not the request's
    // `managerIds` — is deliberate: managerIds holds only the worker's DIRECT koordinatoriai, so a
    // vyr. koordinatorius (never listed there) would be wrongly excluded even though the rules grant
    // them the write. If the gate ever passed someone the rules would deny, the status flip would
    // succeed while the work_hours write failed — an inconsistent half-approval; this keeps them aligned.
    const canActOnRequest = (item) => {
        if (item.status !== 'pending') return false;
        if (canSeeWholeTeam(userData)) return true;
        if (!isScopedOverseer(userData)) return false;
        const worker = users.find((u) => u.id === item.userId);
        return isOverseenBy(worker, currentUser?.uid);
    };

    const actor = () => ({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email });

    // Apply the decision through the shared writer (same path as the manager bell), then optimistically
    // flip the local row so its badge updates and the buttons drop — no full refetch needed. On failure
    // nothing is mutated locally and a friendly banner appears (never raw err.message — §10).
    const handleApprove = async (item) => {
        setActionError('');
        setBusyId(item.id);
        try {
            await approveCalendarRequest(item, actor());
            setCalendarHistory((prev) => prev.map((r) =>
                r.id === item.id ? { ...r, status: 'approved', approvedBy: currentUser.uid, approvedAt: new Date().toISOString() } : r));
        } catch (err) {
            console.error('Error approving calendar request:', err);
            setActionError('Nepavyko patvirtinti užklausos. Bandykite dar kartą.');
        } finally {
            setBusyId(null);
        }
    };

    const handleDecline = async (item) => {
        setActionError('');
        setBusyId(item.id);
        try {
            await declineCalendarRequest(item, actor());
            setCalendarHistory((prev) => prev.map((r) =>
                r.id === item.id ? { ...r, status: 'declined', declinedBy: currentUser.uid, declinedAt: new Date().toISOString() } : r));
        } catch (err) {
            console.error('Error declining calendar request:', err);
            setActionError('Nepavyko atmesti užklausos. Bandykite dar kartą.');
        } finally {
            setBusyId(null);
        }
    };

    // The two-button decision row, shown only on a pending row the viewer may resolve. Shared by the
    // mobile card and the desktop table so both surfaces behave identically.
    const renderDecision = (item) => {
        if (!canActOnRequest(item)) return null;
        const busy = busyId === item.id;
        return (
            <TaskActionRow
                actions={[
                    { key: 'approve', label: 'Patvirtinti', icon: Check, variant: 'success', onClick: () => handleApprove(item), disabled: busy, loading: busy },
                    { key: 'decline', label: 'Atmesti', icon: X, variant: 'danger', onClick: () => handleDecline(item), disabled: busy },
                ]}
            />
        );
    };

    // Derive the display fields for one calendar-history entry. Computed once and shared by the
    // mobile card and the desktop table so both layouts stay in sync.
    const deriveCalendarEntry = (item) => {
        const workerLabel = item.userName || 'Nežinomas meistras';

        const eventStart = item.requestedEvent?.start || item.originalEvent?.start || null;
        const eventEnd = item.requestedEvent?.end || item.originalEvent?.end || null;
        const formatEventTime = (timeStr) => {
            if (!timeStr) return '-';
            const d = new Date(timeStr);
            return `${d.toLocaleDateString('lt-LT')} ${d.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit' })}`;
        };
        const calendarTimeLabel = `${formatEventTime(eventStart)} – ${formatEventTime(eventEnd)}`;
        const actionTimeLabel = new Date(item.createdAt).toLocaleString('lt-LT');

        const getActionColor = (action) => {
            if (action === 'add') return 'text-feedback-success bg-feedback-success-soft border-feedback-success-border';
            if (action === 'delete') return 'text-feedback-danger bg-feedback-danger-soft border-feedback-danger-border';
            return 'text-feedback-info bg-feedback-info-soft border-feedback-info-border';
        };
        const getActionText = (action) => {
            if (action === 'add') return 'Pridėjo';
            if (action === 'delete') return 'Ištrynė';
            return 'Redagavo';
        };

        const evt = item.requestedEvent || item.originalEvent || {};
        let TypeIcon = Briefcase;
        let typeLabel = 'Veikla';
        let typeColor = 'text-ink-muted';
        if (evt.isVacation) {
            TypeIcon = null;
            typeLabel = absenceLabel(evt) || 'Atostogos';
            typeColor = 'text-feedback-warning';
        } else if (evt.isWorkFromHome) {
            TypeIcon = null;
            typeLabel = 'Veikla namuose';
            typeColor = 'text-feedback-info';
        }

        let statusLabel = 'Laukiama';
        let statusColor = 'bg-feedback-warning-soft text-feedback-warning-text';
        if (item.status === 'approved') {
            statusLabel = 'Patvirtinta';
            statusColor = 'bg-feedback-success-soft text-feedback-success-text';
        } else if (item.status === 'declined') {
            statusLabel = 'Atmesta';
            statusColor = 'bg-feedback-danger-soft text-feedback-danger-text';
        }

        const getManagerName = (sysId) => {
            if (!sysId) return '-';
            if (sysId === 'system') return 'Sistema';
            const sysUser = users?.find(u => u.id === sysId);
            return sysUser ? (sysUser.displayName || sysUser.email) : sysId;
        };
        const managerLabel = item.approvedBy ? getManagerName(item.approvedBy) : '-';
        const reasonLabel = (item.reason === 'PlanningTime') ? 'Suplanuota iš anksto' : (item.reason || '-');

        return {
            workerLabel, calendarTimeLabel, actionTimeLabel,
            actionColor: getActionColor(item.type), actionText: getActionText(item.type),
            TypeIcon, typeLabel, typeColor, statusLabel, statusColor, managerLabel, reasonLabel,
        };
    };

    return (
        <div className="space-y-4">
            {/* Period selector — identical collapsible modal to the work report, so calendar
                filtering behaves the same everywhere in the app. */}
            <PeriodPicker
                presets={PERIOD_PRESETS}
                activeId={historyPeriod}
                onChoose={chooseHistoryPeriod}
                open={historyPeriodOpen}
                onToggle={() => setHistoryPeriodOpen((o) => !o)}
                label="Laikotarpis"
            >
                <div className="flex flex-col gap-3 border-t border-line pt-3 sm:flex-row sm:items-end">
                    <div className="flex-1">
                        <label htmlFor="cal-history-from" className="block text-caption font-semibold text-ink-muted mb-1">Nuo</label>
                        <DatePicker
                            id="cal-history-from"
                            value={historyRange.start}
                            max={historyRange.end}
                            onChange={(v) => { setHistoryPeriod('custom'); setHistoryRange(prev => ({ ...prev, start: v })); }}
                        />
                    </div>
                    <div className="flex-1">
                        <label htmlFor="cal-history-to" className="block text-caption font-semibold text-ink-muted mb-1">Iki</label>
                        <DatePicker
                            id="cal-history-to"
                            value={historyRange.end}
                            min={historyRange.start}
                            max={getLithuanianDateString()}
                            onChange={(v) => { setHistoryPeriod('custom'); setHistoryRange(prev => ({ ...prev, end: v })); }}
                        />
                    </div>
                </div>
            </PeriodPicker>

            {/* Friendly error banner — replaces banned window.alert (§8); never raw err.message (§10) */}
            {error && (
                <div
                    role="alert"
                    className="flex items-start gap-3 rounded-control border-l-4 border-feedback-danger bg-feedback-danger-soft p-4"
                >
                    <AlertTriangle className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-feedback-danger-text">{error}</p>
                    <button
                        type="button"
                        onClick={() => setError('')}
                        aria-label="Uždaryti pranešimą"
                        className="ml-auto text-caption font-semibold text-feedback-danger-text underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                    >
                        Uždaryti
                    </button>
                </div>
            )}

            {/* Action-failure banner — kept separate from the fetch error so a failed approve/decline
                never wipes the loaded list (§8 banned window.alert; §10 never raw err.message). */}
            {actionError && (
                <div
                    role="alert"
                    className="flex items-start gap-3 rounded-control border-l-4 border-feedback-danger bg-feedback-danger-soft p-4"
                >
                    <AlertTriangle className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-feedback-danger-text">{actionError}</p>
                    <button
                        type="button"
                        onClick={() => setActionError('')}
                        aria-label="Uždaryti pranešimą"
                        className="ml-auto text-caption font-semibold text-feedback-danger-text underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                    >
                        Uždaryti
                    </button>
                </div>
            )}

            {loading && (
                <div className="bg-surface-card rounded-card shadow-sm">
                    <Spinner label="Kraunami duomenys…" />
                </div>
            )}

            {!loading && !error && calendarHistory.length === 0 && (
                <div className="bg-surface-card p-8 rounded-card shadow-sm text-center text-ink-muted">
                    Pagal pasirinktą laikotarpį nėra išsaugota jokių kalendoriaus pakeitimų istorijoje.
                </div>
            )}

            {!loading && calendarHistory.length > 0 && (
                <>
                    {/* Mobile / touch: one card per change (never a horizontally-scrolling table — §9) */}
                    <ul className="space-y-3 md:hidden">
                        {calendarHistory.map((item) => {
                            const e = deriveCalendarEntry(item);
                            const { TypeIcon } = e;
                            return (
                                <li key={item.id} className="bg-surface-card rounded-card border border-line shadow-sm p-4 space-y-3">
                                    <div className="flex items-start justify-between gap-2">
                                        <span className="text-body font-bold text-ink-strong truncate">{e.workerLabel}</span>
                                        <span className={`shrink-0 px-2 py-0.5 rounded-full text-caption font-bold ${e.statusColor}`}>
                                            {e.statusLabel}
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className={`px-2 py-0.5 rounded text-caption uppercase font-bold border ${e.actionColor}`}>
                                            {e.actionText}
                                        </span>
                                        <span className={`text-caption font-semibold flex items-center gap-1 ${e.typeColor}`}>
                                            {TypeIcon && <TypeIcon className="w-3.5 h-3.5" aria-hidden="true" />}
                                            {e.typeLabel}
                                        </span>
                                    </div>
                                    <dl className="grid grid-cols-1 gap-1 text-body">
                                        <div className="flex flex-col">
                                            <dt className="text-caption uppercase font-bold tracking-wide text-ink-muted">Data ir laikas</dt>
                                            <dd className="font-mono text-ink">{e.calendarTimeLabel}</dd>
                                        </div>
                                        <div className="flex flex-col">
                                            <dt className="text-caption uppercase font-bold tracking-wide text-ink-muted">Keitimo laikas</dt>
                                            <dd className="font-mono text-ink-muted">{e.actionTimeLabel}</dd>
                                        </div>
                                        <div className="flex flex-col">
                                            <dt className="text-caption uppercase font-bold tracking-wide text-ink-muted">Patvirtino</dt>
                                            <dd className="text-ink">{e.managerLabel}</dd>
                                        </div>
                                        {e.reasonLabel !== '-' && (
                                            <div className="flex flex-col">
                                                <dt className="text-caption uppercase font-bold tracking-wide text-ink-muted">Priežastis</dt>
                                                <dd className="italic text-ink break-words">{e.reasonLabel}</dd>
                                            </div>
                                        )}
                                    </dl>
                                    {renderDecision(item)}
                                </li>
                            );
                        })}
                    </ul>

                    {/* Desktop / wide: denser table is allowed (§9) */}
                    <div className="hidden bg-surface-card rounded-card shadow-sm border border-line overflow-x-auto md:block">
                        <table className="min-w-full divide-y divide-line">
                            <thead className="bg-surface-sunken">
                                <tr>
                                    <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Meistras</th>
                                    <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Data ir laikas (kalendoriuje)</th>
                                    <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Veiksmas / tipas</th>
                                    <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Keitimo laikas</th>
                                    <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Patvirtino / būsena</th>
                                    <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Priežastis</th>
                                    <th scope="col" className="px-4 py-3 text-left text-caption font-bold text-ink-muted uppercase tracking-wider">Sprendimas</th>
                                </tr>
                            </thead>
                            <tbody className="bg-surface-card divide-y divide-line">
                                {calendarHistory.map((item) => {
                                    const e = deriveCalendarEntry(item);
                                    const { TypeIcon } = e;
                                    return (
                                        <tr key={item.id} className="hover:bg-surface-sunken transition-colors">
                                            <td className="px-4 py-3 whitespace-nowrap text-body font-medium text-ink-strong">
                                                {e.workerLabel}
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap text-caption text-ink-muted font-mono">
                                                {e.calendarTimeLabel}
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                <div className="flex flex-col gap-1 items-start">
                                                    <span className={`px-2 py-0.5 rounded text-caption uppercase font-bold border ${e.actionColor}`}>
                                                        {e.actionText}
                                                    </span>
                                                    <span className={`text-caption font-semibold flex items-center gap-1 ${e.typeColor}`}>
                                                        {TypeIcon && <TypeIcon className="w-3 h-3" aria-hidden="true" />}
                                                        {e.typeLabel}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap text-caption text-ink-muted font-mono">
                                                {e.actionTimeLabel}
                                            </td>
                                            <td className="px-4 py-3 whitespace-nowrap">
                                                <div className="flex flex-col gap-1 items-start">
                                                    <span className={`px-2 py-0.5 rounded-full text-caption font-bold ${e.statusColor}`}>
                                                        {e.statusLabel}
                                                    </span>
                                                    <span className="text-caption text-ink-muted font-medium">
                                                        {e.managerLabel}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-body text-ink italic max-w-xs break-words">
                                                {e.reasonLabel}
                                            </td>
                                            <td className="px-4 py-3 w-52">
                                                {renderDecision(item)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}
