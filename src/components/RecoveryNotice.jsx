import { useState, useEffect, useMemo } from 'react';
import { RotateCcw, AlertTriangle, X, Clock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { getRecoveryNotices, clearRecoveryNotices, removeRecoveryNotice, addRecoveryNotice, RECOVERY_NOTICE_EVENT } from '../utils/recoveryNotice';
import { claimRecoveredGap, discardRecoveredGap } from '../utils/sessionEditActions';
import { formatMinutesToHHMM } from '../utils/timeUtils';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import Modal from './ui/Modal';

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
 * The two kinds render DIFFERENTLY on purpose. Informational notices are a quiet warning-accent
 * banner — FYI, dismissible, skippable. But the actionable gap is real, potentially-lost PAY: as
 * an inline banner it was too easy to scroll past, so a worker kept working against a silently
 * paused timer (the "rašo neaktyvus" reports). It is therefore raised to a BLOCKING, forced-
 * acknowledge Modal (dismissible=false, no X / backdrop / Escape): the worker must decide
 * "Užskaityti" or "Nedirbau" for each gap before continuing — the same loud, two-choice pattern the
 * time-limit prompt uses. Neither surface uses the bold whole-screen session colour, which stays
 * reserved for an ACTIVE session.
 */
export default function RecoveryNotice() {
    const { currentUser } = useAuth();
    const { setActiveTab } = useNavigation();
    const uid = currentUser?.uid;

    // State, not a live read, so acting on a notice removes it without depending on a storage event.
    const [notices, setNotices] = useState([]);
    const [claimingId, setClaimingId] = useState(null); // taskId of an in-flight gap claim
    const [claimError, setClaimError] = useState(null); // taskId whose claim just failed
    // Read on mount, then RE-READ whenever a notice is written. The actionable gap notice is written
    // asynchronously (after the recovery pause resolves) — i.e. after this mount read — so a one-shot
    // read would miss it and the blocking modal would never appear this session. RECOVERY_NOTICE_EVENT
    // (fired same-tab by addRecoveryNotice) closes that race.
    useEffect(() => {
        if (!uid) { setNotices([]); return undefined; }
        const reread = () => setNotices(getRecoveryNotices(uid));
        reread();
        window.addEventListener(RECOVERY_NOTICE_EVENT, reread);
        return () => window.removeEventListener(RECOVERY_NOTICE_EVENT, reread);
    }, [uid]);

    const infoNotices = useMemo(
        () => notices.filter((n) => n.kind !== 'task-gap' && n.kind !== 'task-gap-credited'),
        [notices]
    );
    const gapNotices = useMemo(() => notices.filter((n) => n.kind === 'task-gap'), [notices]);
    // Auto-credited offline gaps (opt-out): already saved, shown once with a one-tap "Nedirbau".
    const creditedGaps = useMemo(() => notices.filter((n) => n.kind === 'task-gap-credited'), [notices]);

    // Whether the 16h clamp reduced ANY recovered interval — drives the louder "check with your
    // manager" copy and the warning-triangle glyph. A plain recovery (no cap) reads calmer.
    const anyCapped = useMemo(() => infoNotices.some((n) => n.wasCapped), [infoNotices]);

    if (!uid || notices.length === 0) return null;

    // Dismiss only the INFORMATIONAL notices; never the actionable gaps (unresolved pay). We clear
    // the store and re-persist the gaps (addRecoveryNotice dedups by kind+taskId, so this is a
    // safe rewrite) so the blocking gap modal survives a dismiss of the FYI banner and a reload.
    const dismissInfo = () => {
        const keep = [...gapNotices, ...creditedGaps];
        clearRecoveryNotices(uid);
        keep.forEach((n) => addRecoveryNotice(uid, n));
        setNotices(keep);
    };

    // Acknowledge the auto-credited gaps ("Gerai") — drop them but keep info + any blocking gaps.
    const dismissCredited = () => {
        const keep = [...infoNotices, ...gapNotices];
        clearRecoveryNotices(uid);
        keep.forEach((n) => addRecoveryNotice(uid, n));
        setNotices(keep);
    };

    // "Nedirbau" — the worker was NOT working during this auto-credited gap: hard-delete the
    // recovered session and drop its notice, leaving the rest intact.
    const discardCredited = async (n) => {
        if (!n?.sessionId || claimingId) return;
        setClaimError(null);
        setClaimingId(n.taskId);
        try {
            const res = await discardRecoveredGap({ sessionId: n.sessionId, taskId: n.taskId });
            if (res?.ok) {
                setNotices(removeRecoveryNotice(uid, { kind: 'task-gap-credited', taskId: n.taskId }));
            } else {
                setClaimError(n.taskId);
            }
        } catch {
            setClaimError(n.taskId);
        } finally {
            setClaimingId(null);
        }
    };

    // Tap-through: take the worker to where the recovered work is visible (their task list /
    // daily total), scroll to top, and clear the INFO notices — they have done their job once
    // seen. Gaps stay (they still need an explicit claim/discard).
    const review = () => {
        dismissInfo();
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
        <>
            {infoNotices.length > 0 && (
                <section
                    aria-label="Pranešimas apie atkurtą laikmatį"
                    className={`mb-4 rounded-card border border-line border-l-4 ${accent} bg-feedback-warning-soft p-4 shadow-sm`}
                >
                    <div className="flex items-start gap-3">
                        <Icon className="h-5 w-5 shrink-0 text-feedback-warning-text mt-0.5" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
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

                            <div className="mt-3 flex flex-wrap gap-2">
                                <Button variant="secondary" onClick={review}>
                                    Peržiūrėti
                                </Button>
                                <Button variant="ghost" onClick={dismissInfo}>
                                    Supratau
                                </Button>
                            </div>
                        </div>

                        <IconButton icon={X} label="Uždaryti pranešimą" variant="ghost" onClick={dismissInfo} />
                    </div>
                </section>
            )}

            {/* Auto-credited offline gaps (opt-out): the time is ALREADY saved, so this is a calm,
                dismissible banner — NOT the blocking modal — with a one-tap "Nedirbau" to remove a
                gap the worker was not actually working. */}
            {creditedGaps.length > 0 && (
                <section
                    aria-label="Užskaitytas neužfiksuotas darbo laikas"
                    className="mb-4 rounded-card border border-line border-l-4 border-l-feedback-warning-border bg-feedback-warning-soft p-4 shadow-sm"
                >
                    <div className="flex items-start gap-3">
                        <Clock className="h-5 w-5 shrink-0 text-feedback-warning-text mt-0.5" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                            <h2 className="text-body-lg font-bold text-ink-strong">
                                Užskaitytas neužfiksuotas darbo laikas
                            </h2>
                            <p className="mt-1 text-caption text-ink-muted">
                                Kol nebuvo ryšio arba programa buvo užverta, laikmatis sustojo. Šį laiką
                                užskaitėme automatiškai. Jei tuo metu nedirbote — pašalinkite.
                            </p>

                            <ul className="mt-2 space-y-2">
                                {creditedGaps.map((n) => (
                                    <li key={`credited-${n.taskId}`} className="text-body text-ink">
                                        <div>
                                            <span className="font-mono font-semibold text-ink-strong">
                                                {formatMinutesToHHMM(n.gapMinutes)}
                                            </span>
                                            {n.taskTitle && <span className="text-ink-muted"> · {n.taskTitle}</span>}
                                        </div>
                                        {claimError === n.taskId && (
                                            <p className="mt-1 text-caption text-feedback-danger-text">
                                                Nepavyko pašalinti. Bandykite dar kartą.
                                            </p>
                                        )}
                                        <div className="mt-1">
                                            <Button
                                                variant="ghost"
                                                onClick={() => discardCredited(n)}
                                                disabled={claimingId === n.taskId}
                                            >
                                                {claimingId === n.taskId ? 'Šalinama…' : 'Nedirbau — pašalinti'}
                                            </Button>
                                        </div>
                                    </li>
                                ))}
                            </ul>

                            <div className="mt-3">
                                <Button variant="secondary" onClick={dismissCredited}>
                                    Gerai
                                </Button>
                            </div>
                        </div>

                        <IconButton icon={X} label="Uždaryti pranešimą" variant="ghost" onClick={dismissCredited} />
                    </div>
                </section>
            )}

            {/* Actionable gaps → a BLOCKING, forced-acknowledge modal (no X / backdrop / Escape) so
                real potentially-lost pay cannot be scrolled past. Each gap must be claimed or
                discarded; the modal closes only once none remain. */}
            <Modal
                open={gapNotices.length > 0}
                onClose={() => {}}
                dismissible={false}
                title="Neužfiksuotas darbo laikas"
                size="md"
            >
                <p className="mb-3 flex items-start gap-2 text-body text-ink">
                    <Clock className="mt-0.5 h-5 w-5 shrink-0 text-feedback-warning-text" aria-hidden="true" />
                    <span>
                        Po to, kai dingo ryšys ar užsidarė programa, laikmatis sustojo. Jei tuo metu
                        dirbote — užskaitykite laiką; jei ne — atmeskite.
                    </span>
                </p>

                <ul className="space-y-3">
                    {gapNotices.map((n) => (
                        <li key={`gap-${n.taskId}`} className="rounded-control border border-line bg-surface-sunken p-3 text-body text-ink">
                            <div>
                                <span className="font-mono font-semibold text-ink-strong">
                                    {formatMinutesToHHMM(n.gapMinutes)}
                                </span>
                                {n.taskTitle && <span className="text-ink-muted"> · {n.taskTitle}</span>}
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
            </Modal>
        </>
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
