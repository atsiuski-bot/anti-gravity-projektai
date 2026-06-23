import { humanActor, MODES, completeTask as completeTaskCommand, reopenTask as reopenTaskCommand } from '../domain';
import { pauseTask } from './taskActions';

/**
 * Toggles a task's completion status — now routed through the audited lifecycle commands
 * (ADR 0015, increment 4). Completing goes through `completeTask` (which applies the manager
 * auto-confirm); un-checking goes through `reopenTask`. Both record a decision_log entry naming the
 * acting user and the before/after status. A still-running timer is stopped here FIRST (clamping the
 * elapsed delta, logging the final work_session, clearing the user's activeSession) so the command
 * stays a pure status write.
 *
 * @param {Object} task - the task object
 * @param {Object} user - the acting user ({ uid, displayName?, email? }) — the audit actor
 * @param {string} userRole - the acting user's role ('manager' | 'admin' | 'worker' | ...)
 * @returns {Promise<void>}
 */
export const toggleTaskCompletion = async (task, user, userRole) => {
    const willBeCompleted = !task.completed;

    // Stop a still-running timer before COMPLETING it: otherwise the checkbox path would leave a
    // "completed but still running" task (timer keeps accruing, the green running UI stays stuck,
    // the user's activeSession still points at it). pauseTask clamps + logs + clears it.
    if (willBeCompleted && task.timerStatus === 'running') {
        await pauseTask(task);
    }

    const actor = humanActor({ uid: user.uid, displayName: user.displayName, email: user.email, role: userRole });
    if (willBeCompleted) {
        await completeTaskCommand({ task }, { actor, mode: MODES.COMMIT, reason: 'completed via checkbox' });
    } else {
        await reopenTaskCommand({ task }, { actor, mode: MODES.COMMIT, reason: 'reopened via checkbox' });
    }
};
