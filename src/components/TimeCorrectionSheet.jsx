import { useState, useEffect, useMemo, useId } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { Play, Square, Clock, Coffee, MessageSquare, ChevronLeft, Sparkles, CheckCircle2, Flag } from 'lucide-react';
import clsx from 'clsx';
import { db } from '../firebase';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Select from './ui/Select';
import { formatTime } from '../utils/formatters';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { deriveSessionFields, validateSelfReduction, reduceOwnWorkSession } from '../utils/sessionEditActions';
import { notifyMany } from '../utils/notify';
import { logError } from '../utils/errorLog';
import { suggestTimeCorrection } from '../utils/aiActions';
import {
    CORRECTION_KINDS as K,
    CORRECTION_KIND_LABELS,
    workDayClockToISO,
    findOverlap,
    intervalMinutes,
    describeCorrection,
    buildCorrectionRequest,
    isNotFuture,
} from '../utils/timeCorrectionRequest';

// "Pranešti apie laiko klaidą" — the worker's one place to say "my logged day is wrong".
//
// Built for a phone in a gloved hand: the first screen is five big choices, nothing to type. Each
// choice opens a short form that is already filled from the day's own rows (the gap the timer missed,
// the row that ran too long), so the common case is two taps. Detail — a comment — is one expander
// away, never required except for "Kita", where the AI turns the worker's words into the same
// structured fix and asks "Ar teisingai supratome?" before anything is sent.
//
// What each choice DOES is decided in utils/timeCorrectionRequest.js: giving time back applies on
// the spot (ADR 0023); adding time becomes a request the manager answers with Taip / Ne.

// Minimum untracked stretch worth offering as a "you probably forgot to start" suggestion.
const MIN_GAP_MINUTES = 10;

const KIND_CHOICES = [
    { kind: K.MISSED_START, icon: Play, hint: 'Dirbau, bet laikmatis nebuvo paleistas' },
    { kind: K.MISSED_STOP, icon: Square, hint: 'Laikmatis veikė ilgiau nei dirbau' },
    { kind: K.WRONG_TIME, icon: Clock, hint: 'Įrašo pradžia ar pabaiga neteisinga' },
    { kind: K.BREAK_WAS_WORK, icon: Coffee, hint: 'Pažymėta pauzė, bet iš tikrųjų dirbau' },
    { kind: K.OTHER, icon: MessageSquare, hint: 'Parašykite savais žodžiais' },
];

const ERROR_COPY = {
    fields: 'Nurodykite pradžios ir pabaigos laiką.',
    order: 'Pabaiga turi būti vėlesnė už pradžią.',
    tooLong: 'Intervalas viršija 16 val. — patikrinkite laiką.',
    invalid: 'Neteisingas laikas.',
    future: 'Negalima nurodyti laiko ateityje.',
    overlapWork: 'Šis laikas jau įrašytas kitoje veikloje. Pasirinkite „Neteisingas laikas“.',
    overlapBreak: 'Šiuo metu pažymėta pauzė. Pasirinkite „Pauzė buvo darbas“.',
    overlapOther: 'Šis laikas persidengia su kitu įrašu.',
    notShorter: 'Tai ne sumažinimas. Jei dirbote ilgiau, pasirinkite „Neteisingas laikas“.',
    row: 'Pasirinkite įrašą.',
    unchanged: 'Laikas nepakeistas.',
    note: 'Parašykite, kas nutiko.',
    noManager: 'Jums nepriskirtas koordinatorius, todėl prašymo išsiųsti negalima.',
    tooShort: 'Turi likti bent 1 min. Jei visai nedirbote, parašykite per „Kita“.',
    send: 'Nepavyko išsiųsti. Bandykite dar kartą.',
    apply: 'Nepavyko pataisyti laiko. Bandykite dar kartą.',
};

// "Not filled in yet" states: the disabled button already says so, a red banner would only scold.
const QUIET_ERRORS = new Set(['note', 'fields', 'row', 'unchanged']);

const inputClass =
    'min-h-touch w-full rounded-input border border-line bg-surface-card px-3 py-2 text-body-lg ' +
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring';

const clock = (iso) => (iso ? formatTime(iso) : '');

