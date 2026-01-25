import { doc, updateDoc, collection, query, where, getDocs, addDoc, setDoc, deleteDoc, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { parseTimeStringToMinutes, formatMinutesToTimeString } from './timeUtils';

/**
 * Updates the user's work status in Firestore.
 */
const updateUserWorkStatus = async (userId, isWorking, status, taskId) => {
    if (!userId) return;
    try {
        await updateDoc(doc(db, 'users', userId), {
            workStatus: {
                isWorking,
                status, // 'running', 'paused', 'idle'
                activeTaskId: taskId,
                lastUpdated: new Date().toISOString()
            },
            // Sync with generic Session Logic
            activeSession: (isWorking && status === 'running') ? {
                type: 'task',
                startTime: new Date().toISOString(),
                taskId: taskId,
                taskTitle: null // We don't have title here broadly, but it's okay, UI fetches task
            } : null // Clear if paused/idle
        });
    } catch (err) {
        console.error("Error updating user work status:", err);
    }
};

/**
 * Starts a task.
 * @param {Object} task - The task to start.
 * @param {string} userId - The user ID.
 */
export const startTask = async (task, userId) => {
    try {
        // 1. Pause others
        await pauseOtherTasks(userId, task.id);

        // 2. Update Task
        await updateDoc(doc(db, 'tasks', task.id), {
            timerStatus: 'running',
            timerStartedAt: new Date().toISOString(),
            status: 'in-progress',
            updatedAt: new Date().toISOString()
        });

        // 3. Update User Status
        await updateUserWorkStatus(userId, true, 'running', task.id);


    } catch (err) {
        console.error("Error starting task:", err);
        throw err;
    }
};

/**
 * Pauses a task, calculating elapsed time and updating the database.
 * @param {Object} task - The task object to pause.
 * @returns {Promise<void>}
 */
export const pauseTask = async (task) => {
    if (!task.timerStartedAt || task.timerStatus !== 'running') return;

    try {
        const now = new Date();
        const start = new Date(task.timerStartedAt);
        const elapsedMinutes = (now - start) / (1000 * 60); // minutes using float for precision

        // 1. Get current Timer Minutes
        const currentTimerMinutes = task.timerMinutes || 0;
        const newTimerMinutes = (elapsedMinutes > (10 / 60))
            ? currentTimerMinutes + elapsedMinutes
            : currentTimerMinutes;

        // 2. Get current Manual Minutes (backwards compat)
        const totalCurrentMinutes = parseTimeStringToMinutes(task.actualTime || '0m');
        const currentManualMinutes = task.manualMinutes !== undefined
            ? task.manualMinutes
            : Math.max(0, totalCurrentMinutes - currentTimerMinutes);

        await updateDoc(doc(db, 'tasks', task.id), {
            timerStatus: 'paused',
            timerStartedAt: null,
            timerMinutes: newTimerMinutes,
            manualMinutes: currentManualMinutes,
            updatedAt: new Date().toISOString()
        });

        // Update User Status to Paused
        // We assume if we pause a task, we go to "paused" state.
        // If pauseOtherTasks called this, the subsequent startTask will overwrite this to running.
        await updateUserWorkStatus(task.assignedWorkerId, false, 'paused', task.id);

        // 4. Log Work Session (NEW)
        if (elapsedMinutes > (10 / 60)) { // Only log meaningful sessions (> 10 seconds)
            try {
                const sessionDate = start.toISOString().split('T')[0];
                await addDoc(collection(db, 'work_sessions'), {
                    taskId: task.id,
                    taskTitle: task.title || 'Unknown Task',
                    workerId: task.assignedWorkerId,
                    workerName: task.assignedWorkerName || null,
                    startTime: start.toISOString(),
                    endTime: now.toISOString(),
                    durationMinutes: elapsedMinutes,
                    date: sessionDate,
                    createdAt: new Date().toISOString()
                });

            } catch (logErr) {
                console.error("Error logging work session:", logErr);
            }
        }


    } catch (err) {
        console.error("Error pausing task:", err);
        throw err;
    }
};

/**
 * Resumes a paused task.
 * @param {Object} task - The task object to resume.
 * @param {string} userId - The user ID.
 * @returns {Promise<void>}
 */
export const resumeTask = async (task, userId) => {
    try {
        // 1. Pause others
        await pauseOtherTasks(userId, task.id);

        // 2. Update Task
        await updateDoc(doc(db, 'tasks', task.id), {
            timerStatus: 'running',
            timerStartedAt: new Date().toISOString(),
            status: 'in-progress',
            updatedAt: new Date().toISOString()
        });

        // 3. Update User Status
        await updateUserWorkStatus(userId, true, 'running', task.id);


    } catch (err) {
        console.error("Error resuming task:", err);
        // Even if resume fails (e.g. network), we might want to suppress if it's just sync issue?
        // But for now, throw so UI can show error or we can catch it there.
        throw err;
    }
};

/**
 * Helper to get docs with cache fallback.
 */
const getDocsWithCacheFallback = async (q) => {
    try {
        // Try default (server first/smart)
        return await getDocs(q);
    } catch (err) {
        console.warn("Network fetch failed, attempting cache fallback...", err);
        // Fallback to cache
        // Note: getDocs({ source: 'cache' }) requires the query to perfectly match cached data or it might be empty
        // But for simple queries it often works.
        try {
            return await getDocs(q, { source: 'cache' });
        } catch (cacheErr) {
            console.error("Cache fallback also failed:", cacheErr);
            return { docs: [] }; // Return empty to not block
        }
    }
};

/**
 * Pauses all OTHER running tasks for a user, to ensure single threaded work.
 * @param {string} userId - The ID of the user.
 * @param {string} currentTaskId - The ID of the task that is about to start (to skip pausing it).
 * @returns {Promise<void>}
 */
export const pauseOtherTasks = async (userId, currentTaskId) => {
    try {
        const q = query(
            collection(db, 'tasks'),
            where('assignedWorkerId', '==', userId),
            where('timerStatus', '==', 'running')
        );

        // Use robust fetch
        const snapshot = await getDocsWithCacheFallback(q);

        const pausePromises = snapshot.docs
            .filter(doc => doc.id !== currentTaskId)
            .map(docSnap => {
                const taskData = { id: docSnap.id, ...docSnap.data() };
                return pauseTask(taskData);
            });

        if (pausePromises.length > 0) {

            // We use allSettled to ensure one failure doesn't stop others
            await Promise.allSettled(pausePromises);
        }
    } catch (err) {
        // Explicitly catch everything in pauseOtherTasks so it NEVER blocks startTask
        console.error("Error in pauseOtherTasks (non-fatal):", err);
    }
};
/**
 * Archives a task by moving it from 'tasks' to 'archived_tasks' collection.
 * @param {Object} task - The full task data.
 * @param {string} userId - The ID of the user performing the archive.
 * @returns {Promise<void>}
 */
export const archiveTask = async (task, userId) => {
    if (!task || !task.id) return;

    try {
        const { id, ...taskData } = task;

        // 1. Create document in archived_tasks
        await setDoc(doc(db, 'archived_tasks', id), {
            ...taskData,
            archivedAt: new Date().toISOString(),
            archivedBy: userId
        });

        // 2. Delete from tasks
        await deleteDoc(doc(db, 'tasks', id));


    } catch (err) {
        console.error("Error archiving task:", err);
        throw err;
    }
};

/**
 * Saves a new task template.
 * @param {string} templateName - The name of the template.
 * @param {Object} selectedData - The task data to save in the template.
 * @param {Object} user - The current user object.
 * @returns {Promise<void>}
 */
export const saveTaskTemplate = async (templateName, selectedData, user) => {
    try {
        await addDoc(collection(db, 'task_templates'), {
            templateName,
            data: selectedData,
            createdBy: user.uid,
            creatorName: user.displayName || user.email,
            createdAt: new Date().toISOString()
        });

    } catch (err) {
        console.error("Error saving template:", err);
        throw err;
    }
};

/**
 * Fetches all task templates.
 * @returns {Promise<Array>} Array of template objects.
 */
export const getTaskTemplates = async () => {
    try {
        const q = query(collection(db, 'task_templates'), orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (err) {
        console.error("Error fetching templates:", err);
        throw err;
    }
};

export const deleteTaskTemplate = async (templateId) => {
    try {
        await deleteDoc(doc(db, 'task_templates', templateId));

    } catch (err) {
        console.error("Error deleting template:", err);
        throw err;
    }
};

/**
 * Updates an existing task template.
 * @param {string} templateId - The ID of the template to update.
 * @param {string} templateName - The name of the template.
 * @param {Object} selectedData - The task data to save in the template.
 * @param {Object} user - The current user object.
 * @returns {Promise<void>}
 */
export const updateTaskTemplate = async (templateId, templateName, selectedData, user) => {
    try {
        await updateDoc(doc(db, 'task_templates', templateId), {
            templateName,
            data: selectedData,
            updatedBy: user.uid,
            updatedByName: user.displayName || user.email,
            updatedAt: new Date().toISOString()
        });

    } catch (err) {
        console.error("Error updating template:", err);
        throw err;
    }
};

/**
 * Deletes a task by marking it as completed with a deleted flag.
 * This allows it to appear in the Done Tasks window for manager confirmation.
 * @param {Object} task - The task to delete.
 * @param {string} userId - The user ID.
 */
export const deleteTask = async (task, userId) => {
    if (!task || !task.id) return;

    try {
        // 0. Handle Active Session if Running
        if (task.timerStatus === 'running') {
            try {
                // a. Pause to log session and calculate time
                await pauseTask(task);

                // b. Force User Status to Idle
                // pauseTask sets user to 'paused' on this task, but we are deleting it.
                // So we must reset user to idle.
                // We use the helper logic directly or the same update structure.
                if (task.assignedWorkerId) {
                    await updateUserWorkStatus(task.assignedWorkerId, false, 'idle', null);
                }

            } catch (pErr) {
                console.error("Error pausing active task before deletion:", pErr);
                // Continue with deletion even if pause fails, to avoid "undead" tasks
            }
        }

        // 1. Move to archived_tasks immediately with deleted flag
        const { id, ...taskData } = task;

        await setDoc(doc(db, 'archived_tasks', id), {
            ...taskData,
            status: 'deleted',
            completed: true,
            completedAt: new Date().toISOString(),
            isDeleted: true,
            deletedAt: new Date().toISOString(),
            deletedBy: userId,
            timerStatus: 'stopped',
            timerStartedAt: null,
            updatedAt: new Date().toISOString()
        });

        // 2. Delete from active tasks
        await deleteDoc(doc(db, 'tasks', id));

    } catch (err) {
        console.error("Error deleting task:", err);
        throw err;
    }
};

