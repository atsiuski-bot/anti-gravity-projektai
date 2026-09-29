import { doc, updateDoc, setDoc, deleteDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { db } from '../firebase';
import { revertTask } from './taskActions';
import { addComment } from './commentActions';
import { notify } from './notify';
import { buildRestoredTaskPayload } from '../components/TaskHistory';

/**
 * REVIEW SHELF ("Peržiūrai") — a manager's personal list of tasks they want to look at again later,
 * independent of the acceptance gate. Accepting a task (Priimti) sends it to Istorija and, overnight,
 * into the archive, which is exactly where a manager who "needs this result later" then has to dig
 * for it. The shelf keeps a pointer to the task instead, so it stays one tap away whatever status or
 * collection the task moves through, until the manager marks it reviewed.
 *
 * DECISION 2026-09-29: the shelf is an array of task ids on the manager's OWN users doc
 * (`reviewShelf`), not a flag on the task and not a new subcollection. Rules are not row filters: a
 * scoped manager cannot list /tasks by a "watched by me" field (the query cannot prove each row is in
 * their team, and Firestore allows only one array-contains per query, which the team scope already
 * uses). A pointer list on the user doc is readable live through the existing userData listener,
 * each task is then read by id (a per-document get the read rules already allow), and the owner may
 * already write non-admin fields on their own doc — so this ships with NO rules change and no deploy.
 * The ids are not confidential; the user doc's broad read is acceptable for them.
 */
export const REVIEW_SHELF_FIELD = 'reviewShelf';

/** The shelved task ids from a users doc (always an array of strings). */
export function getShelfIds(userData) {
    const raw = userData?.[REVIEW_SHELF_FIELD];
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && id) : [];
}

/**
 * Put a task on (or take it off) the caller's shelf. arrayUnion/arrayRemove, never a whole-array
 * write: the same users doc is written by the timer on every start/pause, and two devices may shelve
 * at once — a read-modify-write of the array would drop one of the edits.
 */
export async function setOnReviewShelf(uid, taskId, on) {
    if (!uid || !taskId) throw new Error('setOnReviewShelf: uid and taskId are required');
    await updateDoc(doc(db, 'users', uid), {
        [REVIEW_SHELF_FIELD]: on ? arrayUnion(taskId) : arrayRemove(taskId),
    });
}

/**
 * "Grąžinti papildyti" — send a finished (or already accepted / archived) task back to its Meistras
 * with a required note saying what to add. Three writes, in this order:
 *   1. reopen the task onto the active list — the SAME write the existing Grąžinti buttons use
 *      (the audited reopenTask for a live task; the archive-restore payload for an archived one),
 *   2. append the note to the task's comment thread, so it stays on the task where the Meistras
 *      works (its own notification suppressed — see 3),
 *   3. ONE task_reverted notice to the Meistras carrying the note, so they get a single "returned,
 *      here is why" instead of a "returned" ping plus a separate "new comment" ping.
 * The reopen is the only write the rest depends on: if it fails nothing else is attempted. A
 * failure of the note after it is reported as `partial` so the caller can say the task came back but
 * the note did not.
 *
 * @param {Object} args
 * @param {Object} args.task  the task as shown on the shelf; `isArchived` marks an archived_tasks row
 * @param {string} args.text  the manager's note (required)
 * @param {Object} args.user  the signed-in manager ({ uid, displayName, email })
 * @returns {Promise<{ ok: true, partial: boolean }>}
 */
export async function returnTaskForAddition({ task, text, user }) {
    const note = String(text || '').trim();
    if (!task?.id) throw new Error('returnTaskForAddition: a task with an id is required');
    if (!note) throw new Error('returnTaskForAddition: a note is required');

    if (task.isArchived) {
        // Same shape the Pridavimas / Užduočių istorija restore writes (canonicalised so the /tasks
        // create rule accepts it). The shelf's own display flag and the id are not task fields.
        const stored = { ...task };
        delete stored.id;
        delete stored.isArchived;
        await setDoc(doc(db, 'tasks', task.id), buildRestoredTaskPayload(stored));
        await deleteDoc(doc(db, 'archived_tasks', task.id));
    } else {
        await revertTask(task, user);
    }

    let partial = false;
    try {
        await addComment(task.id, note, user, null, 'tasks', { notify: false });
    } catch {
        partial = true;
    }
    // notify() never throws (it logs its own failure), so it cannot turn a done return into an error.
    await notify({
        recipientId: task.assignedUserId,
        type: 'task_reverted',
        taskId: task.id,
        taskTitle: task.title || 'Užduotis',
        commentText: note,
        actorUid: user.uid,
        actorName: user.displayName || user.email,
    });
    return { ok: true, partial };
}
