import { doc, getDoc, updateDoc, collection, addDoc, query, where, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, resumeTask } from './taskActions';
import { endSession, startSession } from './sessionActions';

/**
 * Helper to resume tasks and update user status atomically (if possible) or sequentially
 * Managed now via session actions mostly, but kept for old utility usage.
 */
const resumeTasksAndSetUserStatus = async (userId, resumableTaskIds) => {
    // This logic is slightly specific to how we resume "after" a break.
    // Ideally sessionActions handles resumption. But for now we keep this here
    // or we move it to sessionActions?
    // Let's keep it here but strictly for resumption logic.
    if (!resumableTaskIds || resumableTaskIds.length === 0) {
        // Just set user to idle if no tasks to resume
        // Update: We should only do this if NOT in a session.
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

    if (resumedCount > 0) {
        // resumeTask already updates User Status and activeSession.
        // No need to call startSession again, as it might inadvertently pause the task we just resumed if it detects it as active.
        console.log(`Resumed ${resumedCount} tasks.`);
    } else {
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
    // Delegate to generic session end
    await endSession(userId);

    // Resume tasks logic involves reading "resumableTaskIds" from the OLD state
    // startSession/endSession tries to maintain sync, but resumption is complex.
    // We should fetch the user to check resumableTaskIds.
    // Or we rely on client side to call resume? 
    // The original stopBreak called resumeTasksAndSetUserStatus.

    // We can fetch data here and call resume.
    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
        const data = userSnap.data().breakState || {};
        await resumeTasksAndSetUserStatus(userId, data.resumableTaskIds);
    }
};

/**
 * Stops any active Call session and logs it as a task.
 */
export const stopCall = async (userId, userDisplayName) => {
    await endSession(userId);

    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
        const data = userSnap.data().callState || {};
        await resumeTasksAndSetUserStatus(userId, data.resumableTaskIds);
    }
};

/**
 * Stops any active Quick Work session and logs it as a task.
 */
export const stopQuickWork = async (userId, userDisplayName, customTitle = null) => {
    // Note: sessionActions' endSession handles logging for Quick Work, 
    // BUT checking for `customTitle` is tricky. sessionActions stores metadata.
    // If we passed customTitle in Start, it's there. 
    // But QuickWorkTimer might call stopQuickWork with a *new* title.

    // Special case: If we have a custom title, we might want to update the session metadata *before* ending it?
    // Or we just update the legacy logic.
    // To be safe for now, endSession handles basic logging.
    // If we need custom Title, we should probably update the activeSession doc first?

    if (customTitle) {
        await updateDoc(doc(db, 'users', userId), {
            'activeSession.customTitle': customTitle
        });
    }

    await endSession(userId);

    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
        const data = userSnap.data().quickWorkState || {};
        await resumeTasksAndSetUserStatus(userId, data.resumableTaskIds);
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
