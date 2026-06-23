import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { logError } from '../../utils/errorLog';
import { defineCommand, MODES } from '../command';
import { isAgent } from '../actor';

/**
 * confirmTask — a manager signs off finished work (completed -> 'confirmed'), as an audited decision
 * (ADR 0015). This is the single most-repeated manager decision and was the largest remaining audit
 * hole: it was written INLINE at multiple sites with divergent shapes (some adding isApproved, one
 * omitting confirmedBy, one writing a literal string uid) and NONE recorded a decision_log entry.
 * This command unifies the write to one canonical shape and records who confirmed what.
 *
 * Canonical shape: { status:'confirmed', confirmedBy, confirmedAt, updatedAt }. isApproved is NOT
 * set here — a confirmed (done) task's approval gate is moot, so the lone site that flipped it is
 * normalised away rather than spread. `collection` lets a manager also confirm an already-archived
 * task (archived_tasks) through the same command.
 *
 * Input:  { task, collection?:'tasks'|'archived_tasks' }
 * Effect: the confirmation fields on the target doc; one decision_log entry.
 */

const buildPlan = (input) => {
  const task = input && input.task;
  if (!task || !task.id) throw new Error('confirmTask: a task with an id is required');
  return {
    targetId: task.id,
    collection: input.collection === 'archived_tasks' ? 'archived_tasks' : 'tasks',
    summary: `Confirm task "${task.title || task.id}"`,
    before: { status: task.status || null, confirmedBy: task.confirmedBy || null },
    after: { status: 'confirmed' },
  };
};

export const confirmTask = defineCommand({
  name: 'confirmTask',
  targetType: 'task',
  authorize: (input, { actor, mode }) => {
    if (isAgent(actor) && mode === MODES.COMMIT) {
      return 'agent-commit-not-permitted: an AI agent may propose confirming a task but not commit it yet';
    }
    return true;
  },
  plan: (input) => buildPlan(input),
  apply: async (planned, input, { actor }) => {
    const now = new Date().toISOString();
    try {
      await updateDoc(doc(db, planned.collection, planned.targetId), {
        status: 'confirmed',
        confirmedBy: actor.id,
        confirmedAt: now,
        updatedAt: now,
      });
    } catch (err) {
      logError(err, { source: 'commands.confirmTask' });
      throw err;
    }
  },
});

export const __buildConfirmPlan = buildPlan;
