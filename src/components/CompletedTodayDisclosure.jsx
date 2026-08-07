import { useState } from 'react';
import { ChevronDown, CheckCircle2 } from 'lucide-react';
import { cn } from '../utils/cn';
import SessionTypeIcon from './SessionTypeIcon';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString } from '../utils/timeUtils';

const sessionTypeOf = (task) =>
    task.isSystemTask ? 'call' : (task.isQuickWork ? 'quickWork' : 'task');

const TYPE_LABEL = { call: 'Skambutis', quickWork: 'Greita veikla', task: 'Užduotis' };

const finishedAtOf = (task) => task.completedAt || task.confirmedAt || task.updatedAt;

const formatFinishTime = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', hour12: false });
};

/**
 * Collapsible "Padaryti darbai" section at the BOTTOM of the Veiklos tab.
 *
 * The active list deliberately drops finished work, quick work and calls (filterTasksByVisibility),
 * which left a worker with no way to see what they had already done today without opening reports.
 * This section brings that day's finished items back — tasks, greiti darbai and skambučiai together
 * — as read-only summary rows: they are done, so they carry no actions. Collapsed on every tab
 * visit (local state, never persisted), and renders nothing when the day has no finished work.
 */
export default function CompletedTodayDisclosure({ tasks }) {
    const [expanded, setExpanded] = useState(false);
    const count = tasks.length;
    if (count === 0) return null;

    return (
        <section className="mt-4 overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
            <h3 className="m-0">
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                    aria-controls="completed-today-panel"
                    className="flex min-h-[44px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card"
                >
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-feedback-success" aria-hidden="true" />
                    <span className="flex-1 text-body font-semibold text-ink-strong">
                        Padaryti darbai
                    </span>
                    <span
                        className="inline-flex items-center whitespace-nowrap rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-caption font-semibold text-ink-muted"
                        aria-label={`${count} padaryti darbai šiandien`}
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
                <ul id="completed-today-panel" className="m-0 list-none border-t border-line p-0">
                    {tasks.map((task) => {
                        const type = sessionTypeOf(task);
                        const minutes = calculateCurrentTotalMinutes(task);
                        const finished = formatFinishTime(finishedAtOf(task));
                        return (
                            <li
                                key={task.id}
                                className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-0"
                            >
                                <SessionTypeIcon type={type} className="mt-0.5 h-4 w-4 shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-body text-ink-strong break-words">
                                        {task.title || TYPE_LABEL[type]}
                                    </div>
                                    <div className="mt-0.5 text-caption text-ink-muted">
                                        <span>{TYPE_LABEL[type]}</span>
                                        {finished && (
                                            <>
                                                <span aria-hidden="true"> · </span>
                                                <span>Baigta {finished}</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                                <span className="shrink-0 whitespace-nowrap text-body font-semibold text-ink-strong tabular-nums">
                                    {minutes > 0 ? formatMinutesToTimeString(minutes) : '—'}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
