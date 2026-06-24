/**
 * TASK ATTENTION FLAGS — two worker-set boolean signals a vykdytojas can raise on any of their
 * tasks straight from the task surface:
 *
 *   - needsManager ("Reikia vadovo") — the worker needs the manager's attention/decision on this
 *     task. The louder, red signal; its tint wins when both flags are on.
 *   - waiting       ("Laukiama")     — the worker is blocked, waiting on something. A calm blue
 *     signal.
 *
 * Each flag stores its boolean plus a who/when stamp (mirroring the checklist `doneBy` pattern) so
 * the manager can see WHO raised it even outside the push. The fields are plain task-document
 * fields — NOT manager-only approval fields — so the assigned worker may toggle them through the
 * same `tasks` UPDATE rule that already lets them tick a checklist item, with no rules change.
 *
 * This module is the single source of truth for the flags' field names, copy, tone and tint. The
 * card / table read it to render the badges + the whole-surface tint; {@link setTaskFlag} (in
 * taskFlagActions.js) reads it to write the toggle and ping the manager; the notification registry
 * mirrors the two `notifyType`s.
 *
 * Colours come from the semantic feedback tokens (theme-reactive, WCAG AA in light + dark): danger
 * = red, info = a calm indigo/blue. They are paired with an icon + a text label in the UI, so the
 * colour is never the sole signal (DESIGN_SYSTEM §5 / WCAG 1.4.1).
 */

export const TASK_FLAGS = {
    needsManager: {
        key: 'needsManager',
        field: 'needsManager',
        setByField: 'needsManagerSetBy',
        setByNameField: 'needsManagerSetByName',
        setAtField: 'needsManagerSetAt',
        notifyType: 'task_needs_manager',
        label: 'Reikia vadovo',
        tone: 'danger',
        bgClass: 'bg-feedback-danger-soft',
        borderClass: 'border-feedback-danger-border',
    },
    waiting: {
        key: 'waiting',
        field: 'waiting',
        setByField: 'waitingSetBy',
        setByNameField: 'waitingSetByName',
        setAtField: 'waitingSetAt',
        notifyType: 'task_waiting',
        label: 'Laukiama',
        tone: 'info',
        bgClass: 'bg-feedback-info-soft',
        borderClass: 'border-feedback-info-border',
    },
};

/**
 * Declaration order is PRECEDENCE order: needsManager (red, urgent) before waiting (blue). When
 * both flags are on, the first active one decides the single whole-card/row tint, while the badges
 * still render BOTH so no information is lost.
 */
export const TASK_FLAG_LIST = [TASK_FLAGS.needsManager, TASK_FLAGS.waiting];

/**
 * A task no longer takes worker-attention flags once it is finished or gone: a completed / accepted
 * (confirmed) / deleted task is out of the worker's hands, so a stale "Laukiama" / "Reikia vadovo"
 * must not keep glowing on it — anywhere it renders, including the manager report tables. The flag
 * fields may stay set on the document (harmless, invisible); a revert back to active work re-shows
 * them. This single guard keeps every surface consistent without each one re-checking the lifecycle.
 */
const isFinishedOrGoneTask = (task) =>
    !task ||
    task.isDeleted === true ||
    task.completed === true ||
    task.status === 'deleted' ||
    task.status === 'completed' ||
    task.status === 'confirmed';

/** The flags currently raised on an ACTIVE task, in precedence order (empty once finished/gone). */
export const getActiveTaskFlags = (task) =>
    isFinishedOrGoneTask(task) ? [] : TASK_FLAG_LIST.filter((flag) => !!task[flag.field]);

/**
 * The whole-card tint (bg + border) for a task — the highest-precedence active flag's colour, or
 * null when none is raised (so the caller falls back to its normal status styling).
 */
export const getTaskFlagTint = (task) => {
    const [top] = getActiveTaskFlags(task);
    return top ? `${top.bgClass} ${top.borderClass}` : null;
};

/** The row background only (no border) — for the desktop table rows, which use divider lines. */
export const getTaskFlagRowBg = (task) => {
    const [top] = getActiveTaskFlags(task);
    return top ? top.bgClass : null;
};
