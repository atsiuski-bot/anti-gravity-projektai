import { useMemo, useState } from 'react';
import { AlarmClock, CalendarDays, CalendarPlus, ChevronRight, Sunrise } from 'lucide-react';
import { cn } from '../../utils/cn';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import DatePicker from '../ui/DatePicker';
import { useSnoozeActions } from '../../hooks/useSnoozeActions';
import {
    SNOOZE_REASONS,
    SNOOZE_RETURN_TIME,
    getSnoozePresets,
    getSnoozeMinDate,
    snoozeUntilForDate,
    formatSnoozeUntil,
    snoozePassesDeadline,
} from '../../utils/taskSnooze';

const PRESET_ICON = { 'next-work-day': Sunrise, monday: CalendarDays, week: CalendarPlus };

/**
 * SnoozeSheet — "Atidėti iki": pick when a task comes back. Opened by the card's swipe-left, the
 * detail sheet's "Atidėti" button, or the desktop row's detail sheet.
 *
 * One tap on a preset commits (Gmail-style) — the toast's "Atšaukti" is the safety net — so the
 * optional reason chips sit ABOVE the presets and are chosen first. A preset that would return
 * after the task's deadline says so in warning text, but stays allowed (ADR 0033).
 */
export default function SnoozeSheet({ task, onClose }) {
    const { snooze } = useSnoozeActions();
    const [reason, setReason] = useState(null);
    const [customOpen, setCustomOpen] = useState(false);
    const [customDate, setCustomDate] = useState('');
    const presets = useMemo(() => getSnoozePresets(), []);
    const minDate = useMemo(() => getSnoozeMinDate(), []);

    if (!task) return null;

    const commit = (untilIso) => {
        onClose();
        snooze(task, untilIso, reason);
    };

    const customUntil = customDate ? snoozeUntilForDate(customDate) : null;

    return (
        <Modal open onClose={onClose} title="Atidėti iki" size="sm">
            <p className="-mt-1 mb-4 break-words text-caption text-ink-muted">{task.title}</p>

            <fieldset className="mb-4">
                <legend className="mb-2 text-caption font-medium text-ink-muted">Priežastis (nebūtina)</legend>
                <div className="flex flex-wrap gap-2">
                    {SNOOZE_REASONS.map((r) => {
                        const on = reason === r;
                        return (
                            <button
                                key={r}
                                type="button"
                                aria-pressed={on}
                                onClick={() => setReason(on ? null : r)}
                                className={cn(
                                    'inline-flex min-h-touch items-center rounded-full border px-3 text-body font-medium transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring focus-visible:ring-offset-1',
                                    on
                                        ? 'border-brand bg-brand text-white'
                                        : 'border-line bg-surface-card text-ink hover:bg-surface-sunken',
                                )}
                            >
                                {r}
                            </button>
                        );
                    })}
                </div>
            </fieldset>

            <div className="flex flex-col gap-2">
                {presets.map((p) => {
                    const Icon = PRESET_ICON[p.key] || AlarmClock;
                    const late = snoozePassesDeadline(task, p.until);
                    return (
                        <button
                            key={p.key}
                            type="button"
                            onClick={() => commit(p.until)}
                            className="flex min-h-touch w-full items-center gap-3 rounded-control border border-line bg-surface-card px-3 py-2 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring"
                        >
                            <Icon className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                            <span className="flex-1 text-body font-semibold text-ink-strong">{p.label}</span>
                            <span className="flex flex-col items-end text-caption">
                                <span className="text-ink-muted">{formatSnoozeUntil(p.until)}</span>
                                {late && <span className="font-semibold text-feedback-warning-text">Po termino</span>}
                            </span>
                        </button>
                    );
                })}

                {!customOpen ? (
                    <button
                        type="button"
                        onClick={() => setCustomOpen(true)}
                        aria-expanded={false}
                        className="flex min-h-touch w-full items-center gap-3 rounded-control border border-line bg-surface-card px-3 py-2 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring"
                    >
                        <AlarmClock className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                        <span className="flex-1 text-body font-semibold text-ink-strong">Pasirinkti datą…</span>
                        <ChevronRight className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                    </button>
                ) : (
                    <div className="rounded-control border border-line p-3">
                        <label htmlFor="snooze-custom-date" className="mb-2 block text-caption font-medium text-ink-muted">
                            Grįš pasirinktą dieną {SNOOZE_RETURN_TIME}
                        </label>
                        <DatePicker
                            id="snooze-custom-date"
                            value={customDate}
                            onChange={setCustomDate}
                            min={minDate}
                            placeholder="Pasirinkite dieną"
                            className="w-full"
                        />
                        {customUntil && snoozePassesDeadline(task, customUntil) && (
                            <p className="mt-2 text-caption font-semibold text-feedback-warning-text">
                                Ši diena yra po veiklos termino.
                            </p>
                        )}
                        <Button
                            variant="primary"
                            size="md"
                            icon={AlarmClock}
                            className="mt-3 w-full"
                            disabled={!customUntil}
                            onClick={() => customUntil && commit(customUntil)}
                        >
                            {customUntil ? `Atidėti iki ${formatSnoozeUntil(customUntil)}` : 'Atidėti'}
                        </Button>
                    </div>
                )}
            </div>
        </Modal>
    );
}
