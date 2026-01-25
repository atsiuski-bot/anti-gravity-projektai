import { doc, getDoc, updateDoc, collection, addDoc, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, resumeTask } from './taskActions';

/**
 * Starts a new session for the user.
 * Automatically ends any existing session.
 * 
 * @param {string} userId 
 * @param {string} type - 'break', 'call', 'quick_work', 'task'
 * @param {Object} metadata - Additional data (e.g. taskId, taskTitle)
 */
export const startSession = async (userId, type, metadata = {}) => {
    try {
        const userRef = doc(db, 'users', userId);

        // 1. End current session if exists
        // We fetch first to know what to do (e.g. if it's a task, we might need to pause it using taskActions)
        const userSnap = await getDoc(userRef);
        const userData = userSnap.data();

        if (userData?.activeSession?.type) {
            // Special handling for Tasks: We must PAUSE the task logic (Timer + Document) 
            // activeSession just tracks the user state.
            if (userData.activeSession.type === 'task' && userData.activeSession.taskId) {
                const taskDoc = await getDoc(doc(db, 'tasks', userData.activeSession.taskId));
                if (taskDoc.exists()) {
                    await pauseTask({ id: taskDoc.id, ...taskDoc.data() });
                }
                // After pausing, we can call endSession safely (though pauseTask updates user status too)
                // endSession will clear the activeSession field if pauseTask didn't already (pauseTask sets it to paused/idle legacy style)
                await endSession(userId, userData);
            } else {
                await endSession(userId, userData);
            }
        } else {
            // Check legacy states
            if (userData?.breakState?.isTakingBreak) await endLegacySession(userId, 'break', userData);
            else if (userData?.callState?.isCalling) await endLegacySession(userId, 'call', userData);
            else if (userData?.quickWorkState?.isQuickWorking) await endLegacySession(userId, 'quick_work', userData);
            else if (userData?.workStatus?.status === 'running') {
                // Legacy Task Handling
                const activeTaskId = userData.workStatus.activeTaskId;
                if (activeTaskId) {
                    const taskDoc = await getDoc(doc(db, 'tasks', activeTaskId));
                    if (taskDoc.exists()) {
                        await pauseTask({ id: taskDoc.id, ...taskDoc.data() });
                    }
                }
                // No need to call endLegacySession for task as pauseTask handles logging
            }
        }

        // 2. Prepare new session data
        const startTime = new Date().toISOString();
        const activeSession = {
            type,
            startTime,
            ...metadata // contains taskId for tasks
        };

        // 3. Update User Doc
        const updates = {
            activeSession,
            // Legacy Sync (Double Write)
        };

        // Legacy: Update specific states based on type
        if (type === 'break') {
            updates.breakState = {
                isTakingBreak: true,
                lastStartedAt: startTime,
                dailyAccumulatedMinutes: userData?.breakState?.dailyAccumulatedMinutes || 0,
                lastDate: new Date().toISOString().split('T')[0],
                resumableTaskIds: [] // We don't really use this in new logic but keeping structure
            };
        } else if (type === 'call') {
            updates.callState = {
                isCalling: true,
                lastStartedAt: startTime,
                resumableTaskIds: []
            };
        } else if (type === 'quick_work') {
            updates.quickWorkState = {
                isQuickWorking: true,
                lastStartedAt: startTime,
                resumableTaskIds: []
            };
        } else if (type === 'task') {
            updates.workStatus = {
                isWorking: true,
                status: 'running',
                activeTaskId: metadata.taskId || null,
                lastUpdated: startTime
            };
        }

        await updateDoc(userRef, updates);

    } catch (err) {
        console.error("Error starting session:", err);
        throw err;
    }
};

/**
 * Ends the current active session.
 * Logs to 'sessions' collection and legacy collections.
 * 
 * @param {string} userId 
 * @param {Object} [userInfo] - Optional, if we already fetched user doc
 * @param {Object} [sessionOverrides] - Optional, metadata to merge/override (e.g. customTitle)
 */
export const endSession = async (userId, userInfo = null, sessionOverrides = {}) => {
    try {
        const userRef = doc(db, 'users', userId);
        let userData = userInfo;
        if (!userData) {
            const snap = await getDoc(userRef);
            userData = snap.data();
        }

        const session = { ...userData?.activeSession, ...sessionOverrides };

        // Fallback for legacy states if no activeSession and no force override
        if (!userData?.activeSession && !sessionOverrides.force) {
            if (userData?.breakState?.isTakingBreak) await endLegacySession(userId, 'break', userData);
            else if (userData?.callState?.isCalling) await endLegacySession(userId, 'call', userData);
            else if (userData?.quickWorkState?.isQuickWorking) await endLegacySession(userId, 'quick_work', userData);
            return;
        }

        if (!session.type && !userData?.activeSession) return; // Should not happen if logic is correct

        const now = new Date();
        const start = new Date(session.startTime);
        const durationMinutes = (now - start) / (1000 * 60);
        const sessionDate = now.toISOString().split('T')[0];

        // 1. Log to generic 'sessions'
        if (durationMinutes > (10 / 60)) { // Minimal threshold
            try {
                await addDoc(collection(db, 'sessions'), {
                    userId,
                    userName: userData.displayName || 'Unknown',
                    type: session.type,
                    startTime: session.startTime,
                    endTime: now.toISOString(),
                    durationMinutes,
                    date: sessionDate,
                    metadata: session
                });
            } catch (logErr) {
                console.warn("Failed to log generic session (likely permissions):", logErr);
                // Continue execution to ensure legacy logging and state clearing works
            }
        }

        // 2. Double Write to Legacy Collections
        await handleLegacyLogging(userId, userData, session, now, durationMinutes);

        // 3. Clear User State
        const updates = {
            activeSession: null
        };

        // Legacy Clear
        if (session.type === 'break') {
            updates['breakState.isTakingBreak'] = false;
            updates['breakState.dailyAccumulatedMinutes'] = (userData.breakState?.dailyAccumulatedMinutes || 0) + durationMinutes;
        } else if (session.type === 'call') {
            updates['callState.isCalling'] = false;
        } else if (session.type === 'quick_work') {
            updates['quickWorkState.isQuickWorking'] = false;
        } else if (session.type === 'task') {
            updates['workStatus.isWorking'] = false;
            updates['workStatus.status'] = 'idle';
            updates['workStatus.activeTaskId'] = null;
        }

        await updateDoc(userRef, updates);

    } catch (err) {
        console.error("Error ending session:", err);
    }
};

