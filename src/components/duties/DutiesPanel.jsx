import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { format } from 'date-fns';
import { lt } from 'date-fns/locale';
import {
    AlertTriangle, CalendarCheck, CheckCircle2, CircleDashed, Clock, History, ListChecks, Pencil, Plus,
} from 'lucide-react';
import { db } from '../../firebase';
import { useAuth } from '../../context/AuthContext';
import { useUsers } from '../../context/UsersContext';
import { useToast } from '../../context/ToastContext';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Card from '../ui/Card';
import Modal from '../ui/Modal';
import ConfirmDialog from '../ui/ConfirmDialog';
import StatusPill from '../ui/StatusPill';
import EmptyState from '../ui/EmptyState';
import DatePicker from '../ui/DatePicker';
import Select from '../ui/Select';
import PersonSelect from '../ui/PersonSelect';
import { Spinner } from '../ui/Loading';
import { getLithuanianDateString } from '../../utils/timeUtils';
import { formatDisplayName, isAdminRole, isManagerRole } from '../../utils/formatters';
import { preventEnterSubmit } from '../../utils/formUtils';
import { logError } from '../../utils/errorLog';
import {
    DUTY_INTERVALS, DUTY_NOTE_MAX, DUTY_TITLE_MAX, dutyIntervalLabel, dutyStatus, sortDuties,
    validateDutyFields, validateDutyMark,
} from '../../utils/duties';
import { archiveDuty, createDuty, markDuty, updateDuty } from '../../utils/dutyActions';

const STATUS_ICONS = { late: AlertTriangle, never: CircleDashed, soon: Clock, ok: CheckCircle2 };

const inputClass =
    'min-h-touch w-full rounded-input border border-line bg-surface-card px-3 py-2 text-body-lg ' +
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring';

// "2026-10-15" → "spalio 15 d." (the lt locale formats the month in the genitive).
function formatDutyDate(dateStr) {
    if (!dateStr) return '—';
    const [y, m, d] = dateStr.split('-').map(Number);
    return `${format(new Date(y, m - 1, d), 'MMMM d', { locale: lt })} d.`;
}

function formatMarkedAt(ts) {
    const date = ts?.toDate?.();
    return date ? format(date, 'yyyy-MM-dd HH:mm') : 'ką tik';
}

function ErrorNote({ children }) {
    if (!children) return null;
    return (
        <div role="alert" className="flex items-start gap-2 rounded-control bg-feedback-danger-soft p-3 text-body text-feedback-danger-text">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{children}</span>
        </div>
    );
}

function useDuties(uid, seesAll) {
    const [state, setState] = useState({ duties: [], loading: true, failed: false });
    useEffect(() => {
        if (!uid) return undefined;
        // A coordinator's query must name their own ownerId — the rules allow exactly that.
        const q = seesAll
            ? collection(db, 'duties')
            : query(collection(db, 'duties'), where('ownerId', '==', uid));
        return onSnapshot(
            q,
            (snap) => setState({
                duties: snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => !d.archived),
                loading: false,
                failed: false,
            }),
            (err) => {
                logError(err, { source: 'onSnapshot:duties' });
                setState({ duties: [], loading: false, failed: true });
            }
        );
    }, [uid, seesAll]);
    return state;
}

function DutyCard({ duty, today, onMark, onEdit, onHistory }) {
    const status = dutyStatus(duty, today);
    const StatusIcon = STATUS_ICONS[status.kind];
    return (
        <Card as="li" className="p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="break-words text-body-lg font-semibold text-ink-strong">{duty.title}</h3>
                    <p className="text-caption text-ink-muted">{dutyIntervalLabel(duty.intervalDays)}</p>
                </div>
                <StatusPill tone={status.tone} icon={StatusIcon} className="shrink-0">{status.label}</StatusPill>
            </div>

            <p className="mt-2 text-body text-ink">
                {duty.coveredThrough ? (
                    <>
                        Suvesta iki <strong className="font-semibold">{formatDutyDate(duty.coveredThrough)}</strong> imtinai
                        <span className="text-ink-muted"> · kitas kartas iki {formatDutyDate(status.nextDue)}</span>
                    </>
                ) : (
                    <span className="text-ink-muted">Dar nė karto nepažymėta.</span>
                )}
            </p>
            {duty.lastNote && <p className="mt-1 break-words text-body text-ink-muted">„{duty.lastNote}“</p>}

            <div className="mt-3 flex items-center gap-2">
                <Button icon={CalendarCheck} onClick={() => onMark(duty)}>Pažymėti</Button>
                <IconButton icon={History} label={`${duty.title} — istorija`} title="Istorija" onClick={() => onHistory(duty)} />
                <IconButton icon={Pencil} label={`${duty.title} — redaguoti`} title="Redaguoti" onClick={() => onEdit(duty)} />
            </div>
        </Card>
    );
}

