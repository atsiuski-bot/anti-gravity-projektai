import { useState } from 'react';
import { AlarmClock, ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';
import TaskCard from '../TaskCard';
import TaskTable from '../TaskTable';
import { formatSnoozeUntil } from '../../utils/taskSnooze';

/**
 * SnoozedTasksDisclosure — the collapsed "Atidėta (N)" section at the bottom of a task list. A
 * parked task leaves the active list but never vanishes without a trace: it sits here, with when it
 * returns, until its time comes (useSnoozeSplit moves it back by itself). Managers see their team's
 * parked work here too, with who parked it (SnoozeBadge), and can bring it back early.
 *
 * Collapsed on every visit (local state, never persisted — same as the other disclosures on the
 * tab), except while a search/filter is active, so a match is never hidden behind a closed header.
 * `variant="table"` is the desktop form: the same header over a dense TaskTable.
 */
export default function SnoozedTasksDisclosure({ tasks, onEdit, role = 'worker', variant = 'cards', forceOpen = false, idSuffix = 'list' }) {
    const [expanded, setExpanded] = useState(false);
    const count = tasks.length;
    if (count === 0) return null;

    const isOpen = forceOpen || expanded;
    const panelId = `snoozed-tasks-panel-${idSuffix}-${variant}`;
    const soonest = formatSnoozeUntil(tasks[0].snoozedUntil);

    return (
        <section className="mt-4 overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
            <h3 className="m-0">
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    disabled={forceOpen}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    className="flex min-h-[44px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card disabled:cursor-default"
                >
                    <AlarmClock className="h-5 w-5 shrink-0 text-feedback-warning" aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-body font-semibold text-ink-strong">Atidėta</span>
                        <span className="text-caption text-ink-muted">Artimiausia grįš {soonest}</span>
                    </span>
                    <span
                        className="inline-flex items-center whitespace-nowrap rounded-full border border-feedback-warning-border bg-feedback-warning-soft px-2 py-0.5 text-caption font-semibold text-feedback-warning-text"
                        aria-label={`${count} atidėta`}
                    >
                        {count}
                    </span>
                    {!forceOpen && (
                        <ChevronDown
                            className={cn('h-5 w-5 shrink-0 text-ink-muted transition-transform duration-base', isOpen && 'rotate-180')}
                            aria-hidden="true"
                        />
                    )}
                </button>
            </h3>
            {isOpen && (
                <div id={panelId} className="space-y-4 border-t border-line p-3 animate-in fade-in slide-in-from-top-2 duration-150">
                    {variant === 'table' ? (
                        <TaskTable tasks={tasks} onEdit={onEdit} role={role} />
                    ) : (
                        tasks.map((task) => (
                            <TaskCard key={task.id} task={task} onEdit={() => onEdit(task)} role={role} />
                        ))
                    )}
                </div>
            )}
        </section>
    );
}
