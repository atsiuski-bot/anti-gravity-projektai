import { useState, useEffect } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { Wallet } from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { getLithuanianDateString, sanitizeReportMinutes } from '../utils/timeUtils';
import { hasPayRate, marginalNetEarnings, netToGross, getPayRateTiers, getPayRateLabel, EFFECTIVE_TAX_RATE } from '../utils/payRate';
import { formatEur, formatEurPerHour } from '../utils/formatters';
import { logError } from '../utils/errorLog';
import Modal from './ui/Modal';
import Button from './ui/Button';

// EarningsModal — pops after a worker finishes a task, showing what that work earned: the GROSS
// (with-tax) amount first, the NET (take-home) beside it. Tiers are MARGINAL on the worker's
// CUMULATIVE monthly hours, so this task's value is the slice it adds on top of the month's
// already-worked hours: we sum the month's work_sessions (tasks + quick-work + calls; breaks live
// in a separate collection, so they are naturally excluded), drop this task's own segments to
// avoid double counting, then stack this task's full total on top.
const formatHours = (h) =>
    `${h.toLocaleString('lt-LT', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} val.`;

export default function EarningsModal({ open, onClose, task, totalMinutes }) {
    const { currentUser, userData } = useAuth();
    const [priorMinutes, setPriorMinutes] = useState(null); // null = still loading
    const [loadFailed, setLoadFailed] = useState(false);    // month read failed — refuse to quote a sum
    const payRate = userData?.payRate;

    useEffect(() => {
        if (!open || !currentUser?.uid) return undefined;
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
                logError(e, { source: 'EarningsModal.monthHours', userId: currentUser?.uid });
                // Fail CLOSED: without the month's prior hours the marginal tier is unknown, and the
                // old fallback (prior = 0) quoted a confidently WRONG amount. Say nothing instead.
                if (!cancelled) setLoadFailed(true);
            }
        })();
        return () => { cancelled = true; };
    }, [open, currentUser?.uid, task?.id]);

    if (!open) return null;

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
    const taxPct = Math.round(EFFECTIVE_TAX_RATE * 100);

    return (
        <Modal
            open={open}
            onClose={onClose}
            title="Uždarbis už šią veiklą"
            size="sm"
            footer={<Button variant="primary" fullWidth onClick={onClose}>Gerai</Button>}
        >
            {loading ? (
                <p className="py-6 text-center text-body text-ink-muted">Skaičiuojama…</p>
            ) : !hasPayRate(payRate) ? (
                <p className="py-2 text-body text-ink-muted">Jums dar nenustatytas įkainis.</p>
            ) : loadFailed ? (
                <p role="alert" className="py-2 text-body font-medium text-feedback-danger">
                    Nepavyko suskaičiuoti šio mėnesio valandų, todėl uždarbio nerodome — suma būtų
                    neteisinga. Bandykite vėliau arba pasitikslinkite pas vadovą.
                </p>
            ) : (
                <div className="space-y-4">
                    <div className="flex items-center justify-center gap-2 text-ink-muted">
                        <Wallet className="h-5 w-5" aria-hidden="true" />
                        <span className="text-body">{task?.title || 'Veikla'} · {formatHours(taskHours)}</span>
                    </div>

                    {rateLabel && (
                        <p className="text-center text-caption text-ink-muted">Tarifas: {rateLabel}</p>
                    )}

                    <div className="rounded-card border border-line bg-surface-sunken/40 p-4 text-center">
                        <span className="block text-caption font-medium uppercase tracking-wide text-ink-muted">
                            Su mokesčiais (bruto)
                        </span>
                        <span className="mt-1 block text-display font-bold tabular-nums text-ink-strong">
                            {formatEur(grossEarnings)}
                        </span>
                    </div>

                    <div className="rounded-card border border-line bg-surface-card p-4 text-center">
                        <span className="block text-caption font-medium uppercase tracking-wide text-ink-muted">
                            Apytikslis uždarbis į rankas (orientacinis)
                        </span>
                        <span className="mt-1 block text-h2 font-bold tabular-nums text-feedback-success-text">
                            {formatEur(netEarnings)}
                        </span>
                    </div>

                    <p className="text-center text-caption text-ink-muted">
                        Įkainis: {formatEurPerHour(taskHours > 0 ? grossEarnings / taskHours : 0)} su mokesčiais ·{' '}
                        {formatEurPerHour(taskHours > 0 ? netEarnings / taskHours : 0)} į rankas. Suma „į rankas“ –
                        orientacinė: mokesčiai skaičiuoti pagal fiksuotą prielaidą (individuali veikla, ~{taxPct}%,
                        ~30 000 €/m. pajamos, be išlaidų). Tikrasis atskaitymas priklauso nuo Jūsų visų metinių pajamų.
                    </p>
                </div>
            )}
        </Modal>
    );
}
