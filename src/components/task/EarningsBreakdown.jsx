import { useState, useEffect } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';
import { useAuth } from '../../context/AuthContext';
import { getLithuanianDateString, sanitizeReportMinutes } from '../../utils/timeUtils';
import { hasPayRate, marginalNetEarnings, netToGross, getPayRateTiers, getPayRateLabel } from '../../utils/payRate';
import { formatEur, formatEurPerHour } from '../../utils/formatters';
import { logError } from '../../utils/errorLog';

/**
 * EarningsBreakdown — what one finished task earned: the GROSS (with-tax) amount first, the NET
 * (take-home) beside it. Extracted from the old standalone EarningsModal so it can sit as ONE
 * SECTION of the finish summary rather than being a second pop-up in a chain.
 *
 * It is deliberately the LAST block on that card, and carries no comparison, no colour-coded
 * verdict and no link to the time spent above it. WORKZ pays by the hour, so a fast finish earns
 * LESS — putting the money next to a "you were quick" verdict would read as celebrating a smaller
 * payslip. The two facts share a screen; they must never share a sentence.
 *
 * Tiers are MARGINAL on the worker's CUMULATIVE monthly hours, so this task's value is the slice it
 * adds on top of the month's already-worked hours: we sum the month's work_sessions (tasks +
 * quick-work + calls; breaks live in a separate collection, so they are naturally excluded), drop
 * this task's own segments to avoid double counting, then stack this task's full total on top.
 */
const formatHours = (h) =>
    `${h.toLocaleString('lt-LT', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} val.`;

export default function EarningsBreakdown({ task, totalMinutes }) {
    const { currentUser, userData } = useAuth();
    const [priorMinutes, setPriorMinutes] = useState(null); // null = still loading
    const [loadFailed, setLoadFailed] = useState(false);    // month read failed — refuse to quote a sum
    const payRate = userData?.payRate;

    useEffect(() => {
        if (!currentUser?.uid) return undefined;
        let cancelled = false;
        setPriorMinutes(null);
        setLoadFailed(false);
        (async () => {
            try {
                // Pin the OWNER, not just the date. The work_sessions read rule grants a worker only
                // rows where `userId == uid`, and Firestore evaluates a LIST query against its
                // POTENTIAL result set — so a date-only query is denied WHOLESALE (permission-denied)
                // as soon as any colleague has a session this month, rather than being filtered. That
                // silently zeroed the month's prior hours and re-priced every task from the LOWEST
                // tier. The (userId, date) composite index for this shape already exists.
                // The just-finished session is excluded by taskId, so its eventual-consistency delay
                // never under/over-counts the month.
                const monthStart = `${getLithuanianDateString().slice(0, 7)}-01`;
                const snap = await getDocs(query(
                    collection(db, 'work_sessions'),
                    where('userId', '==', currentUser.uid),
                    where('date', '>=', monthStart),
                ));
                let sum = 0;
                snap.forEach((d) => {
                    const data = d.data();
                    if (data.isDeleted) return;                        // voided sessions don't count
                    if (task?.id && data.taskId === task.id) return;   // this task's own segments
                    sum += sanitizeReportMinutes(data.durationMinutes);
                });
                if (!cancelled) setPriorMinutes(sum);
            } catch (e) {
                logError(e, { source: 'EarningsBreakdown.monthHours', userId: currentUser?.uid });
                // Fail CLOSED: without the month's prior hours the marginal tier is unknown, and the
                // old fallback (prior = 0) quoted a confidently WRONG amount. Say nothing instead.
                if (!cancelled) setLoadFailed(true);
            }
        })();
        return () => { cancelled = true; };
    }, [currentUser?.uid, task?.id]);

    const taskHours = Math.max(0, (Number(totalMinutes) || 0) / 60);
    const loading = priorMinutes === null && !loadFailed;
    const priorHours = (priorMinutes || 0) / 60;
    // Bill by the tariff the manager chose for THIS task (task.payRateId); falls back to the
    // worker's default tariff when the task carries none — so old tasks and single-rate workers
    // compute exactly as before.
    const rateTiers = getPayRateTiers(payRate, task?.payRateId);
    const rateLabel = getPayRateLabel(payRate, task?.payRateId);
    const netEarnings = marginalNetEarnings(priorHours, priorHours + taskHours, rateTiers);
    const grossEarnings = netToGross(netEarnings);

    if (!hasPayRate(payRate)) return null;

    if (loading) {
        return <p className="py-4 text-center text-body text-ink-muted">Skaičiuojamas uždarbis…</p>;
    }

    if (loadFailed) {
        return (
            <p role="alert" className="text-body font-medium text-feedback-danger-text">
                Nepavyko suskaičiuoti šio mėnesio valandų, todėl uždarbio nerodome — suma būtų
                neteisinga. Bandykite vėliau arba pasitikslinkite pas vadovą.
            </p>
        );
    }

    return (
        <div className="space-y-3">
            {rateLabel && (
                <p className="text-caption text-ink-muted">Tarifas: {rateLabel} · {formatHours(taskHours)}</p>
            )}

            <div className="grid grid-cols-2 gap-2">
                <div className="rounded-card border border-line bg-surface-sunken/40 p-3 text-center">
                    <span className="block text-caption font-medium uppercase tracking-wide text-ink-muted">
                        Su mokesčiais
                    </span>
                    <span className="mt-1 block text-h3 font-bold tabular-nums text-ink-strong">
                        {formatEur(grossEarnings)}
                    </span>
                </div>
                <div className="rounded-card border border-line bg-surface-card p-3 text-center">
                    <span className="block text-caption font-medium uppercase tracking-wide text-ink-muted">
                        Į rankas
                    </span>
                    <span className="mt-1 block text-h3 font-bold tabular-nums text-feedback-success-text">
                        {formatEur(netEarnings)}
                    </span>
                </div>
            </div>

            <p className="text-caption text-ink-muted">
                Įkainis: {formatEurPerHour(taskHours > 0 ? grossEarnings / taskHours : 0)} su mokesčiais ·{' '}
                {formatEurPerHour(taskHours > 0 ? netEarnings / taskHours : 0)} į rankas. Suma „į rankas“ –
                orientacinė: mokesčiai skaičiuoti pagal fiksuotą prielaidą. Tikrasis atskaitymas priklauso
                nuo Jūsų visų metinių pajamų.
            </p>
        </div>
    );
}
