import { isManagerRole } from './formatters';

/**
 * Single source of truth for "what may THIS user do to THIS task".
 *
 * The product rule (founder, 2026-06-24): a Vykdytojas (worker) owns a task they created
 * ONLY until a manager approves it. The creation gate `status === 'unapproved'` is exactly
 * that window. Once a manager approves it (any other status) — or when the task was created
 * by a manager in the first place — the task is LOCKED for the worker: they may then only
 * comment, tick checklist items, attach photos, and run the timer (start/pause/resume/finish).
 *
 * Managers/admins keep full edit access in every state.
 *
 * (Photo attaching + checklist ticking are gated where they live — TaskDetailModal's
 * `canManage || isAssignee` and the ChecklistModal's `canToggle` — because they are not "edits"
 * of the task definition and must survive the lock. This module owns only the edit gate.)
 */

// A worker may fully edit (open the TaskModal form) only their own, still-unapproved task.
// A deleted or completed task is never worker-editable.
export const canWorkerEditTask = (task, uid) =>
    !!task &&
    !!uid &&
    task.createdBy === uid &&
    (task.status || 'pending') === 'unapproved' &&
    !task.isDeleted &&
    !task.completed;

// Full edit access to the task form. Managers/admins always; a worker only on their own
// still-unapproved task. `role` is the surface role passed to the component; `userRole` is
// the viewer's account role — either being managerial grants edit (mirrors existing checks).
export const canEditTask = ({ task, currentUser, role, userRole } = {}) => {
    if (!task || !currentUser) return false;
    if (isManagerRole(role) || isManagerRole(userRole)) return true;
    return canWorkerEditTask(task, currentUser.uid);
};
