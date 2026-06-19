import { doc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask } from './taskActions';
import { endSession } from './sessionActions';


/**
 * Stops any active Break session.
 */
export const stopBreak = async (userId) => {
    // Delegate to generic session end — endSession already handles task resumption
    await endSession(userId);
};

/**
 * Stops any active Call session and logs it as a task.
 */
export const stopCall = async (userId) => {
    // Delegate to generic session end — endSession already handles logging + task resumption
    await endSession(userId);
};

/**
 * Stops any active Quick Work session and logs it as a task.
 */
export const stopQuickWork = async (userId, customTitle = null) => {
    // If we have a custom title, update the session metadata before ending
    if (customTitle) {
        await updateDoc(doc(db, 'users', userId), {
            'activeSession.customTitle': customTitle
        });
    }

    // Delegate to generic session end — endSession handles logging + task resumption
    await endSession(userId);
};

/**
 * Pauses all running tasks for the user.
 */
export const pauseAllRunningTasks = async (userId) => {
    try {
        const q = query(
            collection(db, 'tasks'),
            where('assignedUserId', '==', userId),
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
