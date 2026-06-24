import { useState } from 'react';
import { Hand, Hourglass, Check } from 'lucide-react';
import { cn } from '../../utils/cn';
import { TASK_FLAG_LIST } from '../../utils/taskFlags';
import { setTaskFlag } from '../../utils/taskFlagActions';

/**
 * TaskFlagToggles — the INTERACTIVE form of the two attention flags, shown on the task's detail
 * surface to the vykdytojas (and managers). Each flag is a press-toggle chip: muted/outlined when
 * off, filled with its semantic colour + a check when on. Tapping ON pings the task's manager
 * (with who raised it); tapping OFF clears it silently — all handled by setTaskFlag.
 *
 * Each chip is a ≥44 px touch target with a visible focus ring and an aria-pressed state, so the
 * control is accessible and its on/off state is announced (DESIGN_SYSTEM §7).
 *
 * @param {Object}   props.task
 * @param {Object}   props.currentUser        the actor ({ uid, displayName, email })
 * @param {string}   [props.defaultManagerId] the worker's defaultManager (notification fallback)
 * @param {string}   [props.collectionName]   'tasks' (default) or 'archived_tasks'
 * @param {Function} [props.onError]          called with the error if a write fails
 */
const FLAG_ICON = {
    needsManager: Hand,
    waiting: Hourglass,
};

const FLAG_TONE_ON = {
    danger: 'border-feedback-danger-border bg-feedback-danger-soft text-feedback-danger-text',
    info: 'border-feedback-info-border bg-feedback-info-soft text-feedback-info-text',
};

export default function TaskFlagToggles({
    task,
    currentUser,
    defaultManagerId = null,
    collectionName = 'tasks',
    onError,
}) {
    const [busy, setBusy] = useState(null);

    const toggle = async (flag) => {
        if (busy) return;
        setBusy(flag.key);
        try {
            await setTaskFlag(task, flag.key, !task?.[flag.field], currentUser, {
                collectionName,
                defaultManagerId,
            });
        } catch (err) {
            onError?.(err);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-2">
            {TASK_FLAG_LIST.map((flag) => {
                const on = !!task?.[flag.field];
                const Icon = FLAG_ICON[flag.key];
                return (
                    <button
                        key={flag.key}
                        type="button"
                        onClick={() => toggle(flag)}
                        aria-pressed={on}
                        disabled={busy === flag.key}
                        className={cn(
                            'inline-flex min-h-touch items-center gap-1.5 rounded-control border px-3 py-2 text-body font-medium transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
                            'disabled:opacity-60',
                            on
                                ? FLAG_TONE_ON[flag.tone]
                                : 'border-line bg-surface-card text-ink-muted hover:bg-surface-sunken',
                        )}
                    >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        {flag.label}
                        {on && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                    </button>
                );
            })}
        </div>
    );
}
