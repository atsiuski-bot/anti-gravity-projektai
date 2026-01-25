import { doc, getDoc, updateDoc, collection, addDoc, query, where, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, resumeTask } from './taskActions';

/**
 * Helper to resume tasks and update user status atomically (if possible) or sequentially
 */
const resumeTasksAndSetUserStatus = async (userId, resumableTaskIds) => {
    if (!resumableTaskIds || resumableTaskIds.length === 0) {
        // Just set user to idle if no tasks to resume
        await updateDoc(doc(db, 'users', userId), {
            workStatus: {
                isWorking: false,
                status: 'idle',
                activeTaskId: null,
                lastUpdated: new Date().toISOString()
            }
        });
        return;
    }

    let resumedCount = 0;
    let lastResumedTaskId = null;

    // Resume tasks
    const resumePromises = resumableTaskIds.map(async (taskId) => {
        const tDoc = await getDoc(doc(db, 'tasks', taskId));
        if (tDoc.exists()) {
            const tData = { id: tDoc.id, ...tDoc.data() };
            // Only resume if it's still paused
            if (tData.timerStatus === 'paused') {
                await resumeTask(tData, userId);
                resumedCount++;
                lastResumedTaskId = taskId;
            }
        }
    });

    await Promise.all(resumePromises);

    // If we resumed at least one task, ensure user status is 'running'
    // resumeTask already does this, but we reinforce it here to be sure
    // specifically if multiple were resumed, the last one wins, which is fine.
    if (resumedCount > 0) {
        await updateDoc(doc(db, 'users', userId), {
            workStatus: {
                isWorking: true,
                status: 'running',
                activeTaskId: lastResumedTaskId,
                lastUpdated: new Date().toISOString()
            }
        });
    } else {
        // If for some reason tasks didn't resume (e.g. they were deleted or already running), set to idle
        await updateDoc(doc(db, 'users', userId), {
            workStatus: {
                isWorking: false,
                status: 'idle',
                activeTaskId: null,
                lastUpdated: new Date().toISOString()
            }
        });
    }
};

/**
 * Stops any active Break session.
 */
export const stopBreak = async (userId) => {
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
            const userData = userSnap.data();
            const data = userData.breakState || {};
            if (data.isTakingBreak) {
                const now = new Date();
                let sessionMinutes = 0;
                if (data.lastStartedAt) {
                    sessionMinutes = (now - new Date(data.lastStartedAt)) / (1000 * 60);
                }

                // Threshold check: ignore if <= 10 seconds
                const isValidSession = sessionMinutes > (10 / 60);

                // Save break session to break_sessions collection if valid
                if (isValidSession) {
                    const sessionDate = now.toISOString().split('T')[0];
                    await addDoc(collection(db, 'break_sessions'), {
                        userId: userId,
                        userName: userData.displayName || userData.email || 'Unknown',
                        startTime: new Date(data.lastStartedAt).toISOString(),
                        endTime: now.toISOString(),
                        durationMinutes: sessionMinutes,
                        date: sessionDate,
                        createdAt: new Date().toISOString(),
                        completedAt: now.toISOString(), // Standardize completion time
                        isBreak: true
                    });
                }

                // 1. Update Break State (Clear it)
                await updateDoc(userRef, {
                    breakState: {
                        isTakingBreak: false,
                        lastStartedAt: null,
                        dailyAccumulatedMinutes: (data.dailyAccumulatedMinutes || 0) + (isValidSession ? sessionMinutes : 0),
                        lastDate: data.lastDate || new Date().toISOString().split('T')[0],
                        resumableTaskIds: []
                    }
                });

                // 2. Resume specific tasks if any
                await resumeTasksAndSetUserStatus(userId, data.resumableTaskIds);
            }
        }
    } catch (err) {
        console.error("Error stopping break:", err);
    }
};

/**
 * Stops any active Call session and logs it as a task.
 */
