import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { SNOOZE_FIELDS } from './taskSnooze';

/**
 * Snooze writes — a single raw `updateDoc` to the task, the same pattern as the attention flags
 * (taskFlagActions.js). None of the snooze fields is a manager-only approval field, so the
 * assignee may write them through the existing `tasks` UPDATE rule on an approved (edit-locked)
 * task, and a manager through their scope branch. See taskSnooze.js for the field contract.
 */

const actorName = (currentUser) => currentUser?.displayName || currentUser?.email || 'Meistras';

/** Park the task until `untilIso`, stamping who did it and arming the server's return push. */
export const snoozeTask = async (task, untilIso, reason, currentUser) => {
    if (!task?.id || !currentUser?.uid || !untilIso) return;
    const now = new Date().toISOString();
    await updateDoc(doc(db, 'tasks', task.id), {
        snoozedUntil: untilIso,
        snoozedBy: currentUser.uid,
        snoozedByName: actorName(currentUser),
        snoozedAt: now,
        snoozeReason: reason || null,
        snoozeWakePending: true,
        updatedAt: now,
    });
};

/** Bring the task back now and disarm the return push. */
export const unsnoozeTask = async (task) => {
    if (!task?.id) return;
    await updateDoc(doc(db, 'tasks', task.id), {
        ...Object.fromEntries(SNOOZE_FIELDS.map((field) => [field, null])),
        snoozeWakePending: false,
        updatedAt: new Date().toISOString(),
    });
};

/** The task's current snooze fields — what an undo writes back. */
export const captureSnoozeState = (task) =>
    Object.fromEntries(SNOOZE_FIELDS.map((field) => [field, task?.[field] ?? null]));

/** Undo: restore a captured snooze state exactly (including "not snoozed"). */
export const restoreSnoozeState = async (task, prior) => {
    if (!task?.id) return;
    await updateDoc(doc(db, 'tasks', task.id), {
        ...prior,
        updatedAt: new Date().toISOString(),
    });
};
