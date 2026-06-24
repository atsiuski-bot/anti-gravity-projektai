import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { notify } from './notify';
import { TASK_FLAGS } from './taskFlags';

/**
 * Toggle one worker-set attention flag ("Reikia vadovo" / "Laukiama") on a task.
 *
 * Mirrors the checklist / comment pattern: a single raw `updateDoc` to the task document. The
 * assigned worker may already write their own task (firestore.rules `tasks` UPDATE) as long as the
 * write does not flip a manager-only approval field — and a flag is not one — so this needs no
 * rules change and works even on a manager-approved (otherwise edit-locked) task, exactly like
 * ticking a checklist item.
 *
 * Turning a flag ON stamps who/when and PINGS the task's manager so they learn a tag was raised and
 * by whom (the actor rides as `createdBy`/`createdByName`). The manager is resolved like a task
 * completion: the task's own `managerId` (or `taskAuditor`), else the worker's `defaultManager`.
 * notify() drops a self-notification, so a self-managed worker never pings themselves. Turning a
 * flag OFF clears the stamp and notifies no one (a flag being cleared is not news).
 *
 * @param {Object}  task               the live task document ({ id, managerId, title, ... })
 * @param {string}  flagKey            'needsManager' | 'waiting'
 * @param {boolean} nextValue          the desired flag value
 * @param {Object}  currentUser        { uid, displayName, email } — the actor raising/clearing it
 * @param {Object}  [opts]
 * @param {string}  [opts.collectionName='tasks']  'tasks' or 'archived_tasks'
 * @param {string}  [opts.defaultManagerId=null]   fallback recipient (the worker's defaultManager)
 */
export const setTaskFlag = async (
    task,
    flagKey,
    nextValue,
    currentUser,
    { collectionName = 'tasks', defaultManagerId = null } = {},
) => {
    const flag = TASK_FLAGS[flagKey];
    if (!flag || !task?.id || !currentUser?.uid) return;

    const on = !!nextValue;
    const now = new Date().toISOString();
    const actorName = currentUser.displayName || currentUser.email || 'Vykdytojas';

    await updateDoc(doc(db, collectionName, task.id), {
        [flag.field]: on,
        [flag.setByField]: on ? currentUser.uid : null,
        [flag.setByNameField]: on ? actorName : null,
        [flag.setAtField]: on ? now : null,
        updatedAt: now,
    });

    // Raising a flag is the only event the manager is told about; clearing it is silent.
    if (!on) return;

    // Route to the task's manager, falling back to the worker's default manager (mirrors the task
    // completion ping). A self-managed worker (recipient === actor) is dropped by notify().
    let recipientId = task.managerId || task.taskAuditor || null;
    if (!recipientId || recipientId === currentUser.uid) recipientId = defaultManagerId || null;
    if (!recipientId || recipientId === currentUser.uid) return;

    await notify({
        recipientId,
        type: flag.notifyType,
        taskId: task.id,
        taskTitle: task.title || 'Užduotis',
        actorUid: currentUser.uid,
        actorName,
    });
};
