import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudOff, AlertTriangle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { hasPersistentCache } from '../firebase';
import {
    FAILED_STATUSES,
    describeTimerCommand,
    listTimerCommandOutcomes,
    subscribeTimerCommands,
    updateTimerCommandStatus,
} from '../utils/timerOutbox';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { logError } from '../utils/errorLog';
import Button from './ui/Button';

// What each timer command actually DID, in the worker's words. The outbox has always recorded these
// states; until now nothing showed them, so an offline start or stop that was later rejected simply
// looked like it had worked.
const KIND_LABELS = {
    'start-task': 'Darbo pradžia',
    'resume-task': 'Darbo tęsimas',
    'pause-task': 'Darbo pristabdymas',
    'end-task': 'Darbo užbaigimas',
    'start-break': 'Pertraukos pradžia',
    'start-call': 'Skambučio pradžia',
    'start-quick-work': 'Greitos veiklos pradžia',
    'end-session': 'Veiklos pabaiga',
    'force-end-session': 'Vadovo užbaigimas',
    'switch-session': 'Veiklos perjungimas',
    recover: 'Laikmačio atkūrimas',
    'undo-recovery': 'Atkūrimo atšaukimas',
};

const kindLabel = (kind) => KIND_LABELS[kind] || 'Laikmačio veiksmas';

// Commands that only OPEN a run. A rejected one lost no time — the timer simply never started, and
// telling the worker their time was not credited sends them hunting for minutes that never existed.
// Everything else CLOSES a run, where "this stretch was not credited" is the accurate warning.
const OPENING_KINDS = new Set([
    'start-task', 'resume-task', 'start-break', 'start-call', 'start-quick-work',
]);

// `conflicted` is the opposite of lost work: another device already recorded the change, so the
// state on screen is the newest one. Only a genuine `rejected` means nothing happened at all.
const failureCopy = (command) => {
    if (command.status === 'conflicted') {
        return 'Būsena pakeista kitame įrenginyje, todėl šis veiksmas neįrašytas.';
    }
    return OPENING_KINDS.has(command.kind)
        ? 'Veiksmo nepavyko įrašyti — laikmatis nebuvo paleistas. Pradėkite iš naujo.'
        : 'Veiksmo nepavyko įrašyti. Laikas už šį tarpsnį neužskaitytas.';
};

// Vilnius wall-clock HH:MM — the worker reads these next to their own shift, so the day boundary and
// the zone must match every other time in the app, not the device's locale.
const clock = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('lt-LT', {
        timeZone: 'Europe/Vilnius', hour: '2-digit', minute: '2-digit',
    }).format(d);
};

// The concrete, reportable facts about the stretch that did NOT get credited: which task, which
// interval, how long. Without them the worker is told time is missing but not which time — they
// cannot reconstruct the shift, and a coordinator has nothing to correct from.
const FailureDetail = ({ command }) => {
    const d = describeTimerCommand(command);
    const from = clock(d.startTime);
    const to = clock(d.endTime);
    const issued = clock(d.issuedAt);
    // An interval is only meaningful with both ends; otherwise fall back to when the worker acted.
    const span = from && to ? `${from}–${to}` : null;
    const rows = [
        d.taskTitle && ['Veikla', d.taskTitle],
        span && ['Laikotarpis', span],
        d.durationMinutes && ['Trukmė', formatMinutesToTimeString(d.durationMinutes)],
        !span && issued && ['Veiksmo laikas', issued],
    ].filter(Boolean);

    if (!rows.length) return null;
    return (
        <dl className="mt-1 space-y-0.5 text-caption text-ink">
            {rows.map(([label, value]) => (
                <div key={label} className="flex gap-1.5">
                    <dt className="text-ink-muted">{label}:</dt>
                    <dd className="min-w-0 font-medium break-words">{value}</dd>
                </div>
            ))}
        </dl>
    );
};

/**
 * Global, reload-surviving status for timer commands issued through the revisioned engine.
 *
 * Why it must be global and IndexedDB-backed: a command's outcome can arrive long after the
 * component that issued it unmounted — on reconnect, or on the next boot's replay. Component-local
 * state cannot represent that, so a worker who started or stopped a timer offline was never told
 * when reconnection REJECTED the command or found a CONFLICT from another device. They kept working
 * against a timer that was not running.
 *
 * Two tones, deliberately different:
 *   • unsettled (queued) — calm and informational: the action IS saved on the device and will sync.
 *   • rejected / conflicted — a warning that must be acknowledged, because the action did NOT happen
 *     and the worker has to redo it or talk to their manager.
 */