/**
 * @param {Object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {string} props.day - the WORK day being corrected ('YYYY-MM-DD').
 * @param {{uid:string, displayName?:string, email?:string, name:string}} props.worker
 * @param {Object[]} props.workRows - the worker's own FINISHED work_sessions rows on that day.
 * @param {Object[]} props.breakRows - the worker's own FINISHED break_sessions rows on that day.
 * @param {string[]} props.managerIds - request recipients (the worker's managers).
 * @param {string[]} props.adminUids - FYI recipients for an on-the-spot reduction.
 */
export default function TimeCorrectionSheet({ open, onClose, day, worker, workRows = [], breakRows = [], managerIds = [], adminUids = [] }) {
    const fieldId = useId();
    const [step, setStep] = useState('pick'); // 'pick' | a kind | 'ai-review' | 'done'
    const [kind, setKind] = useState(null);
    const [rowId, setRowId] = useState('');
    const [taskId, setTaskId] = useState('');
    const [startStr, setStartStr] = useState('');
    const [endStr, setEndStr] = useState('');
    const [note, setNote] = useState('');
    const [showNote, setShowNote] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [doneMessage, setDoneMessage] = useState('');
    const [proposal, setProposal] = useState(null); // AI result, shown on 'ai-review'
    const [myTasks, setMyTasks] = useState([]);

    const works = useMemo(
        () => workRows.filter((r) => r?.id && r.startTime && r.endTime && !r.isDeleted)
            .sort((a, b) => a.startTime.localeCompare(b.startTime)),
        [workRows]
    );
    const breaks = useMemo(
        () => breakRows.filter((r) => r?.id && r.startTime && r.endTime)
            .sort((a, b) => a.startTime.localeCompare(b.startTime)),
        [breakRows]
    );

    // The worker's own tasks, for "which task was it". One read on open — the day's rows already
    // name the tasks touched today, this adds the ones not yet started.
    useEffect(() => {
        if (!open || !worker?.uid) return;
        let alive = true;
        getDocs(query(collection(db, 'tasks'), where('assignedUserId', '==', worker.uid)))
            .then((snap) => {
                if (!alive) return;
                setMyTasks(snap.docs
                    .map((d) => ({ id: d.id, ...d.data() }))
                    .filter((t) => !t.isDeleted && t.status !== 'deleted' && !t.isSystemTask && !t.isQuickWork)
                    .map((t) => ({ id: t.id, title: t.title || 'Užduotis' })));
            })
            .catch((err) => logError(err, { source: 'readFail:TimeCorrectionSheet:tasks' }));
        return () => { alive = false; };
    }, [open, worker?.uid]);

    // Today's tasks first (the ones the worker actually touched), then the rest of their list.
    const taskOptions = useMemo(() => {
        const seen = new Set();
        const out = [];
        for (const r of works) {
            if (!r.taskId || /^(quick_|call_|manual_)/.test(r.taskId) || seen.has(r.taskId)) continue;
            seen.add(r.taskId);
            out.push({ id: r.taskId, title: r.taskTitle || 'Užduotis' });
        }
        for (const t of myTasks) {
            if (seen.has(t.id)) continue;
            seen.add(t.id);
            out.push(t);
        }
        return out.slice(0, 40);
    }, [works, myTasks]);

    // Untracked stretches between the day's rows — the most likely "I forgot to start" windows.
    const gaps = useMemo(() => {
        const all = [...works, ...breaks].sort((a, b) => a.startTime.localeCompare(b.startTime));
        const out = [];
        let runningEnd = null;
        for (const r of all) {
            if (runningEnd && r.startTime > runningEnd && intervalMinutes(runningEnd, r.startTime) >= MIN_GAP_MINUTES) {
                out.push({ start: runningEnd, end: r.startTime, nextTaskId: r.taskId || '' });
            }
            if (!runningEnd || r.endTime > runningEnd) runningEnd = r.endTime;
        }
        return out;
    }, [works, breaks]);

    const canRequest = managerIds.length > 0;
    const taskTitleOf = (id) => taskOptions.find((t) => t.id === id)?.title || null;
    const rowOf = (id) => works.find((r) => r.id === id) || breaks.find((r) => r.id === id) || null;

    const reset = () => {
        setError('');
        setProposal(null);
        setShowNote(false);
    };

    // Open one kind's form with its most likely answer already filled in.
    const choose = (next) => {
        reset();
        setKind(next);
        setStep(next);
        if (next === K.MISSED_START) {
            const g = gaps[gaps.length - 1];
            setStartStr(g ? clock(g.start) : '');
            setEndStr(g ? clock(g.end) : '');
            const fromGap = g?.nextTaskId && taskOptions.some((t) => t.id === g.nextTaskId) ? g.nextTaskId : '';
            setTaskId(fromGap || taskOptions[0]?.id || '');
        } else if (next === K.MISSED_STOP || next === K.WRONG_TIME) {
            const r = works[works.length - 1];
            setRowId(r?.id || '');
            setStartStr(r ? clock(r.startTime) : '');
            setEndStr(r ? clock(r.endTime) : '');
        } else if (next === K.BREAK_WAS_WORK) {
            const r = breaks[breaks.length - 1];
            setRowId(r?.id || '');
            setTaskId(taskOptions[0]?.id || '');
        } else if (next === K.OTHER) {
            setShowNote(true);
        }
    };

    const pickRow = (r) => {
        setRowId(r.id);
        setStartStr(clock(r.startTime));
        setEndStr(clock(r.endTime));
        setError('');
    };

    const startISO = startStr ? workDayClockToISO(day, startStr) : null;
    const endISO = endStr ? workDayClockToISO(day, endStr) : null;
    const selectedRow = rowOf(rowId);

    // Live consequence for the open form: the resulting minutes, and the first blocking problem.
    const check = useMemo(() => {
        if (kind === K.MISSED_START) {
            if (!startISO || !endISO) return { error: 'fields' };
            const d = deriveSessionFields(startISO, endISO);
            if (!d.ok) return { error: d.error };
            if (!isNotFuture(endISO)) return { error: 'future' };
            if (findOverlap(startISO, endISO, works)) return { error: 'overlapWork' };
            if (findOverlap(startISO, endISO, breaks)) return { error: 'overlapBreak' };
            return { minutes: d.durationMinutes, path: 'request' };
        }
        if (kind === K.MISSED_STOP || kind === K.WRONG_TIME) {
            if (!selectedRow) return { error: 'row' };
            if (!startISO || !endISO) return { error: 'fields' };
            const d = deriveSessionFields(startISO, endISO);
            if (!d.ok) return { error: d.error };
            if (!isNotFuture(endISO)) return { error: 'future' };
            const sameStart = startStr === clock(selectedRow.startTime);
            if (sameStart && endStr === clock(selectedRow.endTime)) return { error: 'unchanged' };
            if (findOverlap(startISO, endISO, works, { ignoreId: selectedRow.id })) return { error: 'overlapOther' };
            // An earlier END on the same start is giving time back → applied on the spot.
            if (sameStart) {
                const red = validateSelfReduction(selectedRow, endISO);
                if (red.ok) return { minutes: red.durationMinutes, path: 'reduce' };
                if (red.error === 'tooShort') return { error: 'tooShort' };
            }
            if (kind === K.MISSED_STOP) return { error: 'notShorter' };
            return { minutes: d.durationMinutes, path: 'request' };
        }
        if (kind === K.BREAK_WAS_WORK) {
            if (!selectedRow) return { error: 'row' };
            return { minutes: intervalMinutes(selectedRow.startTime, selectedRow.endTime), path: 'request' };
        }
        if (kind === K.OTHER) {
            return note.trim() ? { path: 'ai' } : { error: 'note' };
        }
        return { error: 'row' };
    }, [kind, startISO, endISO, startStr, endStr, selectedRow, works, breaks, note]);

    const blockedByManager = check.path === 'request' && !canRequest;

    const sendRequest = async (fields) => {
        await notifyMany(managerIds, buildCorrectionRequest({ day, worker: { uid: worker.uid, name: worker.name }, note, ...fields }));
    };

    // Send / apply what the current form (or a confirmed AI proposal) describes.
    // `plainComment` sends the worker's words alone ("Ne, siųsti tik komentarą"), whatever the form
    // currently holds — the AI proposal loaded into it must never ride along on a "Ne".
    const submit = async ({ fromProposal = false, plainComment = false } = {}) => {
        if (busy) return;
        const k = plainComment ? K.OTHER : kind;
        setBusy(true);
        setError('');
        try {
            if (!plainComment && check.path === 'reduce') {
                const res = await reduceOwnWorkSession({
                    session: selectedRow,
                    worker: { uid: worker.uid, displayName: worker.displayName, email: worker.email },
                    endTime: endISO,
                    reason: note.trim() || CORRECTION_KIND_LABELS[k],
                    adminUids,
                });
                if (!res.ok) { setError(ERROR_COPY.apply); return; }
                setDoneMessage('Laikas pataisytas iš karto. Administratoriai informuoti.');
                setStep('done');
                return;
            }
            if (!canRequest) { setError(ERROR_COPY.noManager); return; }
            if (k === K.MISSED_START) {
                await sendRequest({ kind: k, taskId: taskId || null, taskTitle: taskTitleOf(taskId), startTime: startISO, endTime: endISO, aiSuggested: fromProposal });
            } else if (k === K.WRONG_TIME) {
                await sendRequest({
                    kind: k, sessionRef: selectedRow.id, taskId: selectedRow.taskId || null, taskTitle: selectedRow.taskTitle || null,
                    startTime: startISO, endTime: endISO,
                    originalStartTime: selectedRow.startTime, originalEndTime: selectedRow.endTime, aiSuggested: fromProposal,
                });
            } else if (k === K.BREAK_WAS_WORK) {
                await sendRequest({
                    kind: k, breakRef: selectedRow.id, taskId: taskId || null, taskTitle: taskTitleOf(taskId),
                    startTime: selectedRow.startTime, endTime: selectedRow.endTime, aiSuggested: fromProposal,
                });
            } else {
                await sendRequest({ kind: K.OTHER });
            }
            setDoneMessage('Prašymas išsiųstas vadovui. Gausite pranešimą, kai jis atsakys.');
            setStep('done');
        } catch (err) {
            logError(err, { source: 'writeFail:TimeCorrectionSheet' });
            setError(ERROR_COPY.send);
        } finally {
            setBusy(false);
        }
    };

    // "Kita" → ask the AI what fix the worker means, then show it for a yes/no.
    const askAi = async () => {
        if (busy || !note.trim()) return;
        setBusy(true);
        setError('');
        try {
            const toRow = (r, type) => ({ id: r.id, type, title: r.taskTitle || '', start: clock(r.startTime), end: clock(r.endTime) });
            const res = await suggestTimeCorrection({
                text: note.trim(),
                day,
                rows: [...works.map((r) => toRow(r, 'work')), ...breaks.map((r) => toRow(r, 'break'))],
                tasks: taskOptions,
            });
            setProposal(res && res.kind ? res : { kind: K.OTHER });
        } catch (err) {
            logError(err, { source: 'aiFail:suggestTimeCorrection' });
            setProposal({ kind: K.OTHER, failed: true });
        } finally {
            setBusy(false);
            setStep('ai-review');
        }
    };

    // Load an AI proposal into the form state so it is validated and sent by the SAME path as a
    // hand-filled one — the AI can only pre-fill, never bypass a check.
    useEffect(() => {
        if (step !== 'ai-review' || !proposal || proposal.kind === K.OTHER) return;
        setKind(proposal.kind);
        setRowId(proposal.rowId || '');
        setTaskId(proposal.taskId || '');
        setStartStr(proposal.start || '');
        setEndStr(proposal.end || '');
    }, [step, proposal]);

    const proposalRow = proposal ? rowOf(proposal.rowId) : null;
    const proposalPreview = !proposal || proposal.kind === K.OTHER ? null : describeCorrection({
            correctionKind: proposal.kind === K.MISSED_STOP ? K.WRONG_TIME : proposal.kind,
            requestedStartTime: startISO,
            requestedEndTime: endISO,
            originalStartTime: proposalRow?.startTime,
            originalEndTime: proposalRow?.endTime,
            taskTitle: proposal.kind === K.MISSED_START || proposal.kind === K.BREAK_WAS_WORK
                ? taskTitleOf(proposal.taskId)
                : proposalRow?.taskTitle,
        });

    if (!open) return null;

    const title = step === 'pick' || step === 'done'
        ? 'Pranešti apie laiko klaidą'
        : step === 'ai-review'
          ? (proposal && proposal.kind !== K.OTHER ? 'Ar teisingai supratome?' : 'Siųsti komentarą')
          : CORRECTION_KIND_LABELS[kind];

    const back = (
        <Button variant="secondary" icon={ChevronLeft} onClick={() => { reset(); setStep('pick'); setKind(null); }} disabled={busy}>
            Atgal
        </Button>
    );

    let footer = null;
    if (step === 'done') {
        footer = <Button variant="primary" fullWidth onClick={onClose}>Gerai</Button>;
    } else if (step === 'ai-review') {
        const usable = proposal && proposal.kind !== K.OTHER && !check.error && !(check.path === 'request' && !canRequest);
        footer = (
            <div className="flex flex-col gap-2">
                {usable && (
                    <Button variant="primary" fullWidth icon={CheckCircle2} loading={busy} onClick={() => submit({ fromProposal: true })}>
                        {check.path === 'reduce' ? 'Taip, pataisyti' : 'Taip, siųsti vadovui'}
                    </Button>
                )}
                <Button
                    variant={usable ? 'secondary' : 'primary'}
                    fullWidth
                    icon={Flag}
                    disabled={busy || !canRequest}
                    onClick={() => submit({ plainComment: true })}
                >
                    {usable ? 'Ne, siųsti tik komentarą' : 'Siųsti komentarą vadovui'}
                </Button>
            </div>
        );
    } else if (step !== 'pick') {
        const primaryLabel = check.path === 'reduce'
            ? 'Pataisyti dabar'
            : kind === K.OTHER ? 'Toliau' : 'Siųsti vadovui';
        footer = (
            <div className="flex gap-3">
                {back}
                <Button
                    variant="primary"
                    fullWidth
                    icon={kind === K.OTHER ? Sparkles : check.path === 'reduce' ? Clock : Flag}
                    loading={busy}
                    disabled={!!check.error || blockedByManager}
                    onClick={() => (kind === K.OTHER ? askAi() : submit())}
                >
                    {primaryLabel}
                </Button>
            </div>
        );
    }

    const rowButton = (r, isBreak) => (
        <li key={r.id}>
            <button
                type="button"
                onClick={() => pickRow(r)}
                aria-pressed={rowId === r.id}
                className={clsx(
                    'flex min-h-touch w-full items-center justify-between gap-3 rounded-control border p-3 text-left',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring',
                    rowId === r.id ? 'border-brand bg-brand-soft' : 'border-line bg-surface-card'
                )}
            >
                <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-body text-ink-strong">
                        {isBreak && <Coffee className="h-4 w-4 shrink-0" aria-hidden="true" />}
                        <span className="break-words">{isBreak ? 'Pauzė' : (r.taskTitle || 'Veikla')}</span>
                    </span>
                    <span className="font-mono text-caption text-ink-muted">{clock(r.startTime)}–{clock(r.endTime)}</span>
                </span>
                <span className="font-mono text-caption text-ink-muted">
                    {formatMinutesToTimeString(intervalMinutes(r.startTime, r.endTime) || 0)}
                </span>
            </button>
        </li>
    );

    const timeFields = (
        <div className="grid grid-cols-2 gap-3">
            <div>
                <label htmlFor={`${fieldId}-start`} className="mb-1 block text-caption font-medium text-ink-muted">Nuo</label>
                <input id={`${fieldId}-start`} type="time" value={startStr} onChange={(e) => { setStartStr(e.target.value); setError(''); }} className={inputClass} />
            </div>
            <div>
                <label htmlFor={`${fieldId}-end`} className="mb-1 block text-caption font-medium text-ink-muted">Iki</label>
                <input id={`${fieldId}-end`} type="time" value={endStr} onChange={(e) => { setEndStr(e.target.value); setError(''); }} className={inputClass} />
            </div>
        </div>
    );

    const taskField = (label) => (
        <div>
            <label htmlFor={`${fieldId}-task`} className="mb-1 block text-caption font-medium text-ink-muted">{label}</label>
            <Select
                id={`${fieldId}-task`}
                value={taskId}
                onChange={setTaskId}
                options={[...taskOptions.map((t) => ({ value: t.id, label: t.title })), { value: '', label: 'Kita veikla' }]}
                label={label}
                alwaysSheet
            />
        </div>
    );

    const noteField = (
        showNote ? (
            <div>
                <label htmlFor={`${fieldId}-note`} className="mb-1 block text-caption font-medium text-ink-muted">
                    {kind === K.OTHER ? 'Kas nutiko?' : 'Komentaras (nebūtina)'}
                </label>
                <textarea
                    id={`${fieldId}-note`}
                    value={note}
                    onChange={(e) => { setNote(e.target.value); setError(''); }}
                    rows={3}
                    maxLength={1000}
                    placeholder={kind === K.OTHER ? 'pvz. Ryte pamiršau paspausti, dirbau nuo 7:30 prie stogo' : 'pvz. Telefonas buvo išsikrovęs'}
                    className={inputClass}
                />
            </div>
        ) : (
            <button
                type="button"
                onClick={() => setShowNote(true)}
                className="min-h-touch text-body font-medium text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring rounded-control"
            >
                + Pridėti komentarą
            </button>
        )
    );

    // What the primary button will do, in words — the one thing that changes its meaning.
    const consequence = !check.error && check.path !== 'ai' && (
        <div className="rounded-control border border-line bg-surface-sunken p-3" aria-live="polite">
            {check.minutes != null && (
                <div className="flex items-center justify-between gap-3">
                    <span className="text-body text-ink-muted">{check.path === 'reduce' ? 'Nauja trukmė' : kind === K.WRONG_TIME ? 'Nauja trukmė' : 'Bus pridėta'}</span>
                    <span className="font-mono text-body-lg font-bold text-brand">{formatMinutesToTimeString(check.minutes)}</span>
                </div>
            )}
            <p className="mt-1 text-caption text-ink-muted">
                {check.path === 'reduce'
                    ? 'Laiką sumažinti galite patys — pataisymas bus pritaikytas iš karto.'
                    : !canRequest
                      ? 'Laiką pridėti gali tik vadovas.'
                      : kind === K.BREAK_WAS_WORK
                        ? 'Vadovas peržiūrės ir pataisys pauzę rankiniu būdu.'
                        : 'Vadovas gaus prašymą ir atsakys „Taip“ arba „Ne“.'}
            </p>
        </div>
    );

    const shownError = error || (step === 'ai-review' && !canRequest ? ERROR_COPY.noManager : '') || (step !== 'pick' && step !== 'done' && step !== 'ai-review' && check.error && !QUIET_ERRORS.has(check.error) ? ERROR_COPY[check.error] : '') || (blockedByManager ? ERROR_COPY.noManager : '');

    return (
        <Modal open onClose={busy ? undefined : onClose} dismissible={!busy} closeOnBackdrop={false} title={title} size="md" footer={footer}>
            <div className="space-y-4">
                {step === 'pick' && (
                    <>
                        <p className="text-body text-ink-muted">{day}. Kas nutiko?</p>
                        <ul className="space-y-2">
                            {KIND_CHOICES.map(({ kind: k, icon: Icon, hint }) => (
                                <li key={k}>
                                    <button
                                        type="button"
                                        onClick={() => choose(k)}
                                        className="flex min-h-touch w-full items-center gap-3 rounded-control border border-line bg-surface-card p-3 text-left hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring"
                                    >
                                        <Icon className="h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
                                        <span className="min-w-0">
                                            <span className="block text-body font-semibold text-ink-strong">{CORRECTION_KIND_LABELS[k]}</span>
                                            <span className="block text-caption text-ink-muted">{hint}</span>
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </>
                )}

                {step === K.MISSED_START && (
                    <>
                        {taskField('Kokį darbą dirbote?')}
                        {gaps.length > 0 && (
                            <div>
                                <p className="mb-1 text-caption font-medium text-ink-muted">Neužfiksuoti tarpai</p>
                                <div className="flex flex-wrap gap-2">
                                    {gaps.map((g) => {
                                        const active = startStr === clock(g.start) && endStr === clock(g.end);
                                        return (
                                            <button
                                                key={g.start}
                                                type="button"
                                                aria-pressed={active}
                                                onClick={() => { setStartStr(clock(g.start)); setEndStr(clock(g.end)); setError(''); }}
                                                className={clsx(
                                                    'min-h-touch rounded-control border px-3 font-mono text-body',
                                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring',
                                                    active ? 'border-brand bg-brand-soft text-ink-strong' : 'border-line bg-surface-card text-ink'
                                                )}
                                            >
                                                {clock(g.start)}–{clock(g.end)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        {timeFields}
                        {consequence}
                        {noteField}
                    </>
                )}

                {(step === K.MISSED_STOP || step === K.WRONG_TIME) && (
                    works.length === 0 ? (
                        <p className="text-body text-ink-muted">Šią dieną baigtų veiklos įrašų nėra.</p>
                    ) : (
                        <>
                            <div>
                                <p className="mb-1 text-caption font-medium text-ink-muted">Kuris įrašas?</p>
                                <ul className="space-y-2">{works.map((r) => rowButton(r, false))}</ul>
                            </div>
                            {step === K.MISSED_STOP ? (
                                <div>
                                    <label htmlFor={`${fieldId}-end`} className="mb-1 block text-caption font-medium text-ink-muted">Kada iš tikrųjų baigėte?</label>
                                    <input id={`${fieldId}-end`} type="time" value={endStr} onChange={(e) => { setEndStr(e.target.value); setError(''); }} className={inputClass} />
                                </div>
                            ) : timeFields}
                            {consequence}
                            {noteField}
                        </>
                    )
                )}

                {step === K.BREAK_WAS_WORK && (
                    breaks.length === 0 ? (
                        <p className="text-body text-ink-muted">Šią dieną pauzių nepažymėta.</p>
                    ) : (
                        <>
                            <div>
                                <p className="mb-1 text-caption font-medium text-ink-muted">Kuri pauzė?</p>
                                <ul className="space-y-2">{breaks.map((r) => rowButton(r, true))}</ul>
                            </div>
                            {taskField('Kokį darbą dirbote?')}
                            {consequence}
                            {noteField}
                        </>
                    )
                )}

                {step === K.OTHER && (
                    <>
                        {noteField}
                        <p className="flex items-start gap-1.5 text-caption text-ink-muted">
                            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            Pabandysime suprasti, ką reikia pataisyti, ir parodysime prieš siunčiant.
                        </p>
                    </>
                )}

                {step === 'ai-review' && (
                    proposal && proposal.kind !== K.OTHER ? (
                        <>
                            <div className="rounded-control border border-brand bg-brand-soft p-3">
                                <p className="text-caption font-medium text-ink-muted">{CORRECTION_KIND_LABELS[proposal.kind]}</p>
                                {proposalPreview?.delta && (
                                    <p className="mt-1 font-mono text-h3 font-bold text-ink-strong">{proposalPreview.delta}</p>
                                )}
                                {proposalPreview?.detail && <p className="mt-1 text-body text-ink-strong">{proposalPreview.detail}</p>}
                                {proposal.summary && <p className="mt-2 text-caption text-ink-muted">{proposal.summary}</p>}
                            </div>
                            <p className="text-caption text-ink-muted">
                                {check.error
                                    ? (ERROR_COPY[check.error] || ERROR_COPY.invalid) + ' Galite išsiųsti tik komentarą.'
                                    : check.path === 'reduce'
                                      ? 'Laikas bus sumažintas iš karto.'
                                      : 'Vadovas gaus šį pasiūlymą ir atsakys „Taip“ arba „Ne“.'}
                            </p>
                            <blockquote className="border-l-2 border-line pl-3 text-caption italic text-ink-muted">„{note.trim()}“</blockquote>
                        </>
                    ) : (
                        <>
                            <p className="text-body text-ink">
                                {proposal?.failed
                                    ? 'Nepavyko automatiškai suprasti. Jūsų komentarą perskaitys vadovas.'
                                    : 'Iš komentaro neaišku, ką tiksliai pataisyti. Jį perskaitys vadovas.'}
                            </p>
                            <blockquote className="border-l-2 border-line pl-3 text-caption italic text-ink-muted">„{note.trim()}“</blockquote>
                        </>
                    )
                )}

                {step === 'done' && (
                    <div className="flex items-start gap-3 rounded-control bg-feedback-success-soft p-3 text-feedback-success-text">
                        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                        <p className="text-body">{doneMessage}</p>
                    </div>
                )}

                {shownError && (
                    <p role="alert" className="rounded-control bg-feedback-danger-soft p-3 text-body text-feedback-danger-text">{shownError}</p>
                )}
            </div>
        </Modal>
    );
}
