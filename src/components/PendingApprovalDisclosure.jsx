import { useState } from 'react';
import { ChevronDown, Clock } from 'lucide-react';
import { cn } from '../utils/cn';
import TaskCard from './TaskCard';

/**
 * Collapsible "Laukia patvirtinimo" section shown above the worker's task list.
 *
 * Surfaces the tasks THIS user created that a manager has not yet approved
 * (status === 'unapproved'). These are not actionable until approved, so they are
 * pulled out of the main list and tucked into a disclosure that stays COLLAPSED on
 * every tab visit — local state, never persisted, so arriving at the tab always
 * shows it closed. Renders nothing when there is nothing awaiting approval.
 */
export default function PendingApprovalDisclosure({ tasks, onEdit, role = 'worker' }) {
    const [expanded, setExpanded] = useState(false);
    const count = tasks.length;
    if (count === 0) return null;

    return (
        <section className="mb-4 overflow-hidden rounded-card border border-feedback-warning-border bg-surface-card shadow-sm">
            <h3 className="m-0">
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                    aria-controls="pending-approval-panel"
                    className="flex min-h-[44px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-feedback-warning-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card"
                >
                    <Clock className="h-5 w-5 shrink-0 text-feedback-warning" aria-hidden="true" />
                    <span className="flex-1 text-body font-semibold text-ink-strong">
                        Laukia patvirtinimo
                    </span>
                    <span
                        className="inline-flex items-center whitespace-nowrap rounded-full border border-feedback-warning-border bg-feedback-warning-soft px-2 py-0.5 text-caption font-semibold text-feedback-warning-text"
                        aria-label={`${count} laukia patvirtinimo`}
                    >
                        {count}
                    </span>
                    <ChevronDown
                        className={cn(
                            'h-5 w-5 shrink-0 text-ink-muted transition-transform',
                            expanded && 'rotate-180'
                        )}
                        aria-hidden="true"
                    />
                </button>
            </h3>
            {expanded && (
                <div id="pending-approval-panel" className="space-y-4 border-t border-line p-3">
                    {tasks.map((task) => (
                        <TaskCard
                            key={task.id}
                            task={task}
                            onEdit={() => onEdit(task)}
                            role={role}
                        />
                    ))}
                </div>
            )}
        </section>
    );
}
