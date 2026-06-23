import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { logError } from '../../utils/errorLog';
import { defineCommand, MODES } from '../command';
import { isAgent } from '../actor';

/**
 * unapproveTask — the inverse of approveTask: undo an approval, restoring the task to its
 * pre-approval state and clearing approvedAt/approvedBy, as an audited decision (ADR 0015).
 *
 * This exists so the UNDO of an approve is itself a first-class audited decision instead of a raw,
 * unattributed updateDoc — closing the undo↔audit asymmetry (the approve forward already runs through
 * approveTask; only the Atšaukti reversal was un-recorded). Because approve captures the prior status
 * + isApproved before it commits, the inverse takes them back as input and restores them (defaulting
 * to 'pending' when the prior status was unknown — the same fallback the inline undo used).
 *
 * Input:  { task, priorStatus, priorIsApproved }
 * Effect: status restored + isApproved restored + approvedAt/approvedBy cleared; one decision_log entry.
 */

const buildPlan = (input) => {
  const task = input && input.task;
  if (!task || !task.id) throw new Error('unapproveTask: a task with an id is required');
  const status = input.priorStatus || 'pending';
  const isApproved = !!input.priorIsApproved;
  return {
    targetId: task.id,
    summary: `Undo approval of task "${task.title || task.id}" -> ${status}`,
    before: { status: task.status || null, isApproved: !!task.isApproved },
    after: { status, isApproved },
  };
};

export const unapproveTask = defineCommand({
  name: 'unapproveTask',
  targetType: 'task',
  authorize: (input, { actor, mode }) => {
    if (isAgent(actor) && mode === MODES.COMMIT) {
      return 'agent-commit-not-permitted: an AI agent may propose undoing an approval but not commit it yet';
    }
    return true;
  },
  plan: (input) => buildPlan(input),
  apply: async (planned) => {
    const now = new Date().toISOString();
    try {
      await updateDoc(doc(db, 'tasks', planned.targetId), {
        status: planned.after.status,
        isApproved: planned.after.isApproved,
        approvedAt: null,
        approvedBy: null,
        updatedAt: now,
      });
    } catch (err) {
      logError(err, { source: 'commands.unapproveTask' });
      throw err;
    }
  },
});

export const __buildUnapprovePlan = buildPlan;