function DutyFormModal({ duty, isAdmin, currentUid, ownerOptions, onClose, onArchive }) {
    const { showToast } = useToast();
    const isEdit = Boolean(duty);
    const [title, setTitle] = useState(duty?.title || '');
    const [intervalDays, setIntervalDays] = useState(duty?.intervalDays || 7);
    const [ownerId, setOwnerId] = useState(duty?.ownerId || currentUid);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const handleSave = async () => {
        const fields = { title, intervalDays, ownerId: isAdmin ? ownerId : (duty?.ownerId || currentUid) };
        const invalid = validateDutyFields(fields);
        if (invalid) { setError(invalid); return; }
        setBusy(true);
        setError(null);
        try {
            if (isEdit) {
                await updateDuty(duty.id, isAdmin ? fields : { title, intervalDays });
            } else {
                await createDuty(fields, currentUid);
            }
            showToast(isEdit ? 'Pareiga atnaujinta.' : 'Pareiga sukurta.', { tone: 'success' });
            onClose();
        } catch (err) {
            logError(err, { source: isEdit ? 'updateDuty' : 'createDuty' });
            setError('Nepavyko išsaugoti. Bandykite dar kartą.');
            setBusy(false);
        }
    };

    return (
        <Modal
            onClose={onClose}
            title={isEdit ? 'Redaguoti pareigą' : 'Nauja pareiga'}
            closeOnBackdrop={false}
            dismissible={!busy}
            footer={
                <div className="flex items-center gap-2">
                    {isEdit && (
                        <Button variant="ghost" onClick={() => onArchive(duty)} disabled={busy}>Archyvuoti</Button>
                    )}
                    <Button variant="secondary" onClick={onClose} disabled={busy} className="ml-auto">Atšaukti</Button>
                    <Button onClick={handleSave} loading={busy}>Išsaugoti</Button>
                </div>
            }
        >
            <form className="space-y-4" onKeyDown={preventEnterSubmit} onSubmit={(e) => e.preventDefault()}>
                <div>
                    <label htmlFor="duty-title" className="mb-1 block text-caption font-medium text-ink-muted">Pavadinimas</label>
                    <input
                        id="duty-title"
                        type="text"
                        value={title}
                        maxLength={DUTY_TITLE_MAX}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="pvz. Išsiųsti atsiliepimai"
                        className={inputClass}
                    />
                </div>
                <div>
                    <span className="mb-1 block text-caption font-medium text-ink-muted">Kaip dažnai</span>
                    <Select
                        label="Kaip dažnai"
                        value={String(intervalDays)}
                        onChange={(v) => setIntervalDays(Number(v))}
                        options={DUTY_INTERVALS.map((i) => ({ value: String(i.value), label: i.label }))}
                        alwaysSheet
                    />
                </div>
                {isAdmin && (
                    <div>
                        <span className="mb-1 block text-caption font-medium text-ink-muted">Atsakingas</span>
                        <PersonSelect label="Atsakingas" value={ownerId} onChange={setOwnerId} users={ownerOptions} />
                    </div>
                )}
                <ErrorNote>{error}</ErrorNote>
            </form>
        </Modal>
    );
}

