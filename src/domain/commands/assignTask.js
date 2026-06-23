import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { logError } from '../../utils/errorLog';
import { defineCommand, MODES } from '../command';
import { isAgent } from '../actor';

/**
 * assignTask — make work distribution a FIRST-CLASS operation instead of a side effect of editing
 * a form field (ADR 0015). Today a manager "assigns" by setting `assignedUserId` on task save:
 * there is no record that an assignment DECISION was made, and no seam an agent can plug into.
 *
 * This command gives assignment an explicit input (the task + the chosen worker + why), an
 * explicit effect (the reassignment + an audit entry), and a propose mode — exactly the shape an
 * AI assignment agent needs: it can PROPOSE "assign T to W because …" for a human to approve, and
 * the SAME code path commits it once approved.
 *
 * It wraps the same reassignment write the UI performs (assignedUserId / assignedAt / updatedAt),
 * so behaviour is unchanged — only now it is named, audited, and agent-callable. `assignedUserName`
 * stays a read-DERIVED display field (the manager/worker list loaders re-derive it from the live
 * user roster, and the write-back paths strip it), so the command captures it in the audit
 * before/after for a point-in-time record but does NOT persist it onto the task. The Firestore rules
 * remain the real authority on the write (team-scope is enforced there); `authorize` here only adds
 * the actor/mode POLICY the rules cannot express.
 *
 * Input:  { task: {id, title?, assignedUserId?, assignedUserName?}, worker: {id, name?} }
 * Effect: task.assignedUserId/Name reassigned; one decision_log entry.
 */

const buildPlan = (input) => {
  const { task, worker } = input || {};
  if (!task || !task.id) throw new Error('assignTask: a task with an id is required');
  if (!worker || !worker.id) throw new Error('assignTask: a worker with an id is required');

  const fromId = task.assignedUserId || null;
  const fromName = task.assignedUserName || null;
  const toName = worker.name || null;

  return {
    targetId: task.id,
    // English (persisted to the audit log). The UI composes its own Lithuanian proposal label
    // from the structured before/after when it renders an assignment proposal card.
    summary: `Assign task "${task.title || task.id}" to ${toName || worker.id}` +
             (fromId ? ` (was ${fromName || fromId})` : ''),
    before: { assignedUserId: fromId, assignedUserName: fromName },
    after: { assignedUserId: worker.id, assignedUserName: toName },
    effect: { taskId: task.id, assignedUserId: worker.id },
    noop: fromId === worker.id, // already assigned to this worker — apply is a harmless rewrite
  };
};

export const assignTask = defineCommand({
  name: 'assignTask',
  targetType: 'task',
  authorize: (input, { actor, mode }) => {
    // The human-only boundary, in code (mirrors CLAUDE.md's deploy/secret boundary): an AI agent
    // may PROPOSE an assignment but may NOT yet COMMIT one directly. Agent-driven commits ship in a
    // later increment behind a propose→human-approve gate; refusing here keeps the boundary
    // enforced by the kernel rather than by intent alone.
    if (isAgent(actor) && mode === MODES.COMMIT) {
      return 'agent-commit-not-permitted: an AI agent may propose an assignment but not commit it yet';
    }
    return true;
  },
  plan: (input) => buildPlan(input),
  apply: async (planned) => {
    const nowIso = new Date().toISOString();
    try {
      await updateDoc(doc(db, 'tasks', planned.targetId), {
        assignedUserId: planned.after.assignedUserId,
        // assignedUserName is intentionally NOT persisted — it is a read-derived display field
        // everywhere else (the list loaders re-derive it from the roster; write-backs strip it), so
        // freezing it here would go stale on a rename. The audit before/after still capture it.
        assignedAt: nowIso,
        updatedAt: nowIso,
      });
    } catch (err) {
      logError(err, { source: 'commands.assignTask' });
      throw err;
    }
  },
});

// Exposed for focused unit testing of the pure planning step.
export const __buildAssignPlan = buildPlan;
