import { Target, Clock, Gauge } from 'lucide-react';
import { formatMinutesToTimeString } from '../../utils/timeUtils';

/**
 * PlanPerformanceSummary — how the finished run landed against its plan, and against the worker's
 * own usual time for the same work.
 *
 * The copy rules here are the product decision, not styling preference (see ADR / the incentive
 * reframe). WORKZ pays by the hour, so the app must never ask anyone to be faster:
 *
 *   • Landing inside the plan is the praise, and it reads the same at 82% as at 31%. There is no
 *     "even better" tier, because a lower percentage means the ESTIMATE was wrong, not that the
 *     worker excelled — and a visible race toward zero is a race toward a smaller payslip.
 *   • The "greičiau nei paprastai" line is a statement about the WORK ("šį darbą įprastai atliekate
 *     per …"), never a target and never an instruction. It appears only when the worker's own
 *     history of the same job supports it.
 *   • An overrun is stated as a plain fact in neutral ink — no red, no warning icon, no second
 *     scolding. Running past the estimate already triggered the 70% warning and the 100% hard stop;
 *     punishing it again here only teaches people to avoid the "Užbaigti" button.
 *
 * @param {Object} props.verdict  from buildPlanVerdict — { percentOfPlan, band, improvement }
 * @param {number} props.totalMinutes   this run's duration
 * @param {number} props.estimatedMinutes  the plan (0 when the task carried none)
 */
export default function PlanPerformanceSummary({ verdict, totalMinutes, estimatedMinutes }) {
    const spent = formatMinutesToTimeString(totalMinutes) || '0m';
    const planned = estimatedMinutes > 0 ? formatMinutesToTimeString(estimatedMinutes) : null;
    const band = verdict?.band || null;
    const improvement = verdict?.improvement || null;

    return (
        <div className="space-y-3">
            {/* The fact, always: what was done and how long it took. */}
            <div className="flex items-baseline justify-between gap-3">
                <span className="flex items-center gap-2 text-caption font-medium uppercase tracking-wide text-ink-muted">
                    <Clock className="h-4 w-4" aria-hidden="true" />
                    Sugaišta
                </span>
                <span className="text-h2 font-bold tabular-nums text-ink-strong">{spent}</span>
            </div>

            {band === 'on_plan' && (
                <div className="flex items-start gap-2 rounded-card border border-feedback-success-border bg-feedback-success-soft px-3 py-2.5">
                    <Target className="mt-0.5 h-5 w-5 flex-shrink-0 text-feedback-success-text" aria-hidden="true" />
                    <p className="text-body font-medium text-feedback-success-text">
                        Tilpote į planą{planned ? ` — ${spent} iš numatytų ${planned}` : ''}.
                    </p>
                </div>
            )}

            {band === 'over' && (
                <div className="flex items-start gap-2 rounded-card border border-line bg-surface-sunken px-3 py-2.5">
                    <Clock className="mt-0.5 h-5 w-5 flex-shrink-0 text-ink-muted" aria-hidden="true" />
                    <p className="text-body text-ink">
                        Užtruko ilgiau nei planuota{planned ? ` (numatyta ${planned})` : ''}. Vadovas tai mato.
                    </p>
                </div>
            )}

            {improvement && (
                <div className="flex items-start gap-2 rounded-card border border-feedback-info-border bg-feedback-info-soft px-3 py-2.5">
                    <Gauge className="mt-0.5 h-5 w-5 flex-shrink-0 text-feedback-info-text" aria-hidden="true" />
                    <p className="text-body text-feedback-info-text">
                        Greičiau nei paprastai — šį darbą įprastai atliekate per{' '}
                        {formatMinutesToTimeString(improvement.baselineMinutes)}.
                    </p>
                </div>
            )}
        </div>
    );
}
