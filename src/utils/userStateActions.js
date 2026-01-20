import { doc, getDoc, updateDoc, collection, addDoc, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask } from './taskActions';

/**
 * Stops any active Break session.
 */
export const stopBreak = async (userId) => {
    try {
        const userRef = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
            const data = userSnap.data().breakState || {};
            if (data.isTakingBreak) {
                const now = new Date();
                let sessionMinutes = 0;
                if (data.lastStartedAt) {
                    sessionMinutes = (now - new Date(data.lastStartedAt)) / (1000 * 60);
                }

                await updateDoc(userRef, {
                    breakState: {
                        isTakingBreak: false,
                        lastStartedAt: null,
                        dailyAccumulatedMinutes: (data.dailyAccumulatedMinutes || 0) + sessionMinutes,
                        lastDate: data.lastDate || new Date().toISOString().split('T')[0],
                        resumableTaskIds: []
                    }
                });
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

                // Log call as task if duration > 0.1m
                if (sessionMinutes > 0.1) {
                    await addDoc(collection(db, 'tasks'), {
                        title: "Skambutis",
                        description: "Automatiškai sukurtas",
                        status: "completed",
                        priority: "Medium",
                        assignedWorkerId: userId,
                        assignedWorkerName: userDisplayName || 'Unknown',
                        createdBy: userId,
                        creatorName: userDisplayName || 'Unknown',
                        createdAt: new Date().toISOString(),
                        completedAt: now.toISOString(),
                        manualMinutes: sessionMinutes,
                        isSystemTask: true
                    });
                }

                await updateDoc(userRef, {
                    callState: {
                        isCalling: false,
                        lastStartedAt: null,
                        resumableTaskIds: []
                    }
                });
            }
        }
    } catch (err) {
        console.error("Error stopping call:", err);
    }
};

/**
 * Stops any active Quick Work session and logs it as a task.
 */
export const stopQuickWork = async (userId, userDisplayName) => {
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

                // Log as generic quick work task if stopped externally
                if (sessionMinutes > 0.1) {
                    await addDoc(collection(db, 'tasks'), {
                        title: "Greitas darbas (Automatiškai išsaugotas)",
                        description: "Automatiškai sukurtas, nes buvo pradėta kita veikla",
                        status: "completed",
                        priority: "Medium",
                        assignedWorkerId: userId,
                        assignedWorkerName: userDisplayName || 'Unknown',
                        createdBy: userId,
                        creatorName: userDisplayName || 'Unknown',
                        createdAt: new Date().toISOString(),
                        completedAt: now.toISOString(),
                        manualMinutes: sessionMinutes,
                        isQuickWork: true,
                        autoStopped: true
                    });
                }

                await updateDoc(userRef, {
                    quickWorkState: {
                        isQuickWorking: false,
                        lastStartedAt: null,
                        resumableTaskIds: []
                    }
                });
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
            return pauseTask(taskData); // Use existing pauseTask utility, updated to accept minimal data if needed
        });
        await Promise.all(pausePromises);
    } catch (err) {
        console.error("Error pausing running tasks:", err);
    }
};
