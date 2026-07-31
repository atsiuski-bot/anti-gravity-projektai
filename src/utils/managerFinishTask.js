import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { completeTask, humanActor, MODES } from '../domain';
import { endSessionForUser } from './sessionAdmin';
import { pauseTask } from './taskActions';
import { formatMinutesToTimeString } from './timeUtils';
import { isManagerRole } from './formatters';
import { notify } from './notify';
import { logError } from './errorLog';

/**
 * finishTaskForAssignee — a koordinatorius closes a Meistras's task on their behalf, and hands it in.
 *
 * The timer's own "Užbaigti" is assignment-only (only the person working may drive their own timer),
 * so a job the Meistras finished on site but never ended had NO closing door: it stayed in the active
 * list, kept its session alive, and never reached Pridavimas. This is that door, and it is deliberately
 * a THREE-step composition rather than a bare status write:
 *
 *  1. SETTLE the live run first, so the open stretch is credited to the Meistras before the task is
 *     pinned closed. Which settle applies is not ours to decide — endSessionForUser already picks the
 *     canonical force-end plan or the legacy pause, whichever engine the run belongs to. It is invoked
 *     ONLY when the Meistras's live run actually points at THIS task; force-ending them while they are
 *     on something else would destroy unrelated time. The orphan case (the task says "running" but no
 *     session points at it) falls back to pauseTask, which logs the open segment — without it those
 *     minutes would be silently dropped by the completion write's timerStartedAt: null.
 *  2. COMPLETE through the audited domain command, so the auto-confirm rule and the decision_log entry
 *     stay in the one place every other finish door uses. A koordinatorius's completion auto-confirms
 *     (status 'confirmed') — finishing and priėmimas in one action, which is what closing someone
 *     else's finished work means. If the rules deny that flip (the caller is not this task's overseer
 *     after all), we re-issue as a plain 'completed' so the task still closes and simply waits for its
 *     proper overseer — the same fallback performFinish and completeTaskAtLimit already perform.
 *  3. TELL the Meistras. Their task disappearing from their list without a word is the one outcome
 *     this must not have.
 *
 * @param {Object} task                    the task being closed (must carry assignedUserId)
 * @param {Object} ctx
 * @param {Object} ctx.currentUser         the signed-in koordinatorius (uid/displayName/email)
 * @param {string} ctx.userRole            their app role — the auto-confirm rule reads THIS, not auth
 * @returns {Promise<{status: string, totalMinutes: number}>}
 */
export const finishTaskForAssignee = async (task, { currentUser, userRole }) => {
    if (!task?.id || !task.assignedUserId) throw new Error('finishTaskForAssignee: an assigned task is required');
    const assigneeId = task.assignedUserId;

    // 1. Settle whatever is still running for this task.
    let liveRunIsThisTask = false;
    try {
        const activeSnap = await getDoc(doc(db, 'active_sessions', assigneeId));
        const record = activeSnap.exists() ? activeSnap.data() : null;
        liveRunIsThisTask = record?.status === 'active'
            && record?.run?.type === 'task'
            && record?.run?.taskId === task.id;

        let assignee = null;
        if (!liveRunIsThisTask) {
            const userSnap = await getDoc(doc(db, 'users', assigneeId));
            assignee = userSnap.exists() ? { id: assigneeId, ...userSnap.data() } : null;
            liveRunIsThisTask = assignee?.activeSession?.taskId === task.id
                || assignee?.workStatus?.activeTaskId === task.id;
        }

        if (liveRunIsThisTask) {
            // endSessionForUser re-reads the target server-first and settles THAT copy, so passing the
            // bare id is enough — and is the safer input, since our snapshot may already be stale.
            await endSessionForUser(assignee || { id: assigneeId }, { actorId: currentUser?.uid });
        } else if (task.timerStatus === 'running') {
            await pauseTask(task);
        }
    } catch (err) {
        // A failed settle must NOT be swallowed: completing on top of it would pin timerStartedAt to
        // null and lose the open stretch for good. Surface it so the caller keeps the task open.
        logError(err, { source: 'finishTaskForAssignee.settle', taskId: task.id, code: err?.code });
        throw err;
    }

    // Re-read the task: the settle just credited minutes to it, so our snapshot's counters are stale
    // and the actualTime derived from them would under-report the work.
    let fresh = task;
    try {
        const snap = await getDoc(doc(db, 'tasks', task.id));
        if (snap.exists()) fresh = { id: snap.id, ...snap.data() };
    } catch (err) {
        logError(err, { source: 'finishTaskForAssignee.refetch', taskId: task.id });
    }
    const totalMinutes = (fresh.timerMinutes || 0) + (fresh.manualMinutes || 0);
    const formattedTime = formatMinutesToTimeString(totalMinutes);

    // 2. Audited completion.
    const actor = humanActor({
        uid: currentUser?.uid,
        displayName: currentUser?.displayName,
        email: currentUser?.email,
        role: userRole,
    });
    let result;
    try {
        result = await completeTask({ task: fresh }, {
            actor,
            mode: MODES.COMMIT,
            reason: 'finished by the overseeing koordinatorius on the assignee\'s behalf',
        });
    } catch (err) {
        if (err?.code !== 'permission-denied' || !isManagerRole(userRole)) throw err;
        logError(err, { source: 'finishTaskForAssignee.autoConfirmDenied', taskId: task.id });
        result = await completeTask({ task: fresh }, {
            actor: { ...actor, role: null },
            mode: MODES.COMMIT,
            reason: 'finished on the assignee\'s behalf (auto-confirm denied — awaiting overseer acceptance)',
        });
    }
    const status = result?.effect?.after?.status || 'completed';

    // The displayed total + the alarm latch are not the command's to own (same split as
    // completeTaskAtLimit). Best-effort: the task IS closed, so a failure here is cosmetic.
    try {
        await updateDoc(doc(db, 'tasks', task.id), {
            actualTime: formattedTime,
            timeLimitReached: false,
            updatedAt: new Date().toISOString(),
        });
    } catch (err) {
        logError(err, { source: 'finishTaskForAssignee.actualTime', taskId: task.id });
    }

    // 3. Tell the Meistras their task was closed for them. 'confirmed' is the whole story in one
    // notice ("užbaigta ir priimta"); on the denied-flip fallback the task still awaits a real
    // priėmimas, so the proper overseer is pinged instead — exactly as a worker's own finish does.
    await notify({
        recipientId: assigneeId,
        type: 'task_confirmed',
        taskId: task.id,
        taskTitle: task.title || 'Užduotis',
        actorUid: currentUser?.uid,
        actorName: currentUser?.displayName || currentUser?.email,
    });
    if (status !== 'confirmed' && task.managerId && task.managerId !== currentUser?.uid) {
        await notify({
            recipientId: task.managerId,
            type: 'task_completion',
            taskId: task.id,
            taskTitle: task.title || 'Užduotis',
            actualTime: formattedTime,
            actualMinutes: totalMinutes,
            userName: task.assignedUserName || 'Meistras',
            actorUid: currentUser?.uid,
            actorName: currentUser?.displayName || currentUser?.email,
            completedAt: new Date().toISOString(),
        });
    }

    return { status, totalMinutes };
};
