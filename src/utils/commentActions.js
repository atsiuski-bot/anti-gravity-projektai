import { doc, updateDoc, getDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../firebase';
import { notifyMany } from './notify';

/**
 * Stable identity for a comment: its own `id` when present (comments created after this change),
 * otherwise its `createdAt` (legacy / other-path comments). Edit and delete address a comment by
 * this key — never by a positional index that could drift onto the wrong comment if the array
 * shifts, and never by `createdAt` alone, which two comments posted in the same millisecond could
 * share. New comments carry a collision-proof `id`, so the key is genuinely unique for them.
 * @param {Object} comment
 * @returns {string|undefined}
 */
export const getCommentKey = (comment) => comment?.id ?? comment?.createdAt;

/**
 * Adds a new comment to a task.
 * @param {string} taskId 
 * @param {string} text 
 * @param {Object} currentUser 
 * @param {Array} _currentComments - the caller's snapshot of the thread. Deliberately UNUSED: the
 *   write appends server-side (see arrayUnion below). Kept in the signature so the existing
 *   positional call sites stay valid.
 * @returns {Promise<void>}
 */
export const addComment = async (taskId, text, currentUser, _currentComments = null, collectionName = 'tasks') => {
    try {
        // Read the task only for the notification below (title + the two parties). The comment
        // WRITE deliberately does not depend on this read — see arrayUnion.
        let taskData = null;
        const taskDoc = await getDoc(doc(db, collectionName, taskId));
        if (taskDoc.exists()) {
            taskData = taskDoc.data();
        }

        const newComment = {
            // Collision-proof identity so edit/delete can never address the wrong comment, even if
            // two are posted in the same millisecond (see getCommentKey).
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            text: text,
            user: currentUser.displayName || currentUser.email,
            userId: currentUser.uid,
            createdAt: new Date().toISOString()
        };

        const taskRef = doc(db, collectionName, taskId);
        await updateDoc(taskRef, {
            // APPEND server-side — never rewrite the array. Every caller hands us a `comments`
            // snapshot frozen when its view rendered (a modal opened minutes ago, a list row), so
            // writing that array back DELETES whatever the other party posted meanwhile — a
            // message the recipient was already notified about, gone with no error on either side.
            // arrayUnion cannot clobber, keeps append order, and still queues correctly offline.
            comments: arrayUnion(newComment),
            updatedAt: new Date().toISOString()
        });

        // Notify the OTHER party so the thread reaches them in their bell: the assigned manager
        // when the commenter isn't the manager, AND the worker when the commenter isn't the
        // worker. This makes a manager's comment reach the worker (two-way) without ever echoing
        // back to the author (notifyMany drops the actor and de-dupes).
        if (taskData) {
            await notifyMany([taskData.managerId, taskData.assignedUserId], {
                type: 'new_comment',
                taskId,
                taskTitle: taskData.title,
                commentText: text,
                actorUid: currentUser.uid,
                actorName: currentUser.displayName || currentUser.email,
            });
        }
    } catch (err) {
        console.error("Error adding comment:", err);
        throw err; // Re-throw to let UI handle alerts
    }
};

/**
 * Updates an existing comment, addressed by its stable `createdAt` key rather than a positional
 * index. A render-time index can point at the wrong comment if the array shifted (a concurrent
 * add/delete on the same task) before the write lands; matching on the comment's own identity
 * always hits the intended one — or no-ops if it is already gone.
 * @param {string} taskId
 * @param {string} commentKey - the target comment's `createdAt`
 * @param {string} newText
 * @param {Array} currentComments
 * @returns {Promise<void>}
 */
export const updateComment = async (taskId, commentKey, newText, currentComments, collectionName = 'tasks') => {
    if (!currentComments) return;

    try {
        const idx = currentComments.findIndex((c) => getCommentKey(c) === commentKey);
        if (idx === -1) return;

        const updatedComments = currentComments.map((c, i) =>
            i === idx ? { ...c, text: newText, updatedAt: new Date().toISOString() } : c
        );

        await updateDoc(doc(db, collectionName, taskId), {
            comments: updatedComments,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error("Error updating comment:", err);
        throw err;
    }
};

/**
 * Deletes a comment, addressed by its stable `createdAt` key (see updateComment). Splicing the
 * first match removes exactly one comment — filtering by key could drop two on the (vanishing)
 * chance of duplicate keys, and an index could remove the wrong one after an array shift.
 * @param {string} taskId
 * @param {string} commentKey - the target comment's `createdAt`
 * @param {Array} currentComments
 * @returns {Promise<void>}
 */
export const deleteComment = async (taskId, commentKey, currentComments, collectionName = 'tasks') => {
    if (!currentComments) return;

    try {
        const idx = currentComments.findIndex((c) => getCommentKey(c) === commentKey);
        if (idx === -1) return;

        const updatedComments = [...currentComments.slice(0, idx), ...currentComments.slice(idx + 1)];
        await updateDoc(doc(db, collectionName, taskId), {
            comments: updatedComments,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error("Error deleting comment:", err);
        throw err;
    }
};
