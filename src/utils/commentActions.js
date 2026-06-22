import { doc, updateDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { notifyMany } from './notify';

/**
 * Adds a new comment to a task.
 * @param {string} taskId 
 * @param {string} text 
 * @param {Object} currentUser 
 * @param {Array} currentComments - Optional, if known, to avoid fetching
 * @returns {Promise<void>}
 */
export const addComment = async (taskId, text, currentUser, currentComments = null, collectionName = 'tasks') => {
    try {
        let comments = currentComments;
        let taskData = null;

        // If comments not provided, fetch current task data
        const taskDoc = await getDoc(doc(db, collectionName, taskId));
        if (taskDoc.exists()) {
            taskData = taskDoc.data();
            if (!comments) {
                comments = taskData.comments || [];
            }
        } else {
            if (!comments) comments = [];
        }

        const newComment = {
            text: text,
            user: currentUser.displayName || currentUser.email,
            userId: currentUser.uid,
            createdAt: new Date().toISOString()
        };

        const taskRef = doc(db, collectionName, taskId);
        await updateDoc(taskRef, {
            comments: [...comments, newComment],
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
 * Updates an existing comment.
 * @param {string} taskId 
 * @param {number} commentIndex 
 * @param {string} newText 
 * @param {Array} currentComments 
 * @returns {Promise<void>}
 */
export const updateComment = async (taskId, commentIndex, newText, currentComments, collectionName = 'tasks') => {
    if (!currentComments) return;

    try {
        const updatedComments = [...currentComments];
        if (updatedComments[commentIndex]) {
            updatedComments[commentIndex] = {
                ...updatedComments[commentIndex],
                text: newText,
                updatedAt: new Date().toISOString()
            };

            await updateDoc(doc(db, collectionName, taskId), {
                comments: updatedComments,
                updatedAt: new Date().toISOString()
            });
        }
    } catch (err) {
        console.error("Error updating comment:", err);
        throw err;
    }
};

/**
 * Deletes a comment.
 * @param {string} taskId 
 * @param {number} commentIndex 
 * @param {Array} currentComments 
 * @returns {Promise<void>}
 */
export const deleteComment = async (taskId, commentIndex, currentComments, collectionName = 'tasks') => {
    if (!currentComments) return;

    try {
        const updatedComments = currentComments.filter((_, i) => i !== commentIndex);
        await updateDoc(doc(db, collectionName, taskId), {
            comments: updatedComments,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error("Error deleting comment:", err);
        throw err;
    }
};
