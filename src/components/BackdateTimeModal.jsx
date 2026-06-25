import { useState, useEffect, useMemo, useId } from 'react';
import { Clock, AlertTriangle } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import DatePicker from './ui/DatePicker';
import {
    formatMinutesToTimeString,
    getLithuanianDateString,
    addDaysToDateString,
    vilniusWallClockToISO,
    MAX_BACKDATE_DAYS,
} from '../utils/timeUtils';
import { deriveSessionFields, validateBackdateWindow, logBackdatedWorkerSession } from '../utils/sessionEditActions';

// Validation-error code → Lithuanian copy. Codes come from deriveSessionFields (order/tooLong/
// invalid/reason) and validateBackdateWindow (future/tooOld) — one map so the live hint and a
// failed write read the same.
const ERROR_COPY = {
    order: 'Pabaiga turi būti vėlesnė už pradžią.',
    tooLong: 'Sesija viršija 16 val. — patikrinkite, ar teisinga data.',
    invalid: 'Neteisingas laikas.',
    reason: 'Nurodykite, ką dirbote.',
    future: 'Negalima įrašyti laiko į ateitį — įrašykite jau dirbtą laiką.',
    tooOld: `Galima įrašyti tik iki ${MAX_BACKDATE_DAYS} d. atgal.`,
    user: 'Nepavyko nustatyti meistro.',
    task: 'Nepavyko nustatyti užduoties.',
    write: 'Nepavyko išsaugoti. Bandykite dar kartą.',
};

/**
 * BackdateTimeModal — the WORKER-facing tool to self-log a missed work session on one of THEIR OWN
 * tasks, at a past time, WITHOUT manager approval. It is gated to workers an admin has granted
 * canBackdateTime; the entry applies immediately and notifies the admins (handled in the action
 * layer). Unlike the admin SessionEditModal, this only CREATES (never edits/deletes), is locked to
 * the signed-in worker, and bounds the date range to the last {@link MAX_BACKDATE_DAYS} days so an
 * approval-free entry can never fabricate weeks-old payable time.
 *
 * The credited duration and the day bucket are DERIVED from the start/end the worker types (the
 * same derivation reports read), shown live so the consequence is visible before saving. All writes
 * route through logBackdatedWorkerSession (validate → write → notify admins).
 *
 * @param {Object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {Object} props.task - the worker's own task; { id, title } are used.
 * @param {{ uid?: string, displayName?: string, email?: string }} props.worker - the signed-in worker.
 * @param {string[]} props.adminUids - active-admin recipient ids for the FYI notification.
 * @param {() => void} [props.onSaved] - called after a successful write.
 */
