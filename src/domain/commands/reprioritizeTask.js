import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { logError } from '../../utils/errorLog';
import { defineCommand, MODES } from '../command';
import { isAgent } from '../actor';
import { normalizePriority } from '../../utils/priority';

/**
 * reprioritizeTask — change a task's priority, as an audited decision (ADR 0015, increment 5).
 *
 * Triage is a core manager-agent verb. Today priority is only changed inside the full edit form;
 * this command gives "reprioritize" its own named, audited operation (canonicalizing the value), so
 * an agent can PROPOSE "raise T to URGENT because …" for approval and the same path commits it. It
 * is built + tested and agent-ready; UI wiring follows when the edit path is routed through a
 * command (a later increment).
 *
 * Input:  { task: {id, title?, priority?}, priority: <new priority token> }
 * Effect: task.priority (canonical) + updatedAt; one decision_log entry.
 */

const buildPlan = (input) => {
  const task = input && input.task;
  if (!task || !task.id) throw new Error('reprioritizeTask: a task with an id is required');
  const priority = normalizePriority(input.priority);
  const nowIso = new Date().toISOString();

  return {
    targetId: task.id,
    summary: `Reprioritize task "${task.title || task.id}" -> ${priority}`,
    before: { priority: normalizePriority(task.priority) },
    after: { priority },
    payload: { priority, updatedAt: nowIso },
    noop: normalizePriority(task.priority) === priority,
  };
};

export const reprioritizeTask = defineCommand({
  name: 'reprioritizeTask',
  targetType: 'task',
  authorize: (input, { actor, mode }) => {
    if (isAgent(actor) && mode === MODES.COMMIT) {
      return 'agent-commit-not-permitted: an AI agent may propose a priority change but not commit it yet';
    }
    return true;
  },
  plan: (input) => buildPlan(input),
  apply: async (planned) => {
    try {
      await updateDoc(doc(db, 'tasks', planned.targetId), planned.payload);
    } catch (err) {
      logError(err, { source: 'commands.reprioritizeTask' });
      throw err;
    }
  },
});

export const __buildReprioritizePlan = buildPlan;
