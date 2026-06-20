import { doc, updateDoc, collection, query, where, getDocs, getDoc, addDoc, setDoc, deleteDoc, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { parseTimeStringToMinutes, formatMinutesToTimeString, getLithuanianNow, getLithuanianDateString } from './timeUtils';
import { isManagerRole } from './formatters';
import { logError } from './errorLog';

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
            }
            // NOTE: activeSession is managed exclusively by sessionActions.js (startSession/endSession).
            // Previously this function also set activeSession, which caused a race condition:
            // startSession() would set activeSession to the new session (break/call/quick_work)
            // with the task stored in pausedSession, but then pauseTask() would fire and
            // overwrite activeSession to null, killing all session tracking.
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
        // 1. Pause others (must complete before starting new task)
        await pauseOtherTasks(userId, task.id);

        const now = new Date().toISOString();

        // 2. Update Task + User Status + activeSession in PARALLEL
        await Promise.all([
            updateDoc(doc(db, 'tasks', task.id), {
                timerStatus: 'running',
                timerStartedAt: now,
                startedAt: task.startedAt || now,
                status: 'in-progress',
                updatedAt: now
            }),
            updateDoc(doc(db, 'users', userId), {
                workStatus: {
                    isWorking: true,
                    status: 'running',
                    activeTaskId: task.id,
                    lastUpdated: now
                },
                // Set activeSession so ActiveWorkSessions widget shows the task immediately
                activeSession: {
                    type: 'task',
                    startTime: now,
                    taskId: task.id,
                    taskTitle: task.title || 'Užduotis'
                },
                // Clear any orphaned legacy session flags to prevent UI deadlocks
                'breakState.isTakingBreak': false,
                'callState.isCalling': false,
                'quickWorkState.isQuickWorking': false
            })
        ]);

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
export const pauseTask = async (task, { skipUserStatusUpdate = false } = {}) => {
    if (!task.timerStartedAt || task.timerStatus !== 'running') return;

    try {
        const now = getLithuanianNow();
        const start = new Date(task.timerStartedAt);
        // Guard against an invalid stored start or cross-device clock skew (start in the
        // future -> negative elapsed). Mirror calculateCurrentTotalMinutes: only accept a
        // finite, non-negative elapsed; otherwise treat this pause as logging no new time
        // rather than corrupting the timer with NaN/negative minutes.
        const rawElapsed = (now - start) / (1000 * 60); // minutes, float for precision
        const elapsedMinutes = (Number.isFinite(rawElapsed) && rawElapsed >= 0) ? rawElapsed : 0;

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

        // Run task update, user status update, and work session log in PARALLEL
        const parallelOps = [
            updateDoc(doc(db, 'tasks', task.id), {
                timerStatus: 'paused',
                timerStartedAt: null,
                timerMinutes: newTimerMinutes,
                manualMinutes: currentManualMinutes,
                updatedAt: new Date().toISOString()
            })
        ];

        // Update User Status to Paused — SKIP when called from pauseOtherTasks
        // because startTask/resumeTask will immediately overwrite this to 'running'.
        if (!skipUserStatusUpdate) {
            parallelOps.push(updateUserWorkStatus(task.assignedUserId, false, 'paused', task.id));
            // Also clear activeSession so ActiveWorkSessions stops showing user as busy
            if (task.assignedUserId) {
                parallelOps.push(
                    updateDoc(doc(db, 'users', task.assignedUserId), { activeSession: null })
                );
            }
        }

        // Log Work Session (fire alongside task update)
        if (elapsedMinutes > (10 / 60)) {
            // Attribute the session to the date the work ENDED (now), matching every
            // other work_sessions writer (sessionActions, time-correction). Using the
            // start date previously mis-bucketed sessions that ran across midnight.
            const sessionDate = getLithuanianDateString(now);
            parallelOps.push(
                addDoc(collection(db, 'work_sessions'), {
                    taskId: task.id,
                    taskTitle: task.title || 'Unknown Task',
                    userId: task.assignedUserId,
                    userName: task.assignedUserName || null,
                    startTime: start.toISOString(),
                    endTime: now.toISOString(),
                    durationMinutes: elapsedMinutes,
                    date: sessionDate,
                    createdAt: new Date().toISOString()
                }).catch(logErr => logError(logErr, { source: 'writeFail:pauseTask.workSession' }))
            );
        }

        await Promise.all(parallelOps);


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
        // 1. Pause others (must complete before resuming)
        await pauseOtherTasks(userId, task.id);

        const now = new Date().toISOString();

        // 2. Update Task + User Status + activeSession in PARALLEL
        await Promise.all([
            updateDoc(doc(db, 'tasks', task.id), {
                timerStatus: 'running',
                timerStartedAt: now,
                startedAt: task.startedAt || now,
                status: 'in-progress',
                updatedAt: now
            }),
            updateDoc(doc(db, 'users', userId), {
                workStatus: {
                    isWorking: true,
                    status: 'running',
                    activeTaskId: task.id,
                    lastUpdated: now
                },
                activeSession: {
                    type: 'task',
                    startTime: now,
                    taskId: task.id,
                    taskTitle: task.title || 'Užduotis'
                },
                // Clear any orphaned legacy session flags to prevent UI deadlocks
                'breakState.isTakingBreak': false,
                'callState.isCalling': false,
                'quickWorkState.isQuickWorking': false
            })
        ]);

    } catch (err) {
        console.error("Error resuming task:", err);
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
            where('assignedUserId', '==', userId),
            where('timerStatus', '==', 'running')
        );

        // Use robust fetch
        const snapshot = await getDocsWithCacheFallback(q);

        const pausePromises = snapshot.docs
            .filter(doc => doc.id !== currentTaskId)
            .map(docSnap => {
                const taskData = { id: docSnap.id, ...docSnap.data() };
                return pauseTask(taskData, { skipUserStatusUpdate: true });
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
 * Deletes a task by.
 * Depending on options, it either archives it as deleted (keeping hours) or hard-deletes it and marks sessions as deleted.
 * @param {Object} task - The task to delete.
 * @param {string} userId - The user ID.
 * @param {Object} options - Options for deletion, e.g. { keepWorkHours: boolean }
 */
export const deleteTask = async (task, userId, options = { keepWorkHours: false }) => {
    if (!task || !task.id) return;

    try {
        // 0. Handle Active Session if Running
        if (task.timerStatus === 'running') {
            try {
                // a. Pause to log session and calculate time
                await pauseTask(task);

                // b. Force User Status to Idle
                if (task.assignedUserId) {
                    await updateUserWorkStatus(task.assignedUserId, false, 'idle', null);
                }

            } catch (pErr) {
                console.error("Error pausing active task before deletion:", pErr);
                // Continue with deletion even if pause fails, to avoid "undead" tasks
            }
        }

        const { id } = task;

        // Discover role to auto-confirm deleted tasks if manager
        const userDoc = await getDoc(doc(db, 'users', userId));
        const userRole = userDoc.exists() ? userDoc.data().role : 'worker';
        const isManager = isManagerRole(userRole);

        if (options.keepWorkHours) {
            // Option B: Mark the task as completed+deleted IN the tasks collection.
            // It will show with strikethrough in today's completed tasks,
            // then the nightly archiving process will move it to archived_tasks naturally.
            const now = new Date().toISOString();

            if (task.isArchived) {
                // Already in archived_tasks — just update it there
                await updateDoc(doc(db, 'archived_tasks', id), {
                    status: 'deleted',
                    completed: true,
                    completedAt: now,
                    isDeleted: true,
                    deletedAt: now,
                    deletedBy: userId,
                    timerStatus: 'stopped',
                    timerStartedAt: null,
                    updatedAt: now
                });
            } else {
                // Still in active tasks — update in place so it shows in completed tasks today
                await updateDoc(doc(db, 'tasks', id), {
                    status: isManager ? 'confirmed' : 'completed',
                    completed: true,
                    completedAt: now,
                    confirmedBy: isManager ? userId : null,
                    confirmedAt: isManager ? now : null,
                    isDeleted: true,
                    deletedAt: now,
                    deletedBy: userId,
                    timerStatus: 'stopped',
                    timerStartedAt: null,
                    updatedAt: now
                });
            }
        } else {
            // Option C: Completely remove from both collections, and delete/mark sessions as deleted.
            if (!task.isArchived) {
                await deleteDoc(doc(db, 'tasks', id));
            }
            // If it was already in archived_tasks, or we want to make sure it's gone:
            await deleteDoc(doc(db, 'archived_tasks', id));
            
            // Mark all associated work_sessions as deleted
            const sessionsQuery = query(
                collection(db, 'work_sessions'),
                where('taskId', '==', id)
            );

            try {
                const sessionsSnap = await getDocs(sessionsQuery);
                const updatePromises = sessionsSnap.docs.map(sessionDoc =>
                    updateDoc(doc(db, 'work_sessions', sessionDoc.id), {
                        isDeleted: true,
                        deletedAt: new Date().toISOString()
                    })
                );
                await Promise.all(updatePromises);
            } catch (sessionErr) {
                console.error("Error marking work sessions as deleted:", sessionErr);
            }
        }

    } catch (err) {
        console.error("Error deleting task:", err);
        throw err;
    }
};


/**
 * Reverts a completed or deleted task back to active (pending) state.
 * Clears completion, deletion, and confirmation flags so the user can continue working.
 * @param {Object} task - The task to revert.
 * @returns {Promise<void>}
 */
export const revertTask = async (task) => {
    if (!task || !task.id) return;

    try {
        await updateDoc(doc(db, 'tasks', task.id), {
            status: 'pending',
            completed: false,
            completedAt: null,
            completedBy: null,
            confirmedBy: null,
            confirmedAt: null,
            isDeleted: false,
            deletedAt: null,
            deletedBy: null,
            timerStatus: task.timerMinutes > 0 ? 'paused' : null,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error("Error reverting task:", err);
        throw err;
    }
};

export const extendTaskTime = async (taskId, additionalTimeString, extendedBy) => {
    if (!taskId || !additionalTimeString) return;

    try {
        const taskRef = doc(db, 'tasks', taskId);
        const taskSnap = await getDoc(taskRef);
        if (!taskSnap.exists()) throw new Error('Task not found');

        const taskData = taskSnap.data();
        const currentEstimatedMinutes = parseTimeStringToMinutes(taskData.estimatedTime || '0m');
        const additionalMinutes = parseTimeStringToMinutes(additionalTimeString);

        if (additionalMinutes <= 0) throw new Error('Invalid time extension');

        const newTotalMinutes = currentEstimatedMinutes + additionalMinutes;
        const newEstimatedTime = formatMinutesToTimeString(newTotalMinutes);

        // Build extension history entry
        const extensionEntry = {
            amount: additionalTimeString,
            amountMinutes: additionalMinutes,
            addedAt: new Date().toISOString(),
            addedBy: extendedBy,
            previousEstimate: taskData.estimatedTime
        };

        await updateDoc(taskRef, {
            estimatedTime: newEstimatedTime,
            estimatedTimeMinutes: newTotalMinutes,
            timeLimitReached: false,
            warningShown70: false,
            inspectionStatus: null,
            timeExtensions: [...(taskData.timeExtensions || []), extensionEntry],
            updatedAt: new Date().toISOString()
        });

    } catch (err) {
        console.error('Error extending task time:', err);
        throw err;
    }
};

