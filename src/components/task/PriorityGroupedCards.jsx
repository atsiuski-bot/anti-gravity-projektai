import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';
import TaskCard from '../TaskCard';
import { BOARD_COLUMNS, groupTasksByPriority } from '../../utils/boardOrder';
import { PRIORITIES, getPriorityLabel, getPriorityColor } from '../../utils/priority';

/**
 * PriorityGroupedCards — the worker's MOBILE card stack, split into one collapsible section per
 * priority (Skubus / Aukštas / Vidutinis / Žemas). A long backlog of low-priority work (even
 * tasks months ahead) otherwise forces a lot of scrolling past it to reach what matters.
 *
 * Defaults: only the lowest priority starts collapsed. A group is held OPEN regardless of the
 * toggle while a search/tag filter is active (so a match is never hidden behind a closed header)
 * and while it holds a running task (the live timer must never be tucked away). State is local and
 * never persisted — the same convention as the other disclosures on this tab.
 *
 * The input is already in canonical order, so each group keeps that order untouched.
 */
export default function PriorityGroupedCards({ tasks, onEdit, role = 'worker', forceOpen = false }) {
    const [collapsed, setCollapsed] = useState(() => new Set([PRIORITIES.LOW]));
    const groups = groupTasksByPriority(tasks);

    const toggle = (priority) =>
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(priority)) next.delete(priority);
            else next.add(priority);
            return next;
        });

    return (
        <div className="space-y-4">
            {BOARD_COLUMNS.map((priority) => {
                const items = groups[priority];
                if (items.length === 0) return null;
                const hasRunning = items.some((t) => t.timerStatus === 'running');
                const locked = forceOpen || hasRunning;
                const isOpen = locked || !collapsed.has(priority);
                const panelId = `priority-group-${priority}`;
                const label = getPriorityLabel(priority);
                return (
                    <section key={priority} aria-label={`${label} prioritetas`}>
                        <h3 className="m-0">
                            <button
                                type="button"
                                onClick={() => toggle(priority)}
                                disabled={locked}
                                aria-expanded={isOpen}
                                aria-controls={panelId}
                                className="flex min-h-[44px] w-full items-center gap-3 rounded-card border border-line bg-surface-card px-4 py-2 text-left shadow-sm transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page disabled:cursor-default"
                            >
                                <span
                                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                                    style={{ backgroundColor: getPriorityColor(priority) }}
                                    aria-hidden="true"
                                />
                                <span className="flex-1 text-body font-semibold text-ink-strong">{label}</span>
                                <span
                                    className="inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-surface-sunken px-2 py-0.5 text-caption font-bold text-ink-muted"
                                    aria-label={`${items.length} užduočių`}
                                >
                                    {items.length}
                                </span>
                                {!locked && (
                                    <ChevronDown
                                        className={cn(
                                            'h-5 w-5 shrink-0 text-ink-muted transition-transform duration-base',
                                            isOpen && 'rotate-180'
                                        )}
                                        aria-hidden="true"
                                    />
                                )}
                            </button>
                        </h3>
                        {isOpen && (
                            <div id={panelId} className="mt-3 space-y-4">
                                {items.map((task) => (
                                    <div key={task.id} className="animate-in fade-in slide-in-from-bottom-2">
                                        <TaskCard task={task} onEdit={() => onEdit(task)} role={role} />
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}
