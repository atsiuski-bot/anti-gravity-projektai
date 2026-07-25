import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudOff, AlertTriangle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
    FAILED_STATUSES,
    listTimerCommandOutcomes,
    subscribeTimerCommands,
    updateTimerCommandStatus,
} from '../utils/timerOutbox';
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
                                            {command.status === 'conflicted'
                                                ? 'Būsena pakeista kitame įrenginyje, todėl šis veiksmas neįrašytas.'
                                                : 'Veiksmo nepavyko įrašyti. Laikas už šį tarpsnį neužskaitytas.'}
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
                    aria-label="Laukiantys laikmačio veiksmai"
                    className="mb-4 rounded-card border border-line bg-surface-sunken p-3"
                >
                    <p className="flex items-start gap-2 text-caption text-ink-muted">
                        <CloudOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>
                            Išsaugota telefone ir laukia ryšio ({queued.length}).
                            {' '}Laikas neprapuls — išsiųsime, kai atsiras internetas.
                        </span>
                    </p>
                </section>
            )}
        </>
    );
}
