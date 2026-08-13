import { useEffect, useState } from 'react';
import { Repeat } from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { describeRecurrence, nextPendingOccurrence, isoWeekday, WEEKDAYS } from '../../utils/recurrence';
import { logError } from '../../utils/errorLog';

/**
 * TaskRecurrenceInfo — the "this job comes back" disclosure inside the task preview.
 *
 * A recurring task is materialized every morning by the scheduled generator, which stamps the task
 * with `isRecurringInstance` + `sourceTemplateId`. The CADENCE itself is not copied onto the task:
 * it lives on the template (`task_templates/{id}.recurrence`), which is where a manager edits it.
 * DECISION 2026-08-13: read the rule from the template when the preview opens, rather than baking a
 * copy onto each generated task — a snapshot would freeze at generation time and quietly lie the
 * moment the schedule changed, and it would leave every already-generated task unable to answer.
 *
 * Renders nothing for an ordinary task. For a recurring one the headline appears immediately and
 * the cadence fills in when the rule arrives, so a slow network delays the detail, never the fact.
 * If the template was deleted (or is unreadable) the fact still stands and only the cadence is
 * withheld — the reader is told the rule is missing rather than left with an unexplained gap.
 *
 * @param {Object} props
 * @param {Object} props.task
 */
export default function TaskRecurrenceInfo({ task }) {
    // The generator's own stamp, not the presence of a template link: a task created once from a
    // template also carries sourceTemplateId, and that one is NOT a repeating job.
    const isRecurring = task?.isRecurringInstance === true;
    const templateId = task?.sourceTemplateId || null;

    const [recurrence, setRecurrence] = useState(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        if (!isRecurring) return undefined;
        // Stamped as recurring but with no template to read (never written that way — a defensive
        // branch): resolve immediately so the reader is told the rule is missing, not left waiting.
        if (!templateId) { setRecurrence(null); setLoaded(true); return undefined; }
        // Reset on task swap so a previous task's cadence can never be shown under a new title.
        setRecurrence(null);
        setLoaded(false);
        let alive = true;
        getDoc(doc(db, 'task_templates', templateId))
            .then((snap) => {
                if (!alive) return;
                setRecurrence(snap.exists() ? (snap.data().recurrence || null) : null);
                setLoaded(true);
            })
            .catch((err) => {
                if (!alive) return;
                logError(err, { source: 'TaskRecurrenceInfo.loadTemplate' });
                setLoaded(true);
            });
        return () => { alive = false; };
    }, [isRecurring, templateId]);

    if (!isRecurring) return null;

    const cadence = recurrence ? describeRecurrence(recurrence, { long: true }) : '';
    const next = recurrence ? nextPendingOccurrence(recurrence) : null;
    const nextWeekday = next ? WEEKDAYS.find((w) => w.iso === isoWeekday(next))?.label : null;

    return (
        <div className="flex items-start gap-2 rounded-card bg-surface-sunken p-3">
            <Repeat className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" aria-hidden="true" />
            <div className="min-w-0 text-body text-ink">
                <div className="font-semibold text-ink-strong">Pasikartojanti veikla</div>
                {cadence && <div>{cadence}</div>}
                {next && (
                    <div className="text-caption text-ink-muted">
                        Kitas kartas: <span className="font-medium text-ink">{next}</span>
                        {nextWeekday ? ` (${nextWeekday})` : ''}
                    </div>
                )}
                {loaded && !recurrence && (
                    <div className="text-caption text-ink-muted">Kartojimo taisyklė nerasta.</div>
                )}
            </div>
        </div>
    );
}
