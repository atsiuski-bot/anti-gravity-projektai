import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { isManagerRole } from './formatters';

/**
 * Sanitizes a task data object by removing undefined values,
 * which would cause Firestore assertion errors.
 * 
 * @param {Object} data - Task data to sanitize
 * @returns {Object} Sanitized data
 */
const sanitizeTaskData = (data) => {
    const clean = { ...data };
    Object.keys(clean).forEach(key => clean[key] === undefined && delete clean[key]);
    return clean;
};

/**
 * Toggles a task's completion status.
 * Handles manager auto-confirmation and data sanitization.
 * 
 * @param {Object} task - The task object
 * @param {string} userId - Current user's UID
 * @param {string} userRole - Current user's role ('manager', 'admin', 'worker')
 * @param {string} [taskManagerId] - The task's assigned manager ID (for task-level manager check)
 * @returns {Promise<void>}
 */
export const toggleTaskCompletion = async (task, userId, userRole, taskManagerId) => {
    const willBeCompleted = !task.completed;
    const isManagerOrAdmin = isManagerRole(userRole) || userId === taskManagerId;

    const taskData = sanitizeTaskData({
        completed: willBeCompleted,
        completedAt: willBeCompleted ? new Date().toISOString() : null,
        completedBy: willBeCompleted ? userId : null,
        status: willBeCompleted ? (isManagerOrAdmin ? 'confirmed' : 'completed') : 'pending',
        confirmedBy: willBeCompleted && isManagerOrAdmin ? userId : null,
        confirmedAt: willBeCompleted && isManagerOrAdmin ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString()
    });

    await updateDoc(doc(db, 'tasks', task.id), taskData);
};

/**
 * Marks a task as completed (one-way, no toggle).
 * Used by swipe-left gesture.
 * 
 * @param {Object} task - The task object
 * @param {string} userId - Current user's UID
 * @param {string} userRole - Current user's role
 * @param {string} [taskManagerId] - The task's assigned manager ID
 * @returns {Promise<void>}
 */
export const completeTask = async (task, userId, userRole, taskManagerId) => {
    const isManagerOrAdmin = isManagerRole(userRole) || userId === taskManagerId;

    const taskData = sanitizeTaskData({
        status: isManagerOrAdmin ? 'confirmed' : 'completed',
        confirmedBy: isManagerOrAdmin ? userId : null,
        confirmedAt: isManagerOrAdmin ? new Date().toISOString() : null,
        completed: true,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    await updateDoc(doc(db, 'tasks', task.id), taskData);
};
