import { useState, useEffect, useMemo } from 'react';
import { RotateCcw, AlertTriangle, X, Clock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { getRecoveryNotices, clearRecoveryNotices, removeRecoveryNotice } from '../utils/recoveryNotice';
import { claimRecoveredGap } from '../utils/sessionEditActions';
import { formatMinutesToHHMM } from '../utils/timeUtils';
import Button from './ui/Button';
import IconButton from './ui/IconButton';

/**
 * One-time recovery banner shown on the next app open after the crash/reload recovery ran.
 *
 * Two kinds of notice land here:
 *  • Informational ('task' / 'session') — a timer left running across a restart was auto-closed
 *    (clamped to 16h if needed). This surfaces the credited duration once so a recovered/capped
 *    interval never later reads as "unexplained hours".
 *  • Actionable ('task-gap') — a heartbeat-recovered timer had a real untracked gap (the worker
 *    kept working offline after the app was killed). The credited-up-to-last-beat part is already
 *    saved; this offers a one-tap claim for the remaining minutes so genuine offline work isn't
 *    silently lost — or a one-tap "I wasn't working" to discard it.
 *
 * It mirrors QuickWorkDescribePrompt's calm pattern: the bold whole-screen session colour is
 * reserved for an ACTIVE session, so a recovered/closed timer is a quiet card with a warning
 * accent strip + icon — never the red shell.
 */
export default function RecoveryNotice() {
    const { currentUser } = useAuth();
    const { setActiveTab } = useNavigation();
    const uid = currentUser?.uid;

    // Read once per mount (the store is written before this renders). State, not a live read, so
    // acting on a notice removes it without depending on a storage event.
    const [notices, setNotices] = useState([]);
    const [claimingId, setClaimingId] = useState(null); // taskId of an in-flight gap claim
    const [claimError, setClaimError] = useState(null); // taskId whose claim just failed
    useEffect(() => {
        if (!uid) { setNotices([]); return; }
        setNotices(getRecoveryNotices(uid));
    }, [uid]);

    const infoNotices = useMemo(() => notices.filter((n) => n.kind !== 'task-gap'), [notices]);
    const gapNotices = useMemo(() => notices.filter((n) => n.kind === 'task-gap'), [notices]);

    // Whether the 16h clamp reduced ANY recovered interval — drives the louder "check with your
    // manager" copy and the warning-triangle glyph. A plain recovery (no cap) reads calmer.
    const anyCapped = useMemo(() => infoNotices.some((n) => n.wasCapped), [infoNotices]);

    if (!uid || notices.length === 0) return null;

    const dismissAll = () => {
        clearRecoveryNotices(uid);
        setNotices([]);
    };

    // Tap-through: take the worker to where the recovered work is visible (their task list /
    // daily total), scroll to top, and clear the notices — they have done their job once acted on.
    const review = () => {
        clearRecoveryNotices(uid);
        setNotices([]);
        setActiveTab('tasks');
        window.scrollTo({ top: 0 });
    };

    const dropGap = (taskId) => {
        const remaining = removeRecoveryNotice(uid, { kind: 'task-gap', taskId });
        setNotices(remaining);
    };

    const claimGap = async (n) => {
        if (!n?.taskId || claimingId) return;
        setClaimError(null);
        setClaimingId(n.taskId);
        try {
            const res = await claimRecoveredGap({
                task: { id: n.taskId, title: n.taskTitle },
                worker: currentUser,
                startTime: n.fromIso,
                endTime: n.toIso,
            });
            if (res?.ok) {
                dropGap(n.taskId);
            } else {
                setClaimError(n.taskId);
            }
        } catch {
            setClaimError(n.taskId);
        } finally {
            setClaimingId(null);
        }
    };

    const Icon = anyCapped ? AlertTriangle : RotateCcw;
    const accent = anyCapped ? 'border-l-feedback-warning' : 'border-l-feedback-warning-border';

    return (
        <section
            aria-label="Pranešimas apie atkurtą laikmatį"
            className={`mb-4 rounded-card border border-line border-l-4 ${accent} bg-feedback-warning-soft p-4 shadow-sm`}
        >
            <div className="flex items-start gap-3">
                <Icon className="h-5 w-5 shrink-0 text-feedback-warning-text mt-0.5" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    {infoNotices.length > 0 && (
                        <>
                            <h2 className="text-body-lg font-bold text-ink-strong">
                                {anyCapped ? 'Laikmatis atkurtas ir apribotas' : 'Laikmatis atkurtas'}
                            </h2>

                            <ul className="mt-2 space-y-1.5">
                                {infoNotices.map((n, i) => (
                                    <li key={`info-${i}`} className="text-body text-ink">
                                        {labelFor(n)}{' '}
                                        <span className="font-mono font-semibold text-ink-strong">
                                            {formatMinutesToHHMM(n.minutes)}
                                        </span>
                                        {n.wasCapped && (
                                            <span className="text-feedback-warning-text">
                                                {' '}— pasiektas 16 val. apribojimas
                                            </span>
                                        )}
                                        {n.kind === 'task' && n.taskTitle && (
                                            <span className="text-ink-muted"> · {n.taskTitle}</span>
                                        )}
                                    </li>
                                ))}
                            </ul>

                            <p className="mt-2 text-caption text-ink-muted">
                                {anyCapped
                                    ? 'Laikmatis liko įjungtas po programos uždarymo, todėl užfiksuotas laikas buvo apribotas iki 16 val. Jei tai neteisinga, praneškite koordinatoriui.'
                                    : 'Laikmatis liko įjungtas po programos uždarymo ir buvo automatiškai sustabdytas. Jei užfiksuotas laikas neteisingas, praneškite koordinatoriui.'}
                            </p>
                        </>
                    )}

                    {gapNotices.length > 0 && (
                        <div className={infoNotices.length > 0 ? 'mt-4 border-t border-line pt-3' : ''}>
                            <h2 className="flex items-center gap-2 text-body-lg font-bold text-ink-strong">
                                <Clock className="h-4 w-4 text-feedback-warning-text" aria-hidden="true" />
                                Neužfiksuotas darbo laikas
                            </h2>
                            <p className="mt-1 text-caption text-ink-muted">
                                Po to, kai dingo ryšys ar programa užsidarė, laikmatis sustojo. Jei tuo
                                metu dirbote, užskaitykite laiką; jei ne — atmeskite.
                            </p>

                            <ul className="mt-2 space-y-3">
                                {gapNotices.map((n) => (
                                    <li key={`gap-${n.taskId}`} className="text-body text-ink">
                                        <div>
                                            <span className="font-mono font-semibold text-ink-strong">
                                                {formatMinutesToHHMM(n.gapMinutes)}
                                            </span>
                                            {n.taskTitle && (
                                                <span className="text-ink-muted"> · {n.taskTitle}</span>
                                            )}
                                        </div>
                                        {claimError === n.taskId && (
                                            <p className="mt-1 text-caption text-feedback-danger-text">
                                                Nepavyko užskaityti. Bandykite dar kartą.
                                            </p>
                                        )}
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            <Button
                                                variant="primary"
                                                onClick={() => claimGap(n)}
                                                disabled={claimingId === n.taskId}
                                            >
                                                {claimingId === n.taskId
                                                    ? 'Užskaitoma…'
                                                    : `Užskaityti ${formatMinutesToHHMM(n.gapMinutes)}`}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                onClick={() => dropGap(n.taskId)}
                                                disabled={claimingId === n.taskId}
                                            >
                                                Nedirbau
                                            </Button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {infoNotices.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                            <Button variant="secondary" onClick={review}>
                                Peržiūrėti
                            </Button>
                            <Button variant="ghost" onClick={dismissAll}>
                                Supratau
                            </Button>
                        </div>
                    )}
                </div>

                <IconButton icon={X} label="Uždaryti pranešimą" variant="ghost" onClick={dismissAll} />
            </div>
        </section>
    );
}

// Per-row lead-in: name what was recovered (a task vs. a break/call/quick-work session) so the
// number that follows reads unambiguously.
function labelFor(n) {
    if (n.kind === 'task') return 'Užduoties laikmatis — užfiksuota';
    switch (n.sessionType) {
        case 'break':
            return 'Pertrauka — užfiksuota';
        case 'call':
            return 'Skambutis — užfiksuota';
        case 'quickWork':
            return 'Greita veikla — užfiksuota';
        default:
            return 'Sesija — užfiksuota';
    }
}