// Helper: End legacy session types if we drift out of sync
const endLegacySession = async (userId, type, userData) => {
    // This calls the OLD actions to purely clean up if we found ourselves in a legacy state without activeSession
    // We import these dynamically or just duplicate logic to avoid circular deps if needed.
    // For now, simpler to just manually log and clear based on userData.
    // Use handleLegacyLogging logic.

    // Construct a fake session object to pass to legacy logger
    let startTime;
    if (type === 'break') startTime = userData.breakState?.lastStartedAt;
    else if (type === 'call') startTime = userData.callState?.lastStartedAt;
    else if (type === 'quick_work') startTime = userData.quickWorkState?.lastStartedAt;
    // Task handling is complex because of activeTaskId. 
    // Usually existing pauseTask handles this.

    if (startTime) {
        const fakeSession = { type, startTime };
        const now = new Date();
        const duration = (now - new Date(startTime)) / (1000 * 60);
        await handleLegacyLogging(userId, userData, fakeSession, now, duration);
    }
};

const handleLegacyLogging = async (userId, userData, session, now, durationMinutes) => {
    if (durationMinutes <= (10 / 60)) return; // Ignore short
    const sessionDate = now.toISOString().split('T')[0];

    if (session.type === 'break') {
        await addDoc(collection(db, 'break_sessions'), {
            userId: userId,
            userName: userData.displayName || 'Unknown',
            startTime: session.startTime,
            endTime: now.toISOString(),
            durationMinutes: durationMinutes,
            date: sessionDate,
            createdAt: new Date().toISOString(),
            completedAt: now.toISOString(),
            isBreak: true
        });
    } else if (session.type === 'call') {
        const timeString = now.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', hour12: false });
        // Log as Task
        await addDoc(collection(db, 'tasks'), {
            title: "Skambutis",
            description: timeString,
            status: "confirmed",
            priority: "Medium",
            assignedWorkerId: userId,
            assignedWorkerName: userData.displayName || 'Unknown',
            createdBy: userId,
            creatorName: userData.displayName || 'Unknown',
            createdAt: new Date().toISOString(),
            completedAt: now.toISOString(),
            completed: true,
            confirmedBy: userId,
            confirmedAt: now.toISOString(),
            manualMinutes: durationMinutes,
            isSystemTask: true
        });
        // Log Work Session
        await addDoc(collection(db, 'work_sessions'), {
            taskId: "call_" + now.getTime(),
            taskTitle: "Skambutis",
            workerId: userId,
            workerName: userData.displayName || 'Unknown',
            startTime: session.startTime,
            endTime: now.toISOString(),
            durationMinutes: durationMinutes,
            date: sessionDate,
            createdAt: new Date().toISOString(),
            isSystemTask: true
        });
    } else if (session.type === 'quick_work') {
        const timeString = now.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', hour12: false });
        const title = session.customTitle || "Greitas darbas (Automatiškai išsaugotas)";

        await addDoc(collection(db, 'tasks'), {
            title: title,
            description: session.customTitle ? timeString : `${timeString} (Automatiškai sukurtas)`,
            status: "completed",
            priority: "Medium",
            assignedWorkerId: userId,
            assignedWorkerName: userData.displayName || 'Unknown',
            createdBy: userId,
            creatorName: userData.displayName || 'Unknown',
            createdAt: new Date().toISOString(),
            completedAt: now.toISOString(),
            completed: true,
            manualMinutes: durationMinutes,
            isQuickWork: true,
            autoStopped: !session.customTitle
        });

        await addDoc(collection(db, 'work_sessions'), {
            taskId: "quick_" + now.getTime(),
            taskTitle: title,
            workerId: userId,
            workerName: userData.displayName || 'Unknown',
            startTime: session.startTime,
            endTime: now.toISOString(),
            durationMinutes: durationMinutes,
            date: sessionDate,
            createdAt: new Date().toISOString(),
            isQuickWork: true
        });
    }
    // Note: 'task' type logging is usually handled by pauseTask inside taskActions. 
    // If we use startSession('task'), we must ensure taskActions.startTask was called or logic matches.
    // Integrating task logging here might duplicate valid logic in pauseTask.
    // For now, we assume taskActions handles the specific Task Doc updates and Work Session logging.
};