export const stopCall = async (userId, userDisplayName) => {
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
            const data = userSnap.data().callState || {};
            if (data.isCalling) {
                const now = new Date();
                let sessionMinutes = 0;
                if (data.lastStartedAt) {
                    sessionMinutes = (now - new Date(data.lastStartedAt)) / (1000 * 60);
                }

                // Threshold check: > 10 seconds
                if (sessionMinutes > (10 / 60)) {
                    const timeString = now.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', hour12: false });
                    await addDoc(collection(db, 'tasks'), {
                        title: "Skambutis",
                        description: timeString,
                        status: "confirmed",
                        priority: "Medium",
                        assignedWorkerId: userId,
                        assignedWorkerName: userDisplayName || 'Unknown',
                        createdBy: userId,
                        creatorName: userDisplayName || 'Unknown',
                        createdAt: new Date().toISOString(),
                        completedAt: now.toISOString(),
                        completed: true,
                        confirmedBy: userId,
                        confirmedAt: now.toISOString(),
                        manualMinutes: sessionMinutes,
                        isSystemTask: true
                    });

                    // Log Work Session
                    const sessionDate = now.toISOString().split('T')[0];
                    await addDoc(collection(db, 'work_sessions'), {
                        taskId: "call_" + now.getTime(),
                        taskTitle: "Skambutis",
                        workerId: userId,
                        workerName: userDisplayName || 'Unknown',
                        startTime: new Date(data.lastStartedAt).toISOString(),
                        endTime: now.toISOString(),
                        durationMinutes: sessionMinutes,
                        date: sessionDate,
                        createdAt: new Date().toISOString(),
                        isSystemTask: true
                    });
                }

                // 1. Clear Call State
                await updateDoc(userRef, {
                    callState: {
                        isCalling: false,
                        lastStartedAt: null,
                        resumableTaskIds: []
                    }
                });

                // 2. Resume tasks
                await resumeTasksAndSetUserStatus(userId, data.resumableTaskIds);
            }
        }
    } catch (err) {
        console.error("Error stopping call:", err);
    }
};

/**
 * Stops any active Quick Work session and logs it as a task.
 * @param {string} userId 
 * @param {string} userDisplayName 
 * @param {string} [customTitle] - Optional title if passed directly (though usually handled via modal in UI)
 */
export const stopQuickWork = async (userId, userDisplayName, customTitle = null) => {
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
            const data = userSnap.data().quickWorkState || {};
            if (data.isQuickWorking) {
                const now = new Date();
                let sessionMinutes = 0;
                if (data.lastStartedAt) {
                    sessionMinutes = (now - new Date(data.lastStartedAt)) / (1000 * 60);
                }

                // Threshold check: > 10 seconds
                if (sessionMinutes > (10 / 60)) {
                    const timeString = now.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', hour12: false });
                    const title = customTitle || "Greitas darbas (Automatiškai išsaugotas)";

                    await addDoc(collection(db, 'tasks'), {
                        title: title,
                        description: customTitle ? timeString : `${timeString} (Automatiškai sukurtas)`,
                        status: "completed",
                        priority: "Medium",
                        assignedWorkerId: userId,
                        assignedWorkerName: userDisplayName || 'Unknown',
                        createdBy: userId,
                        creatorName: userDisplayName || 'Unknown',
                        createdAt: new Date().toISOString(),
                        completedAt: now.toISOString(),
                        completed: true,
                        manualMinutes: sessionMinutes,
                        isQuickWork: true,
                        autoStopped: !customTitle
                    });

                    // Log Work Session
                    const sessionDate = now.toISOString().split('T')[0];
                    await addDoc(collection(db, 'work_sessions'), {
                        taskId: "quick_" + now.getTime(),
                        taskTitle: title,
                        workerId: userId,
                        workerName: userDisplayName || 'Unknown',
                        startTime: new Date(data.lastStartedAt).toISOString(),
                        endTime: now.toISOString(),
                        durationMinutes: sessionMinutes,
                        date: sessionDate,
                        createdAt: new Date().toISOString(),
                        isQuickWork: true
                    });
                }

                // 1. Clear Quick Work State
                await updateDoc(userRef, {
                    quickWorkState: {
                        isQuickWorking: false,
                        lastStartedAt: null,
                        resumableTaskIds: []
                    }
                });

                // 2. Resume users
                await resumeTasksAndSetUserStatus(userId, data.resumableTaskIds);
            }
        }
    } catch (err) {
        console.error("Error stopping quick work:", err);
    }
};

/**
 * Pauses all running tasks for the user.
 */
export const pauseAllRunningTasks = async (userId) => {
    try {
        const q = query(
            collection(db, 'tasks'),
            where('assignedWorkerId', '==', userId),
            where('timerStatus', '==', 'running')
        );
        const snapshot = await getDocs(q);
        const pausePromises = snapshot.docs.map(docSnap => {
            const taskData = { id: docSnap.id, ...docSnap.data() };
            return pauseTask(taskData);
        });
        await Promise.all(pausePromises);
    } catch (err) {
        console.error("Error pausing running tasks:", err);
    }
};

