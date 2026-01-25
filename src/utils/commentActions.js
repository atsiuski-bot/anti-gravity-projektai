import { doc, updateDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { formatDisplayName } from './formatters';

/**
 * Adds a new comment to a task.
 * @param {string} taskId 
 * @param {string} text 
 * @param {Object} currentUser 
 * @param {Array} currentComments - Optional, if known, to avoid fetching
 * @returns {Promise<void>}
 */
export const addComment = async (taskId, text, currentUser, currentComments = null) => {
    try {
        let comments = currentComments;

        // If comments not provided, fetch current task data
        if (!comments) {
            const taskDoc = await getDoc(doc(db, 'tasks', taskId));
            if (taskDoc.exists()) {
                comments = taskDoc.data().comments || [];
            } else {
                comments = [];
            }
        }

        const newComment = {
            text: text,
            user: currentUser.displayName || currentUser.email,
            userId: currentUser.uid,
            createdAt: new Date().toISOString()
        };

        const taskRef = doc(db, 'tasks', taskId);
        await updateDoc(taskRef, {
            comments: [...comments, newComment],
            updatedAt: new Date().toISOString()
        });
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
export const updateComment = async (taskId, commentIndex, newText, currentComments) => {
    if (!currentComments) return;

    try {
        const updatedComments = [...currentComments];
        if (updatedComments[commentIndex]) {
            updatedComments[commentIndex] = {
                ...updatedComments[commentIndex],
                text: newText,
                updatedAt: new Date().toISOString()
            };

            await updateDoc(doc(db, 'tasks', taskId), {
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
export const deleteComment = async (taskId, commentIndex, currentComments) => {
    if (!currentComments) return;

    try {
        const updatedComments = currentComments.filter((_, i) => i !== commentIndex);
        await updateDoc(doc(db, 'tasks', taskId), {
            comments: updatedComments,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error("Error deleting comment:", err);
        throw err;
    }
};
