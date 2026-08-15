import { Target, Gauge, Clock } from 'lucide-react';
import { formatMinutesToTimeString } from '../../utils/timeUtils';

/**
 * PlanVerdictChips — the server-authored `planVerdict` rendered as one or two quiet chips.
 *
 * This is the MANAGER-facing half of the recognition loop, and the reason it exists at all: the
 * chosen compensation policy leaves pay unchanged, so a badge is the entire reward — and a badge
 * nobody mentions is an icon, not recognition. Putting the verdict beside the planned-vs-spent row,
 * on the screen where a manager reviews and accepts finished work, is what gives them a natural
 * moment to say something. There is deliberately no new notification: this rides on a card the
 * manager already opens.
 *
 * Copy is impersonal by design ("Tilpo į planą", not "Jūs tilpote") because the same component is
 * read by the manager, by the worker, and by anyone else with access to the task — it describes the
 * WORK, never grades the person. An overrun stays in neutral ink for the same reason the finish
 * summary does: it is context for a conversation, not a mark against someone.
 *
 * Renders nothing when the task predates the verdict (only tasks completed after the Cloud Function
 * deploy carry one) or when there is nothing to say.
 */
export default function PlanVerdictChips({ verdict }) {
    if (!verdict) return null;
    const { band, percentOfPlan, improvement } = verdict;
    if (!band && !improvement) return null;

    return (
        <div className="flex flex-wrap items-center gap-2">
            {band === 'on_plan' && (
                <span className="inline-flex items-center gap-1.5 rounded-control border border-feedback-success-border bg-feedback-success-soft px-2.5 py-1 text-caption font-medium text-feedback-success-text">
                    <Target className="h-3.5 w-3.5" aria-hidden="true" />
                    Tilpo į planą{Number.isFinite(percentOfPlan) ? ` · ${percentOfPlan}%` : ''}
                </span>
            )}

            {band === 'over' && (
                <span className="inline-flex items-center gap-1.5 rounded-control border border-line bg-surface-sunken px-2.5 py-1 text-caption font-medium text-ink-muted">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    Viršytas planas{Number.isFinite(percentOfPlan) ? ` · ${percentOfPlan}%` : ''}
                </span>
            )}

            {improvement && (
                <span className="inline-flex items-center gap-1.5 rounded-control border border-feedback-info-border bg-feedback-info-soft px-2.5 py-1 text-caption font-medium text-feedback-info-text">
                    <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                    Greičiau nei įprastai šiam darbui · įprastai {formatMinutesToTimeString(improvement.baselineMinutes)}
                </span>
            )}
        </div>
    );
}
