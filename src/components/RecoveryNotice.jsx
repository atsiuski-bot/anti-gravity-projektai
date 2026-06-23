import { useState, useEffect, useMemo } from 'react';
import { RotateCcw, AlertTriangle, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { getRecoveryNotices, clearRecoveryNotices } from '../utils/recoveryNotice';
import { formatMinutesToHHMM } from '../utils/timeUtils';
import Button from './ui/Button';
import IconButton from './ui/IconButton';

/**
 * One-time "your timer was recovered" banner.
 *
 * The crash/cap recovery hooks (useOrphanedSessionRecovery / useOrphanedTaskRecovery) close a
 * timer left running across a restart and SILENTLY clamp the credited duration to 16h. That
 * silence is the problem: a capped/recovered interval later looks like "unexplained hours" with
 * nothing telling the worker it was auto-corrected. Those hooks now stamp a one-time notice
 * (utils/recoveryNotice); this banner surfaces it once, on the next open, then clears it.
 *
 * It mirrors QuickWorkDescribePrompt's calm pattern: the bold whole-screen session colour is
 * reserved for an ACTIVE session, so a recovered/closed timer is a quiet card with a warning
 * accent strip + icon — never the red shell. When the 16h cap actually fired, the wording says
 * so plainly and points the worker at their manager, because that is the case most likely to
 * need a correction.
 */
export default function RecoveryNotice() {
    const { currentUser } = useAuth();
    const { setActiveTab } = useNavigation();
    const uid = currentUser?.uid;

    // Read once per mount (the store is written before this renders). State, not a live read, so
    // dismissing removes the banner without depending on a storage event.
    const [notices, setNotices] = useState([]);
    useEffect(() => {
        if (!uid) { setNotices([]); return; }
        setNotices(getRecoveryNotices(uid));
    }, [uid]);

    // Whether the 16h clamp reduced ANY recovered interval — drives the louder "check with your
    // manager" copy and the warning-triangle glyph. A plain recovery (no cap) reads calmer.
    const anyCapped = useMemo(() => notices.some((n) => n.wasCapped), [notices]);

    if (!uid || notices.length === 0) return null;

    const dismiss = () => {
        clearRecoveryNotices(uid);
        setNotices([]);
    };

    // Tap-through: take the worker to where the recovered work is visible (their task list /
    // daily total), scroll to top, and clear the notice — it has done its job once acted on.
    const review = () => {
        clearRecoveryNotices(uid);
        setNotices([]);
        setActiveTab('tasks');
        window.scrollTo({ top: 0 });
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
                    <h2 className="text-body-lg font-bold text-ink-strong">
                        {anyCapped ? 'Laikmatis atkurtas ir apribotas' : 'Laikmatis atkurtas'}
                    </h2>

                    <ul className="mt-2 space-y-1.5">
                        {notices.map((n, i) => (
                            <li key={i} className="text-body text-ink">
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
                            ? 'Laikmatis liko įjungtas po programos uždarymo, todėl užfiksuotas laikas buvo apribotas iki 16 val. Jei tai neteisinga, praneškite vadovui.'
                            : 'Laikmatis liko įjungtas po programos uždarymo ir buvo automatiškai sustabdytas. Jei užfiksuotas laikas neteisingas, praneškite vadovui.'}
                    </p>

                    <div className="mt-3 flex flex-wrap gap-2">
                        <Button variant="secondary" onClick={review}>
                            Peržiūrėti
                        </Button>
                        <Button variant="ghost" onClick={dismiss}>
                            Supratau
                        </Button>
                    </div>
                </div>

                <IconButton icon={X} label="Uždaryti pranešimą" variant="ghost" onClick={dismiss} />
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
            return 'Greitas darbas — užfiksuota';
        default:
            return 'Sesija — užfiksuota';
    }
}
