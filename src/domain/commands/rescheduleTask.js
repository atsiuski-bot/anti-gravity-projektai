import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { logError } from '../../utils/errorLog';
import { defineCommand, MODES } from '../command';
import { isAgent } from '../actor';

/**
 * rescheduleTask — change a task's deadline, as an audited decision (ADR 0015, increment 5).
 *
 * The companion triage verb to reprioritizeTask: deadline management is a core manager-agent
 * operation, today only reachable through the full edit form. This gives "reschedule" its own named,
 * audited command so an agent can PROPOSE "move T's deadline to Friday because …" and the same path
 * commits it. Built + tested and agent-ready; UI wiring follows when the edit path is routed through
 * a command (a later increment). The deadline is stored verbatim (an ISO string, or '' to clear) —
 * matching the existing task shape; no parsing here.
 *
 * Input:  { task: {id, title?, deadline?}, deadline: <ISO string | ''> }
 * Effect: task.deadline + updatedAt; one decision_log entry.
 */

const buildPlan = (input) => {
  const task = input && input.task;
  if (!task || !task.id) throw new Error('rescheduleTask: a task with an id is required');
  const deadline = input.deadline || '';
  const nowIso = new Date().toISOString();

  return {
    targetId: task.id,
    summary: `Reschedule task "${task.title || task.id}" -> ${deadline || 'no deadline'}`,
    before: { deadline: task.deadline || '' },
    after: { deadline },
    payload: { deadline, updatedAt: nowIso },
    noop: (task.deadline || '') === deadline,
  };
};

export const rescheduleTask = defineCommand({
  name: 'rescheduleTask',
  targetType: 'task',
  authorize: (input, { actor, mode }) => {
    if (isAgent(actor) && mode === MODES.COMMIT) {
      return 'agent-commit-not-permitted: an AI agent may propose a deadline change but not commit it yet';
    }
    return true;
  },
  plan: (input) => buildPlan(input),
  apply: async (planned) => {
    try {
      await updateDoc(doc(db, 'tasks', planned.targetId), planned.payload);
    } catch (err) {
      logError(err, { source: 'commands.rescheduleTask' });
      throw err;
    }
  },
});

export const __buildReschedulePlan = buildPlan;
