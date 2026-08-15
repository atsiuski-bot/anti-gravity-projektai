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

// How long a command may sit unsettled before the worker is told it is waiting.
//
// EVERY timer action goes through the outbox: it is written as `queued`, then settled by the
// Firestore batch a few hundred milliseconds later. Announcing the queue immediately meant every
// ordinary online tap on Pradėti/Pristabdyti flashed a "waiting for connection" banner for that
// fraction of a second — and, because the banner was a block in the content flow, the whole feed
// jumped down and back as it came and went. Nothing was wrong; the worker was watching the app
// talk to itself. A round trip that has NOT completed within this window is a genuinely different
// event — a dead or crawling connection — and that is the only one worth a word.
const QUEUED_GRACE_MS = 5000;

const queuedAgeMs = (command, nowMs) => {
    const stamped = Date.parse(command?.updatedAt || command?.issuedAt || '');
    // An unparseable stamp must not hide the notice forever — treat it as already ripe.
    return Number.isFinite(stamped) ? nowMs - stamped : Number.POSITIVE_INFINITY;
};

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

    // `now` exists so the grace window can EXPIRE without anything else happening: a command that
    // stays queued emits no further outbox event, so without a timer the notice would never appear
    // for the offline worker it is actually for. One timeout, armed for the moment the oldest
    // still-young command ripens — not a polling interval.
    const [now, setNow] = useState(() => Date.now());
    const unsettled = useMemo(
        () => queued.filter((c) => queuedAgeMs(c, now) >= QUEUED_GRACE_MS),
        [queued, now]
    );

    useEffect(() => {
        const waits = queued
            .map((c) => QUEUED_GRACE_MS - queuedAgeMs(c, Date.now()))
            .filter((ms) => ms > 0);
        if (!waits.length) return undefined;
        const timer = setTimeout(() => setNow(Date.now()), Math.min(...waits));
        return () => clearTimeout(timer);
    }, [queued, now]);

    const acknowledge = async (command) => {
        try {
            await updateTimerCommandStatus(command.commandId, 'acknowledged');
        } catch (error) {
            logError(error, { source: 'TimerSyncNotice.acknowledge', commandId: command.commandId });
        }
    };

    if (!uid || (!failed.length && !unsettled.length)) return null;

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

            {unsettled.length > 0 && (
                <div
                    // Pinned OVER the page, never inserted into it. As a block in the content flow
                    // this pushed every card below it down the moment it appeared and back up when
                    // it went — the feed visibly jolting under the worker's thumb for the length of
                    // one round trip. An overlay says the same thing and moves nothing. It clears
                    // the bottom dock on mobile (navclear, the token that exists for exactly this)
                    // and sits low on desktop, where the dock is a side rail instead. Pointer
                    // events pass through: it must never swallow a tap meant for the card beneath.
                    className="pointer-events-none fixed inset-x-0 bottom-0 z-toast px-4 pb-navclear lg:pb-6"
                >
                <section
                    // Polite, not assertive: queued work is normal field operation, so it is
                    // announced without interrupting whatever the worker is doing.
                    role="status"
                    aria-live="polite"
                    aria-label="Laukiantys laikmačio veiksmai"
                    className="mx-auto max-w-3xl rounded-card border border-line bg-surface-card p-3 shadow-lg"
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
                                ? `Išsaugota telefone ir laukia ryšio (${unsettled.length}). Išsiųsime, kai atsiras internetas, ir pranešime, jei nepavyktų.`
                                : `Laukia ryšio (${unsettled.length}). DĖMESIO: šiame įrenginyje neveikia atmintis neprisijungus — neuždarykite programos, kol neatsiras internetas, kitaip veiksmas dings.`}
                        </span>
                    </p>
                </section>
                </div>
            )}
        </>
    );
}
