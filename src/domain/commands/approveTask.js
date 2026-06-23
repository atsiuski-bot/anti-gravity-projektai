import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { logError } from '../../utils/errorLog';
import { defineCommand, MODES } from '../command';
import { isAgent } from '../actor';

/**
 * approveTask — a manager clears a task's approval gate (unapproved -> 'approved'), as an audited
 * decision (ADR 0015, increment 5). This exact write was duplicated inline across FOUR sites
 * (TaskCard, TaskTable, and two ManagerNotifications handlers) — the scattered-write drift the
 * AI-native analysis flagged. They now all route through this one command, so every approval is
 * attributable in decision_log and an agent can approve through the same contract.
 *
 * The Firestore rules already gate approval to managers (changesApprovalFields forces a whole-team
 * or scoped overseer); this command only adds the actor/mode policy + the audit.
 *
 * Input:  { task: {id, title?, status?, isApproved?} }
 * Effect: status 'approved' + isApproved/approvedAt/approvedBy; one decision_log entry.
 */

const buildPlan = (input, actor) => {
  const task = input && input.task;
  if (!task || !task.id) throw new Error('approveTask: a task with an id is required');
  const nowIso = new Date().toISOString();

  const payload = {
    status: 'approved',
    isApproved: true,
    approvedAt: nowIso,
    approvedBy: actor.id,
    updatedAt: nowIso,
  };

  return {
    targetId: task.id,
    summary: `Approve task "${task.title || task.id}"`,
    before: { status: task.status || null, isApproved: !!task.isApproved },
    after: { status: 'approved', isApproved: true, approvedBy: actor.id },
    payload,
  };
};

export const approveTask = defineCommand({
  name: 'approveTask',
  targetType: 'task',
  authorize: (input, { actor, mode }) => {
    if (isAgent(actor) && mode === MODES.COMMIT) {
      return 'agent-commit-not-permitted: an AI agent may propose approving a task but not commit it yet';
    }
    return true;
  },
  plan: (input, ctx) => buildPlan(input, ctx.actor),
  apply: async (planned) => {
    try {
      await updateDoc(doc(db, 'tasks', planned.targetId), planned.payload);
    } catch (err) {
      logError(err, { source: 'commands.approveTask' });
      throw err;
    }
  },
});

export const __buildApprovePlan = buildPlan;