function DutyMarkModal({ duty, today, currentUid, onClose }) {
    const { showToast } = useToast();
    const [date, setDate] = useState(today);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const handleSave = async () => {
        const invalid = validateDutyMark(date, today, note);
        if (invalid) { setError(invalid); return; }
        setBusy(true);
        setError(null);
        try {
            await markDuty(duty.id, { coveredThrough: date, note }, currentUid);
            showToast(`Pažymėta: suvesta iki ${formatDutyDate(date)} imtinai.`, { tone: 'success' });
            onClose();
        } catch (err) {
            logError(err, { source: 'markDuty' });
            setError('Nepavyko pažymėti. Bandykite dar kartą.');
            setBusy(false);
        }
    };

    return (
        <Modal
            onClose={onClose}
            title={duty.title}
            closeOnBackdrop={false}
            dismissible={!busy}
            footer={
                <div className="flex items-center gap-2">
                    <Button variant="secondary" onClick={onClose} disabled={busy} className="ml-auto">Atšaukti</Button>
                    <Button icon={CalendarCheck} onClick={handleSave} loading={busy}>Pažymėti</Button>
                </div>
            }
        >
            <form className="space-y-4" onKeyDown={preventEnterSubmit} onSubmit={(e) => e.preventDefault()}>
                <div>
                    <label htmlFor="duty-mark-date" className="mb-1 block text-caption font-medium text-ink-muted">
                        Suvesta iki (imtinai)
                    </label>
                    <DatePicker id="duty-mark-date" value={date} onChange={setDate} max={today} className="w-full" />
                    {duty.coveredThrough && (
                        <p className="mt-1 text-caption text-ink-muted">Ankstesnė žyma: iki {formatDutyDate(duty.coveredThrough)}</p>
                    )}
                </div>
                <div>
                    <label htmlFor="duty-mark-note" className="mb-1 block text-caption font-medium text-ink-muted">
                        Pastaba (nebūtina)
                    </label>
                    <textarea
                        id="duty-mark-note"
                        rows={3}
                        value={note}
                        maxLength={DUTY_NOTE_MAX}
                        onChange={(e) => setNote(e.target.value)}
                        className={`${inputClass} resize-none`}
                    />
                </div>
                <ErrorNote>{error}</ErrorNote>
            </form>
        </Modal>
    );
}

function DutyHistoryModal({ duty, usersMap, onClose }) {
    const [state, setState] = useState({ marks: [], loading: true, failed: false });
    useEffect(() => {
        let alive = true;
        getDocs(query(collection(db, 'duties', duty.id, 'marks'), orderBy('markedAt', 'desc'), limit(50)))
            .then((snap) => alive && setState({ marks: snap.docs.map((d) => ({ id: d.id, ...d.data() })), loading: false, failed: false }))
            .catch((err) => {
                logError(err, { source: 'getDocs:duty-marks' });
                if (alive) setState({ marks: [], loading: false, failed: true });
            });
        return () => { alive = false; };
    }, [duty.id]);

    return (
        <Modal onClose={onClose} title={`${duty.title} — istorija`}>
            {state.loading && <div className="flex justify-center p-4"><Spinner /></div>}
            {state.failed && <ErrorNote>Nepavyko įkelti istorijos. Bandykite dar kartą.</ErrorNote>}
            {!state.loading && !state.failed && state.marks.length === 0 && (
                <p className="text-body text-ink-muted">Žymų dar nėra.</p>
            )}
            {state.marks.length > 0 && (
                <ol className="divide-y divide-line">
                    {state.marks.map((m) => (
                        <li key={m.id} className="py-2">
                            <p className="text-body text-ink">
                                Iki <strong className="font-semibold">{formatDutyDate(m.coveredThrough)}</strong> imtinai
                            </p>
                            <p className="text-caption text-ink-muted">
                                {formatDisplayName(usersMap[m.markedBy]?.displayName || '') || 'Nežinomas'} · {formatMarkedAt(m.markedAt)}
                            </p>
                            {m.note && <p className="mt-0.5 break-words text-body text-ink-muted">„{m.note}“</p>}
                        </li>
                    ))}
                </ol>
            )}
        </Modal>
    );
}

/**
 * Savaitiniai darbai — a checklist of standing duties with a "covered through" date and no timer.
 * Each coordinator sees their own; an admin sees everyone's, grouped by person.
 */