export default function TimerSyncNotice() {
    const { currentUser, timerEngineEnabled } = useAuth();
    const uid = currentUser?.uid;
    const [commands, setCommands] = useState([]);

    const reload = useCallback(() => {
        if (!uid) { setCommands([]); return; }
        listTimerCommandOutcomes(uid)
            .then(setCommands)
            .catch((error) => logError(error, { source: 'TimerSyncNotice.list', userId: uid }));
    }, [uid]);

    useEffect(() => {
        if (!uid || !timerEngineEnabled) { setCommands([]); return undefined; }
        reload();
        // Same-tab updates (a settlement landing, a boot replay resolving) push straight through.
        return subscribeTimerCommands(reload);
    }, [uid, timerEngineEnabled, reload]);

    const failed = useMemo(
        () => commands.filter((c) => FAILED_STATUSES.includes(c.status)),
        [commands]
    );
    const queued = useMemo(
        () => commands.filter((c) => c.status === 'queued'),
        [commands]
    );

    const acknowledge = async (command) => {
        try {
            await updateTimerCommandStatus(command.commandId, 'acknowledged');
        } catch (error) {
            logError(error, { source: 'TimerSyncNotice.acknowledge', commandId: command.commandId });
        }
    };

    if (!uid || (!failed.length && !queued.length)) return null;

    return (
        <>
            {failed.length > 0 && (
                <section
                    // An aria-label NAMES an element; it does not announce that the element appeared.
                    // This surface exists precisely because it shows up long after the action — on
                    // reconnect or a later boot — so a screen-reader user would otherwise never learn
                    // their timer action was refused. role="alert" (assertive) is right here and only
                    // here: paid time was lost and the worker must redo it or report it.
                    role="alert"
                    aria-label="Neįvykę laikmačio veiksmai"
                    className="mb-4 rounded-card border border-line bg-feedback-danger-soft p-4 shadow-sm"
                >
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-feedback-danger-text" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                            <h2 className="text-body-lg font-bold text-ink-strong">
                                Kai kurie laikmačio veiksmai neįvyko
                            </h2>
                            <ul className="mt-2 space-y-3">
                                {failed.map((command) => (
                                    <li key={command.commandId} className="text-body text-ink">
                                        <div className="font-medium text-ink-strong">{kindLabel(command.kind)}</div>
                                        <p className="text-caption text-ink-muted">
                                            {failureCopy(command)}
                                        </p>
                                        <FailureDetail command={command} />
                                        <p className="mt-1 text-caption text-ink-muted">
                                            Praneškite šiuos duomenis savo vadovui, kad laikas būtų pataisytas.
                                        </p>
                                        <div className="mt-1">
                                            <Button variant="secondary" onClick={() => acknowledge(command)}>
                                                Supratau
                                            </Button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </section>
            )}

            {queued.length > 0 && (
                <section
                    // Polite, not assertive: queued work is normal field operation, so it is
                    // announced without interrupting whatever the worker is doing.
                    role="status"
                    aria-live="polite"
                    aria-label="Laukiantys laikmačio veiksmai"
                    className="mb-4 rounded-card border border-line bg-surface-sunken p-3"
                >
                    <p className="flex items-start gap-2 text-caption text-ink-muted">
                        <CloudOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        {/* "Saved on this device" and "credited by the server" are DIFFERENT claims,
                            and the old copy made the second one ("laikas neprapuls") while only the
                            first was true. A queued command can still be refused on arrival — a stale
                            replay past the 16h window, or a revision another device already moved —
                            so promising the time is safe sends a worker on believing pay is secured.
                            Say what is actually known: it is stored and waiting. And when the memory
                            fallback is in play, not even that holds — closing the app drops it. */}
                        <span>
                            {hasPersistentCache
                                ? `Išsaugota telefone ir laukia ryšio (${queued.length}). Išsiųsime, kai atsiras internetas, ir pranešime, jei nepavyktų.`
                                : `Laukia ryšio (${queued.length}). DĖMESIO: šiame įrenginyje neveikia atmintis neprisijungus — neuždarykite programos, kol neatsiras internetas, kitaip veiksmas dings.`}
                        </span>
                    </p>
                </section>
            )}
        </>
    );
}
