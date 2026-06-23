import { useState, useEffect, useMemo, useId } from 'react';
import { Clock, Trash2, AlertTriangle, ArrowRight } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import DatePicker from './ui/DatePicker';
import ConfirmDialog from './ui/ConfirmDialog';
import {
    formatMinutesToTimeString,
    getLithuanianDateString,
    vilniusWallClockToISO,
} from '../utils/timeUtils';
import {
    deriveSessionFields,
    editWorkSession,
    deleteWorkSession,
    createWorkSession,
} from '../utils/sessionEditActions';

// Map a stored UTC ISO to the strict "HH:MM" (24h, colon, zero-padded) that <input type="time">
// requires, in Vilnius local time. Built directly via Intl (hourCycle h23, so midnight is "00:00",
// not "24:00") rather than via formatTime, whose locale separator/format the input wouldn't accept.
const toTimeInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Vilnius',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(d);
    const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${hh}:${mm}`;
};

// Validation-error code → Lithuanian copy. Codes come from deriveSessionFields / the action layer.
const ERROR_COPY = {
    order: 'Pabaiga turi būti vėlesnė už pradžią.',
    tooLong: 'Sesija viršija 16 val. — patikrinkite, ar teisinga data.',
    invalid: 'Neteisingas laikas.',
    reason: 'Nurodykite keitimo priežastį.',
    user: 'Nepasirinktas vykdytojas.',
    write: 'Nepavyko išsaugoti. Bandykite dar kartą.',
};

/**
 * SessionEditModal — the admin tool to correct an already-finished work session's start/end (or
 * add a missing one). It edits work_sessions, the canonical logged-time record: every report sums
 * work_sessions over a Vilnius work-day window, so the credited duration and the day bucket are
 * DERIVED from the start/end the admin types, never entered by hand. The live readout shows that
 * derivation as it is typed — the new duration and the resulting total — so the consequence of an
 * edit is visible before it is saved. All writes route through sessionEditActions (clamp, original
 * snapshot, audit stamp).
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {'edit'|'create'} [props.mode='edit']
 * @param {Object} [props.session] - edit mode: the timeline item (id, startTime, endTime,
 *   durationMinutes/duration, date, edited, original* snapshot fields).
 * @param {{ id: string, name?: string }} [props.targetUser] - the worker the session belongs to.
 * @param {string} [props.defaultDate] - create mode: the day to seed (yyyy-MM-dd).
 * @param {number} [props.dayTotalMinutes] - the currently visible total, for the "A → B" preview.
 * @param {{ uid?: string, displayName?: string, email?: string }} props.editor - the acting admin.
 * @param {() => void} [props.onSaved] - called after a successful write.
 */
export default function SessionEditModal({
    open,
    onClose,
    mode = 'edit',
    session = null,
    targetUser = null,
    defaultDate = null,
    dayTotalMinutes = null,
    editor,
    onSaved,
}) {
    const isCreate = mode === 'create';
    const [startDate, setStartDate] = useState('');
    const [startTimeStr, setStartTimeStr] = useState('');
    const [endDate, setEndDate] = useState('');
    const [endTimeStr, setEndTimeStr] = useState('');
    const [reason, setReason] = useState('');
    const [title, setTitle] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    const fieldId = useId();

    // Seed the fields each time the dialog opens. Edit: from the session's stored UTC ISO, rendered
    // as the Vilnius day + clock the admin reads. Create: both dates default to the viewed day.
    useEffect(() => {
        if (!open) return;
        setError(null);
        setConfirmingDelete(false);
        setReason('');
        if (isCreate) {
            const seed = defaultDate || getLithuanianDateString();
            setStartDate(seed);
            setEndDate(seed);
            setStartTimeStr('');
            setEndTimeStr('');
            setTitle('');
        } else if (session) {
            setStartDate(getLithuanianDateString(session.startTime));
            setEndDate(getLithuanianDateString(session.endTime));
            setStartTimeStr(toTimeInput(session.startTime));
            setEndTimeStr(toTimeInput(session.endTime));
        }
    }, [open, isCreate, session, defaultDate]);

    // Recompute the derived fields (duration, day bucket) from the typed wall-clock pair.
    const { startISO, endISO, derived, complete } = useMemo(() => {
        const sISO = startDate && startTimeStr ? vilniusWallClockToISO(startDate, startTimeStr) : null;
        const eISO = endDate && endTimeStr ? vilniusWallClockToISO(endDate, endTimeStr) : null;
        return {
            startISO: sISO,
            endISO: eISO,
            complete: !!(sISO && eISO),
            derived: sISO && eISO ? deriveSessionFields(sISO, eISO) : null,
        };
    }, [startDate, startTimeStr, endDate, endTimeStr]);

    // What this row currently contributes to the visible total (sanitized value already in the sum).
    const oldContribution = isCreate
        ? 0
        : Number.isFinite(session?.duration)
          ? session.duration
          : Number.isFinite(session?.durationMinutes)
            ? session.durationMinutes
            : 0;

    const originalDay = isCreate
        ? null
        : session?.date || (session?.startTime ? getLithuanianDateString(session.startTime) : null);
    const dateChanged = !isCreate && derived?.ok && originalDay && derived.date !== originalDay;

    const hasTotal = Number.isFinite(dayTotalMinutes);
    const newTotal = derived?.ok && hasTotal ? dayTotalMinutes - oldContribution + derived.durationMinutes : null;

    const canSave =
        complete &&
        derived?.ok &&
        reason.trim().length > 0 &&
        (!isCreate ? true : !!targetUser?.id) &&
        !busy;

    const liveError = complete && derived && !derived.ok ? ERROR_COPY[derived.error] : null;

    const handleSave = async () => {
        setBusy(true);
        setError(null);
        const result = isCreate
            ? await createWorkSession({
                  userId: targetUser?.id,
                  userName: targetUser?.name,
                  taskTitle: title,
                  startTime: startISO,
                  endTime: endISO,
                  reason,
                  editor,
              })
            : await editWorkSession(session, {
                  startTime: startISO,
                  endTime: endISO,
                  reason,
                  editor,
              });
        setBusy(false);
        if (result.ok) {
            onSaved?.();
            onClose?.();
        } else {
            setError(ERROR_COPY[result.error] || ERROR_COPY.write);
        }
    };

    const handleDelete = async () => {
        setBusy(true);
        setError(null);
        const result = await deleteWorkSession(session, {
            reason: reason.trim() || 'Ištrinta administratoriaus',
            editor,
        });
        setBusy(false);
        if (result.ok) {
            setConfirmingDelete(false);
            onSaved?.();
            onClose?.();
        } else {
            setConfirmingDelete(false);
            setError(ERROR_COPY[result.error] || ERROR_COPY.write);
        }
    };

    if (!open) return null;

    const inputClass =
        'min-h-touch w-full rounded-input border border-line bg-surface-card px-3 py-2 text-body-lg ' +
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

    return (
        <>
            <Modal
                open={open}
                onClose={busy ? undefined : onClose}
                dismissible={!busy}
                closeOnBackdrop={false}
                title={isCreate ? 'Pridėti sesiją' : 'Redaguoti sesijos laiką'}
                size="lg"
                footer={
                    <div className="flex items-center gap-2">
                        {!isCreate && (
                            <Button
                                variant="ghost"
                                icon={Trash2}
                                onClick={() => setConfirmingDelete(true)}
                                disabled={busy}
                                className="text-feedback-danger hover:bg-feedback-danger-soft mr-auto"
                            >
                                Ištrinti
                            </Button>
                        )}
                        <Button variant="secondary" onClick={onClose} disabled={busy} className={isCreate ? 'ml-auto' : ''}>
                            Atšaukti
                        </Button>
                        <Button variant="primary" onClick={handleSave} disabled={!canSave} loading={busy}>
                            {isCreate ? 'Pridėti' : 'Išsaugoti'}
                        </Button>
                    </div>
                }
            >
                <div className="space-y-4">
                    {/* Who the session belongs to — context for the editing admin. */}
                    {targetUser?.name && (
                        <p className="text-body text-ink-muted">
                            Vykdytojas: <span className="font-semibold text-ink">{targetUser.name}</span>
                        </p>
                    )}

                    {isCreate && (
                        <div>
                            <label htmlFor={`${fieldId}-title`} className="mb-1 block text-caption font-medium text-ink-muted">
                                Pavadinimas
                            </label>
                            <input
                                id={`${fieldId}-title`}
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Rankinė sesija"
                                className={inputClass}
                            />
                        </div>
                    )}

                    {/* Start / end — date via the locale-aware picker, clock via a native time input. */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                            <span className="mb-1 block text-caption font-medium text-ink-muted">Pradžia</span>
                            <div className="space-y-2">
                                <DatePicker
                                    id={`${fieldId}-start-date`}
                                    value={startDate}
                                    onChange={setStartDate}
                                    aria-label="Pradžios data"
                                />
                                <input
                                    type="time"
                                    value={startTimeStr}
                                    onChange={(e) => setStartTimeStr(e.target.value)}
                                    aria-label="Pradžios laikas"
                                    className={inputClass}
                                />
                            </div>
                        </div>
                        <div>
                            <span className="mb-1 block text-caption font-medium text-ink-muted">Pabaiga</span>
                            <div className="space-y-2">
                                <DatePicker
                                    id={`${fieldId}-end-date`}
                                    value={endDate}
                                    onChange={setEndDate}
                                    aria-label="Pabaigos data"
                                />
                                <input
                                    type="time"
                                    value={endTimeStr}
                                    onChange={(e) => setEndTimeStr(e.target.value)}
                                    aria-label="Pabaigos laikas"
                                    className={inputClass}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Live derivation — the duration and the resulting total, recomputed as typed. */}
                    <div className="rounded-control border border-line bg-surface-sunken p-3" aria-live="polite">
                        <div className="flex items-center justify-between">
                            <span className="flex items-center gap-1.5 text-body text-ink-muted">
                                <Clock className="h-4 w-4" aria-hidden="true" /> Trukmė
                            </span>
                            <span className="font-mono text-body-lg font-bold text-brand">
                                {derived?.ok ? formatMinutesToTimeString(derived.durationMinutes) : '—'}
                            </span>
                        </div>
                        {hasTotal && (
                            <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
                                <span className="text-body text-ink-muted">Bendra suma</span>
                                <span className="flex items-center gap-1.5 font-mono text-body font-semibold text-ink-strong">
                                    {formatMinutesToTimeString(dayTotalMinutes)}
                                    {derived?.ok && (
                                        <>
                                            <ArrowRight className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                                            <span className="text-brand">{formatMinutesToTimeString(newTotal)}</span>
                                        </>
                                    )}
                                </span>
                            </div>
                        )}
                        {dateChanged && (
                            <div className="mt-2 flex items-start gap-2 text-caption text-feedback-warning-text">
                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span>Ši sesija persikels į kitą dieną ({derived.date}).</span>
                            </div>
                        )}
                    </div>

                    {/* Reason — a payable-time change must be justified (mirrors the legacy time edit). */}
                    <div>
                        <label htmlFor={`${fieldId}-reason`} className="mb-1 block text-caption font-medium text-ink-muted">
                            Keitimo priežastis (privaloma)
                        </label>
                        <input
                            id={`${fieldId}-reason`}
                            type="text"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="pvz. Pamiršo sustabdyti laikmatį"
                            className={inputClass}
                        />
                    </div>

                    {(liveError || error) && (
                        <div className="flex items-start gap-2 rounded-control bg-feedback-danger-soft p-3 text-body text-feedback-danger-text">
                            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                            <span>{error || liveError}</span>
                        </div>
                    )}
                </div>
            </Modal>

            {confirmingDelete && (
                <ConfirmDialog
                    open={confirmingDelete}
                    title="Ištrinti sesiją?"
                    message="Sesija bus pašalinta iš ataskaitų ir bendros sumos."
                    warning="Įrašas lieka istorijoje kaip ištrintas. Veiksmas keičia apmokamą laiką."
                    confirmLabel="Ištrinti"
                    cancelLabel="Atšaukti"
                    loading={busy}
                    onConfirm={handleDelete}
                    onCancel={() => setConfirmingDelete(false)}
                />
            )}
        </>
    );
}
