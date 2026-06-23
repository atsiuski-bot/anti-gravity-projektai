import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { logError } from '../../utils/errorLog';
import { defineCommand, MODES } from '../command';
import { isAgent } from '../actor';

/**
 * unconfirmTask — the inverse of confirmTask: return a confirmed task to "awaiting confirmation"
 * (confirmed -> 'completed', clearing confirmedBy/confirmedAt), as an audited decision (ADR 0015).
 *
 * This exists so the UNDO of a confirm is itself a first-class audited decision instead of a raw,
 * unattributed updateDoc — closing the undo↔audit asymmetry where the decision_log could record a
 * confirmation that the live task doc then silently contradicts. `isApproved` is left untouched (a
 * task awaiting confirmation was still approved + worked).
 *
 * Input:  { task, collection?:'tasks'|'archived_tasks' }
 * Effect: status 'completed' + cleared confirmation fields; one decision_log entry.
 */

const buildPlan = (input) => {
  const task = input && input.task;
  if (!task || !task.id) throw new Error('unconfirmTask: a task with an id is required');
  return {
    targetId: task.id,
    collection: input.collection === 'archived_tasks' ? 'archived_tasks' : 'tasks',
    summary: `Unconfirm task "${task.title || task.id}" -> awaiting confirmation`,
    before: { status: task.status || null, confirmedBy: task.confirmedBy || null },
    after: { status: 'completed', confirmedBy: null },
  };
};

export const unconfirmTask = defineCommand({
  name: 'unconfirmTask',
  targetType: 'task',
  authorize: (input, { actor, mode }) => {
    if (isAgent(actor) && mode === MODES.COMMIT) {
      return 'agent-commit-not-permitted: an AI agent may propose un-confirming a task but not commit it yet';
    }
    return true;
  },
  plan: (input) => buildPlan(input),
  apply: async (planned) => {
    const now = new Date().toISOString();
    try {
      await updateDoc(doc(db, planned.collection, planned.targetId), {
        status: 'completed',
        confirmedBy: null,
        confirmedAt: null,
        updatedAt: now,
      });
    } catch (err) {
      logError(err, { source: 'commands.unconfirmTask' });
      throw err;
    }
  },
});

export const __buildUnconfirmPlan = buildPlan;