export default function BackdateTimeModal({ open, onClose, task, worker, adminUids, onSaved }) {
    const [startDate, setStartDate] = useState('');
    const [startTimeStr, setStartTimeStr] = useState('');
    const [endDate, setEndDate] = useState('');
    const [endTimeStr, setEndTimeStr] = useState('');
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const fieldId = useId();

    // The selectable window: today back to today − MAX_BACKDATE_DAYS, as Vilnius calendar-day
    // strings the DatePicker bounds on directly (string compare is sort-safe for YYYY-MM-DD).
    const todayStr = getLithuanianDateString();
    const minDayStr = addDaysToDateString(todayStr, -MAX_BACKDATE_DAYS);

    // Seed both dates to today each time the sheet opens; clear the rest.
    useEffect(() => {
        if (!open) return;
        setError(null);
        setReason('');
        setStartDate(todayStr);
        setEndDate(todayStr);
        setStartTimeStr('');
        setEndTimeStr('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // Recompute the derived fields (duration, day bucket) AND the window check from the typed pair.
    const { startISO, endISO, derived, windowCheck, complete } = useMemo(() => {
        const sISO = startDate && startTimeStr ? vilniusWallClockToISO(startDate, startTimeStr) : null;
        const eISO = endDate && endTimeStr ? vilniusWallClockToISO(endDate, endTimeStr) : null;
        const d = sISO && eISO ? deriveSessionFields(sISO, eISO) : null;
        return {
            startISO: sISO,
            endISO: eISO,
            complete: !!(sISO && eISO),
            derived: d,
            windowCheck: d?.ok ? validateBackdateWindow(sISO, eISO) : null,
        };
    }, [startDate, startTimeStr, endDate, endTimeStr]);

    // First failing gate wins, in evaluation order: parse/order/length, then the backdate window.
    const liveError = complete
        ? derived && !derived.ok
            ? ERROR_COPY[derived.error]
            : windowCheck && !windowCheck.ok
              ? ERROR_COPY[windowCheck.error]
              : null
        : null;

    const canSave = complete && derived?.ok && windowCheck?.ok && reason.trim().length > 0 && !busy;

    const handleSave = async () => {
        setBusy(true);
        setError(null);
        const result = await logBackdatedWorkerSession({
            task,
            worker,
            startTime: startISO,
            endTime: endISO,
            reason,
            adminUids,
        });
        setBusy(false);
        if (result.ok) {
            onSaved?.();
            onClose?.();
        } else {
            setError(ERROR_COPY[result.error] || ERROR_COPY.write);
        }
    };

    if (!open) return null;

    const inputClass =
        'min-h-touch w-full rounded-input border border-line bg-surface-card px-3 py-2 text-body-lg ' +
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

    return (
        <Modal
            open={open}
            onClose={busy ? undefined : onClose}
            dismissible={!busy}
            closeOnBackdrop={false}
            title="Įrašyti praėjusį laiką"
            size="lg"
            footer={
                <div className="flex items-center gap-2">
                    <Button variant="secondary" onClick={onClose} disabled={busy} className="ml-auto">
                        Atšaukti
                    </Button>
                    <Button variant="primary" onClick={handleSave} disabled={!canSave} loading={busy}>
                        Įrašyti
                    </Button>
                </div>
            }
        >
            <div className="space-y-4">
                <p className="text-body text-ink-muted">
                    Užduotis: <span className="font-semibold text-ink">{task?.title || 'Užduotis'}</span>
                </p>
                <p className="text-caption text-ink-muted">
                    Įrašykite laiką, kurį jau dirbote, bet pamiršote pažymėti. Galima iki {MAX_BACKDATE_DAYS} d. atgal.
                    Patvirtinimas nereikalingas — apie įrašą informuojami administratoriai.
                </p>

                {/* Start / end — date via the locale-aware picker (bounded to the window), clock via a
                    native time input. */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                        <span className="mb-1 block text-caption font-medium text-ink-muted">Pradžia</span>
                        <div className="space-y-2">
                            <DatePicker
                                id={`${fieldId}-start-date`}
                                value={startDate}
                                onChange={setStartDate}
                                min={minDayStr}
                                max={todayStr}
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
                                min={minDayStr}
                                max={todayStr}
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

                {/* Live derivation — the credited duration, recomputed as typed. */}
                <div className="rounded-control border border-line bg-surface-sunken p-3" aria-live="polite">
                    <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-body text-ink-muted">
                            <Clock className="h-4 w-4" aria-hidden="true" /> Trukmė
                        </span>
                        <span className="font-mono text-body-lg font-bold text-brand">
                            {derived?.ok ? formatMinutesToTimeString(derived.durationMinutes) : '—'}
                        </span>
                    </div>
                </div>

                {/* Reason — what was worked; a payable-time entry must be described. */}
                <div>
                    <label htmlFor={`${fieldId}-reason`} className="mb-1 block text-caption font-medium text-ink-muted">
                        Ką dirbote? (privaloma)
                    </label>
                    <input
                        id={`${fieldId}-reason`}
                        type="text"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="pvz. Pamiršau įjungti laikmatį"
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
    );
}
