import { Hand, Hourglass } from 'lucide-react';
import { cn } from '../../utils/cn';
import { getActiveTaskFlags } from '../../utils/taskFlags';

/**
 * TaskFlagBadges — the read-only, glanceable form of the two worker-set attention flags. Renders a
 * small icon + label pill for each RAISED flag (and nothing at all when none is raised, so a calm
 * task adds no markup). Shown next to the title on the worker card and the manager table; the whole
 * card/row is also tinted the same colour (see getTaskFlagTint), so the state reads even before the
 * pill is parsed.
 *
 * The pill rides on the RAISED surface colour (bg-surface-card) rather than the matching soft tint —
 * so when the whole card is tinted danger-soft (because the same flag is raised), the badge does not
 * dissolve into it. The semantic colour carries on the icon + label + border instead, which keeps
 * the badge legible at arm's length in bright outdoor light. Icon + label always travel together, so
 * colour is never the sole signal (DESIGN_SYSTEM §5).
 */
const FLAG_ICON = {
    needsManager: Hand,
    waiting: Hourglass,
};

const FLAG_PILL = {
    danger: 'bg-surface-card text-feedback-danger-text border border-feedback-danger-border shadow-sm',
    info: 'bg-surface-card text-feedback-info-text border border-feedback-info-border shadow-sm',
};

export default function TaskFlagBadges({ task, size = 'md', className }) {
    const active = getActiveTaskFlags(task);
    if (active.length === 0) return null;

    return (
        <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
            {active.map((flag) => {
                const Icon = FLAG_ICON[flag.key];
                const setByName = task?.[flag.setByNameField];
                return (
                    <span
                        key={flag.key}
                        className={cn(
                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold',
                            size === 'sm' ? 'text-caption' : 'text-caption',
                            FLAG_PILL[flag.tone],
                        )}
                        title={setByName ? `${flag.label} · pažymėjo ${setByName}` : flag.label}
                    >
                        <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} aria-hidden="true" />
                        {flag.label}
                    </span>
                );
            })}
        </span>
    );
}
