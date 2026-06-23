import { doc, updateDoc, deleteDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';
import { logError } from '../../utils/errorLog';
import { defineCommand, MODES } from '../command';
import { isAgent } from '../actor';

/**
 * deleteTask — remove a task, as an audited decision (ADR 0015, increment 6). Deletion is one of the
 * most consequential mutations and was previously unattributed; this records WHO deleted WHAT and in
 * WHICH mode on the decision_log spine.
 *
 * Two modes (preserved verbatim from the prior util):
 *   • keepWorkHours — soft delete: mark the task completed+deleted IN PLACE (tasks, or archived_tasks
 *     if already archived), auto-confirming for a manager, so it shows struck-through today and the
 *     nightly archiver moves it. The logged hours survive.
 *   • else (hard) — remove the task from tasks + archived_tasks and mark its work_sessions deleted.
 *
 * The caller (the deleteTask util) pauses a running timer and resolves the actor's role/name BEFORE
 * invoking this (so the command needn't import the timer code and cycle); `isManager` is passed in.
 *
 * Input:  { task, keepWorkHours:boolean, isManager:boolean }
 * Effect: the soft/hard delete writes; one decision_log entry.
 */

const buildPlan = (input) => {
  const task = input && input.task;
  if (!task || !task.id) throw new Error('deleteTask: a task with an id is required');
  const keepWorkHours = !!input.keepWorkHours;
  return {
    targetId: task.id,
    summary: `Delete task "${task.title || task.id}" (${keepWorkHours ? 'kept hours' : 'hard'})`,
    before: { status: task.status || null, isDeleted: !!task.isDeleted },
    after: { isDeleted: true, mode: keepWorkHours ? 'kept-hours' : 'hard' },
  };
};

export const deleteTask = defineCommand({
  name: 'deleteTask',
  targetType: 'task',
  authorize: (input, { actor, mode }) => {
    if (isAgent(actor) && mode === MODES.COMMIT) {
      return 'agent-commit-not-permitted: an AI agent may propose deleting a task but not commit it yet';
    }
    return true;
  },
  plan: (input) => buildPlan(input),
  apply: async (planned, input, { actor }) => {
    const { task, keepWorkHours, isManager } = input;
    const id = task.id;
    try {
      if (keepWorkHours) {
        // Soft delete — mark completed+deleted in place (the nightly archiver moves it later).
        const now = new Date().toISOString();
        if (task.isArchived) {
          await updateDoc(doc(db, 'archived_tasks', id), {
            status: 'deleted', completed: true, completedAt: now,
            isDeleted: true, deletedAt: now, deletedBy: actor.id,
            timerStatus: 'stopped', timerStartedAt: null, updatedAt: now,
          });
        } else {
          await updateDoc(doc(db, 'tasks', id), {
            status: isManager ? 'confirmed' : 'completed', completed: true, completedAt: now,
            confirmedBy: isManager ? actor.id : null, confirmedAt: isManager ? now : null,
            isDeleted: true, deletedAt: now, deletedBy: actor.id,
            timerStatus: 'stopped', timerStartedAt: null, updatedAt: now,
          });
        }
      } else {
        // Hard delete — remove from both collections, then mark sessions deleted.
        if (!task.isArchived) await deleteDoc(doc(db, 'tasks', id));
        await deleteDoc(doc(db, 'archived_tasks', id));
        // Session marking is best-effort: a failure here must not undo the delete that already
        // happened (mirrors the prior util's inner try/catch).
        try {
          const sessionsSnap = await getDocs(query(collection(db, 'work_sessions'), where('taskId', '==', id)));
          await Promise.all(sessionsSnap.docs.map((s) =>
            updateDoc(doc(db, 'work_sessions', s.id), { isDeleted: true, deletedAt: new Date().toISOString() })));
        } catch (sessionErr) {
          logError(sessionErr, { source: 'commands.deleteTask.markSessions' });
        }
      }
    } catch (err) {
      logError(err, { source: 'commands.deleteTask' });
      throw err;
    }
  },
});

export const __buildDeletePlan = buildPlan;
