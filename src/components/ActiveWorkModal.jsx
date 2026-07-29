import { Clock, Hourglass } from 'lucide-react';
import Modal from './ui/Modal';
import TaskDetailModal from './task/TaskDetailModal';
import { useActiveSecondarySession } from '../hooks/useActiveSecondarySession';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { SESSION_COLORS } from '../utils/sessionColors';
import { cn } from '../utils/cn';

const clockTime = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', hour12: false });
};

/**
 * SecondaryWorkCard — what a running break / call / quick work looks like when opened.
 *
 * It is NOT a task card, because there is no task yet: a call and a quick work only become
 * documents when they END (the stop screen is where the worker names them). So this shows what
 * actually exists mid-session — which kind of work is running, since when, how long, and what it is
 * parked on top of.
 *
 * The parked stack is the part worth opening for. A session started over a task is time the worker
 * must come back and close; if it stays invisible it becomes forgotten, and forgotten means
 * unlogged. Each entry is named in words, never by colour or icon alone (§4-A / WCAG 1.4.1).
 *
 * No stop button here on purpose: the timer controls live in the bottom bar (mobile) and the side
 * rail (desktop) and are on screen at all times. A second stop, wired separately, would be a second
 * place for the end-of-session flow — the naming prompt for quick work, the contact picker for a
 * call — to drift out of step with the real one.
 */
function SecondaryWorkCard({ cfg, startISO, minutes, parkedNodes }) {
    const parked = parkedNodes
        .map((node) => ({ node, cfg: SESSION_COLORS[node.type] }))
        .filter((entry) => entry.cfg);
    const started = clockTime(startISO);

    return (
        <div className="space-y-4">
            <div className={cn('flex items-center justify-between gap-3 rounded-card border p-4', cfg.accentBorder, cfg.surface)}>
                <span className={cn('flex items-center gap-2 text-body-lg font-semibold', cfg.accent)}>
                    <cfg.Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                    {cfg.label}
                </span>
                <span className={cn('font-mono text-3xl font-bold leading-none tabular-nums', cfg.accent)}>
                    {formatMinutesToTimeString(minutes)}
                </span>
            </div>

            {started && (
                <p className="flex items-center gap-2 text-body text-ink">
                    <Clock className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                    Pradėta {started}
                </p>
            )}

            {parked.length > 0 && (
                <div className="rounded-card border border-line bg-surface-sunken p-3">
                    <p className="mb-2 flex items-center gap-2 text-caption font-bold uppercase tracking-wide text-ink-muted">
                        <Hourglass className="h-4 w-4 shrink-0" aria-hidden="true" />
                        Laukia, kol grįšite
                    </p>
                    <ul className="space-y-1">
                        {parked.map((entry, index) => (
                            <li key={`${entry.node.type}-${index}`} className="flex items-center gap-2 text-body text-ink-strong">
                                <entry.cfg.Icon className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                                <span className="min-w-0 truncate">
                                    {entry.node.type === 'task' && entry.node.taskTitle
                                        ? entry.node.taskTitle
                                        : entry.cfg.label}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <p className="text-caption text-ink-muted">
                Užbaigti galite tuo pačiu mygtuku, kuriuo pradėjote.
            </p>
        </div>
    );
}

/**
 * ActiveWorkModal — the card behind the header's active-work pill.
 *
 * The pill says WHAT is running; tapping it answers "and what exactly is that?". Which card that is
 * depends on the kind of work, and in both cases it is the surface that already exists rather than a
 * new one built for the header:
 *
 *   • a running TASK opens {@link TaskDetailModal} — the very card its row in Veiklos opens, so the
 *     worker reads one description, one checklist, one set of comments, wherever they came from;
 *   • a break / call / quick work opens the session card above, because no task document exists yet.
 *
 * The task card is opened as a PREVIEW: no edit / delete / approve handlers are passed. Managing a
 * task stays in the list that owns it, so the header does not become a second place where those
 * permissions are decided (and could be decided differently).
 *
 * @param {Object}   props
 * @param {boolean}  props.isOpen
 * @param {Function} props.onClose
 * @param {string|null} props.sessionType  'task' | 'break' | 'call' | 'quickWork'
 * @param {Object|null} props.task         the live running-task document (task sessions only)
 */
export default function ActiveWorkModal({ isOpen, onClose, sessionType, task }) {
    const secondary = useActiveSecondarySession();

    if (!isOpen) return null;

    if (sessionType === 'task') {
        // No task document yet (the header's own snapshot is still in flight, or the task was
        // deleted mid-run): there is nothing to show, so stay closed rather than open an empty sheet.
        if (!task) return null;
        return (
            <TaskDetailModal
                isOpen
                onClose={onClose}
                task={task}
                isRunning={task.timerStatus === 'running'}
                showManagerLine
            />
        );
    }

    if (!secondary.active) return null;

    return (
        // Generic title on purpose: the session's own name sits in the hero below, next to its icon
        // and colour, where the words are what stop colour being the sole signal. Repeating it in the
        // header made the card open saying "Pertrauka / Pertrauka".
        <Modal open onClose={onClose} title="Vykstanti veikla" size="md">
            <SecondaryWorkCard
                cfg={secondary.cfg}
                startISO={secondary.startISO}
                minutes={secondary.minutes}
                parkedNodes={secondary.parkedNodes}
            />
        </Modal>
    );
}