export default function DutiesPanel() {
    const { currentUser, userRole } = useAuth();
    const { usersMap, activeUsers } = useUsers();
    const { showToast } = useToast();
    const uid = currentUser?.uid;
    const isAdmin = isAdminRole(userRole);
    const { duties, loading, failed } = useDuties(uid, isAdmin);
    const [dialog, setDialog] = useState(null); // { type: 'create'|'edit'|'mark'|'history'|'archive', duty }
    const [archiving, setArchiving] = useState(false);
    const today = getLithuanianDateString();

    const ownerOptions = useMemo(
        () => activeUsers.filter((u) => isManagerRole(u.role) || isAdminRole(u.role)),
        [activeUsers]
    );

    // Admin: one group per person, the admin's own first. Coordinator: a single, unlabelled group.
    const groups = useMemo(() => {
        const nameOf = (id) => formatDisplayName(usersMap[id]?.displayName || '') || 'Nežinomas';
        if (!isAdmin) return [{ ownerId: uid, label: null, duties: sortDuties(duties, today) }];
        const byOwner = new Map();
        duties.forEach((d) => {
            if (!byOwner.has(d.ownerId)) byOwner.set(d.ownerId, []);
            byOwner.get(d.ownerId).push(d);
        });
        return [...byOwner.entries()]
            .map(([ownerId, list]) => ({ ownerId, label: nameOf(ownerId), duties: sortDuties(list, today) }))
            .sort((a, b) => (a.ownerId === uid ? -1 : b.ownerId === uid ? 1 : a.label.localeCompare(b.label, 'lt')));
    }, [duties, isAdmin, uid, usersMap, today]);

    const close = () => setDialog(null);

    const confirmArchive = async () => {
        setArchiving(true);
        try {
            await archiveDuty(dialog.duty.id);
            showToast('Pareiga archyvuota.', { tone: 'success' });
            close();
        } catch (err) {
            logError(err, { source: 'archiveDuty' });
            showToast('Nepavyko archyvuoti. Bandykite dar kartą.', { tone: 'warning' });
        } finally {
            setArchiving(false);
        }
    };

    const cardHandlers = {
        onMark: (duty) => setDialog({ type: 'mark', duty }),
        onEdit: (duty) => setDialog({ type: 'edit', duty }),
        onHistory: (duty) => setDialog({ type: 'history', duty }),
    };

    return (
        <div className="space-y-6 pt-1 sm:pt-4">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <ListChecks className="h-6 w-6 shrink-0 text-ink" aria-hidden="true" />
                        <h1 className="text-h1 font-bold text-ink-strong">Savaitiniai darbai</h1>
                    </div>
                    <p className="mt-1 text-body text-ink-muted">
                        Pažymėkite, iki kurios dienos pareiga atlikta. Laikas čia neskaičiuojamas — jį žymėkite kaip einamąjį darbą.
                    </p>
                </div>
                <Button icon={Plus} onClick={() => setDialog({ type: 'create' })}>Nauja pareiga</Button>
            </header>

            {loading && <div className="flex justify-center p-8"><Spinner /></div>}
            {failed && <ErrorNote>Nepavyko įkelti pareigų. Perkraukite puslapį.</ErrorNote>}

            {!loading && !failed && duties.length === 0 && (
                <EmptyState
                    icon={ListChecks}
                    title="Pareigų dar nėra"
                    description="Sukurkite pirmąją, pvz. „Išsiųsti atsiliepimai“, ir žymėkite, iki kada atlikta."
                    action={<Button icon={Plus} onClick={() => setDialog({ type: 'create' })}>Nauja pareiga</Button>}
                />
            )}

            {!loading && !failed && groups.map((group) => group.duties.length > 0 && (
                <section key={group.ownerId} aria-label={group.label || 'Mano pareigos'} className="space-y-3">
                    {group.label && <h2 className="text-h3 font-semibold text-ink-strong">{group.label}</h2>}
                    <ul className="grid gap-3 md:grid-cols-2">
                        {group.duties.map((duty) => (
                            <DutyCard key={duty.id} duty={duty} today={today} {...cardHandlers} />
                        ))}
                    </ul>
                </section>
            ))}

            {(dialog?.type === 'create' || dialog?.type === 'edit') && (
                <DutyFormModal
                    duty={dialog.duty}
                    isAdmin={isAdmin}
                    currentUid={uid}
                    ownerOptions={ownerOptions}
                    onClose={close}
                    // Modals swap, never stack: the confirm replaces the edit form.
                    onArchive={(duty) => setDialog({ type: 'archive', duty })}
                />
            )}
            {dialog?.type === 'mark' && (
                <DutyMarkModal duty={dialog.duty} today={today} currentUid={uid} onClose={close} />
            )}
            {dialog?.type === 'history' && (
                <DutyHistoryModal duty={dialog.duty} usersMap={usersMap} onClose={close} />
            )}
            {dialog?.type === 'archive' && (
                <ConfirmDialog
                    title="Archyvuoti pareigą?"
                    message={`„${dialog.duty.title}“ dings iš sąrašo. Jos istorija išliks.`}
                    confirmLabel="Archyvuoti"
                    variant="danger"
                    loading={archiving}
                    onConfirm={confirmArchive}
                    onCancel={close}
                />
            )}
        </div>
    );
}
