import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { logError } from '../../utils/errorLog';
import { resolveCompletionStatus } from '../../utils/formatters';
import { defineCommand, MODES } from '../command';
import { isAgent } from '../actor';

/**
 * completeTask — mark a task done, as an audited lifecycle transition (ADR 0015, increment 4).
 *
 * Task status used to mutate in place (the analysis flagged that the "who / why" of a transition
 * vanished at the write). This command makes "mark complete" a named operation that records ONE
 * decision: who completed it, the before/after status, and the manager auto-confirm. A manager-ROLE
 * completion auto-confirms it (status 'confirmed'); everyone else lands 'completed' awaiting a real
 * manager's confirmation.
 *
 * The caller (the completion util) still stops a running timer BEFORE invoking this, so the command
 * stays a pure status write (and avoids importing the timer code — which would cycle back here).
 *
 * Confirm authority is ROLE-based, never a per-task ownership claim. firestore.rules DENIES a worker
 * self-confirming an existing task (`changesApprovalFields`), so the previous "own manager"
 * (uid === task.managerId) auto-confirm only produced a SILENT permission-denied when a worker named
 * as a task's manager finished it — the whole finish failed instead of landing 'completed'.
 * resolveCompletionStatus keys off the actor's role alone (the shared source for this command AND the
 * timer's "Užbaigti"), so a worker — even one who is the task's managerId — lands 'completed', and the
 * two finish doors stay aligned with each other and with the rule.
 *
 * Input:  { task }  (the actor supplies the acting user's id + role)
 * Effect: the task's completion/confirmation fields; one decision_log entry.
 */

const buildPlan = (input, actor) => {
  const task = input && input.task;
  if (!task || !task.id) throw new Error('completeTask: a task with an id is required');
  const status = resolveCompletionStatus(actor.role);
  const isConfirmed = status === 'confirmed';
  const nowIso = new Date().toISOString();

  const payload = {
    completed: true,
    completedAt: nowIso,
    completedBy: actor.id,
    status,
    confirmedBy: isConfirmed ? actor.id : null,
    confirmedAt: isConfirmed ? nowIso : null,
    // Pin the timer off on completion (the caller has already paused a running one).
    timerStatus: 'paused',
    timerStartedAt: null,
    updatedAt: nowIso,
  };

  return {
    targetId: task.id,
    summary: `Complete task "${task.title || task.id}" -> ${status}`,
    before: { status: task.status || null, completed: !!task.completed },
    after: { status, completed: true, completedBy: actor.id },
    payload,
  };
};

export const completeTask = defineCommand({
  name: 'completeTask',
  targetType: 'task',
  authorize: (input, { actor, mode }) => {
    if (isAgent(actor) && mode === MODES.COMMIT) {
      return 'agent-commit-not-permitted: an AI agent may propose completing a task but not commit it yet';
    }
    return true;
  },
  plan: (input, ctx) => buildPlan(input, ctx.actor),
  apply: async (planned) => {
    try {
      await updateDoc(doc(db, 'tasks', planned.targetId), planned.payload);
    } catch (err) {
      logError(err, { source: 'commands.completeTask' });
      throw err;
    }
  },
});

export const __buildCompletePlan = buildPlan;
