import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { logError } from '../../utils/errorLog';
import { defineCommand, MODES } from '../command';
import { isAgent } from '../actor';

/**
 * reopenTask — bring a completed or deleted task back to active, as an audited lifecycle transition
 * (ADR 0015, increment 4). The inverse of completeTask / the old revertTask: it clears the
 * completion, confirmation AND soft-delete flags and returns the task to 'pending', recording ONE
 * decision (who reopened it, the before/after status). The timer is re-armed to 'paused' if any time
 * was logged (so the worker can resume), else cleared — mirroring the prior revertTask behaviour.
 *
 * Input:  { task }
 * Effect: the task's status/completion/deletion fields reset; one decision_log entry.
 */

const buildPlan = (input) => {
  const task = input && input.task;
  if (!task || !task.id) throw new Error('reopenTask: a task with an id is required');
  const nowIso = new Date().toISOString();

  const payload = {
    status: 'pending',
    completed: false,
    completedAt: null,
    completedBy: null,
    confirmedBy: null,
    confirmedAt: null,
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
    timerStatus: task.timerMinutes > 0 ? 'paused' : null,
    updatedAt: nowIso,
  };

  return {
    targetId: task.id,
    summary: `Reopen task "${task.title || task.id}" -> pending`,
    before: { status: task.status || null, completed: !!task.completed },
    after: { status: 'pending', completed: false },
    payload,
  };
};

export const reopenTask = defineCommand({
  name: 'reopenTask',
  targetType: 'task',
  authorize: (input, { actor, mode }) => {
    if (isAgent(actor) && mode === MODES.COMMIT) {
      return 'agent-commit-not-permitted: an AI agent may propose reopening a task but not commit it yet';
    }
    return true;
  },
  plan: (input) => buildPlan(input),
  apply: async (planned) => {
    try {
      await updateDoc(doc(db, 'tasks', planned.targetId), planned.payload);
    } catch (err) {
      logError(err, { source: 'commands.reopenTask' });
      throw err;
    }
  },
});

export const __buildReopenPlan = buildPlan;
