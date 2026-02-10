import { doc, getDoc, updateDoc, collection, addDoc, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, resumeTask } from './taskActions';
import { getLithuanianNow, getLithuanianDateString } from './timeUtils';

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

        // 1. Fetch current user state
        const userSnap = await getDoc(userRef);
        const userData = userSnap.data();

        // 2. Identify tasks that need to be resumed later
        let resumableTaskIds = [];

        // Check activeSession for task
        if (userData?.activeSession?.type === 'task' && userData?.activeSession?.taskId) {
            resumableTaskIds.push(userData.activeSession.taskId);
        }
        // Check legacy workStatus
        else if (userData?.workStatus?.status === 'running' && userData?.workStatus?.activeTaskId) {
            resumableTaskIds.push(userData.workStatus.activeTaskId);
        }

        // 3. End current session if exists and pause tasks
        if (userData?.activeSession?.type) {
            if (userData.activeSession.type === 'task' && userData.activeSession.taskId) {
                const taskDoc = await getDoc(doc(db, 'tasks', userData.activeSession.taskId));
                if (taskDoc.exists()) {
                    await pauseTask({ id: taskDoc.id, ...taskDoc.data() });
                }
                // After pausing, we can call endSession safely (though pauseTask updates user status too)
                // endSession will clear the activeSession field if pauseTask didn't already (pauseTask sets it to paused/idle legacy style)
                await endSession(userId, userData, {}, true);
            } else {
                await endSession(userId, userData, {}, true);
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
            }
        }

        // 4. Prepare new session data
        const nowMoment = getLithuanianNow();
        const startTime = nowMoment.toISOString();
        const activeSession = {
            type,
            startTime,
            ...metadata // contains taskId for tasks
        };

        // 5. Update User Doc
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
                lastDate: getLithuanianDateString(),
                resumableTaskIds: resumableTaskIds
            };
        } else if (type === 'call') {
            updates.callState = {
                isCalling: true,
                lastStartedAt: startTime,
                resumableTaskIds: resumableTaskIds
            };
        } else if (type === 'quick_work') {
            updates.quickWorkState = {
                isQuickWorking: true,
                lastStartedAt: startTime,
                resumableTaskIds: resumableTaskIds
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
export const endSession = async (userId, userInfo = null, sessionOverrides = {}, skipResume = false) => {
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

        const now = getLithuanianNow();
        const start = new Date(session.startTime);
        const durationMinutes = (now - start) / (1000 * 60);
        const sessionDate = getLithuanianDateString(now);

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
                // Silently ignore permission errors for generic sessions as they are optional/beta
                // console.debug("Failed to log generic session (likely permissions):", logErr);
            }
        }

        // 2. Double Write to Legacy Collections
        try {
            await handleLegacyLogging(userId, userData, session, now, durationMinutes);
        } catch (legacyLogErr) {
            console.warn("Failed to log legacy session:", legacyLogErr);
        }

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

        // 4. Task Resumption Logic
        // Determine resumable IDs from the state we just closed
        if (!skipResume) {
            let resumableTaskIds = [];
            if (session.type === 'break') resumableTaskIds = userData.breakState?.resumableTaskIds || [];
            else if (session.type === 'call') resumableTaskIds = userData.callState?.resumableTaskIds || [];
            else if (session.type === 'quick_work') resumableTaskIds = userData.quickWorkState?.resumableTaskIds || [];

            if (resumableTaskIds && resumableTaskIds.length > 0) {
                const resumePromises = resumableTaskIds.map(async (taskId) => {
                    const tDoc = await getDoc(doc(db, 'tasks', taskId));
                    if (tDoc.exists()) {
                        const tData = { id: tDoc.id, ...tDoc.data() };
                        // Only resume if task is paused AND not completed/confirmed/deleted
                        if (tData.timerStatus === 'paused' &&
                            !tData.completed &&
                            tData.status !== 'completed' &&
                            tData.status !== 'confirmed' &&
                            tData.status !== 'deleted') {
                            await resumeTask(tData, userId);
                        }
                    }
                });
                await Promise.allSettled(resumePromises);
            }
        }

    } catch (err) {
        console.error("Error ending session:", err);
    }
};

// Helper: End legacy session types if we drift out of sync
const endLegacySession = async (userId, type, userData) => {
    try {
        // Construct a fake session object to pass to legacy logger
        let startTime;
        if (type === 'break') startTime = userData.breakState?.lastStartedAt;
        else if (type === 'call') startTime = userData.callState?.lastStartedAt;
        else if (type === 'quick_work') startTime = userData.quickWorkState?.lastStartedAt;

        let duration = 0;
        const nowMoment = getLithuanianNow();
        let now = nowMoment;

        if (startTime) {
            const fakeSession = { type, startTime };
            now = getLithuanianNow(); // Update now
            duration = (now - new Date(startTime)) / (1000 * 60);

            // Log session (safely)
            try {
                await handleLegacyLogging(userId, userData, fakeSession, now, duration);
            } catch (loggingErr) {
                console.warn(`Failed to log legacy session (${type}):`, loggingErr);
            }
        }

        // CRITICAL FIX: Clear the legacy state flags so the user doesn't get stuck
        const userRef = doc(db, 'users', userId);
        const updates = {};

        if (type === 'break') {
            updates['breakState.isTakingBreak'] = false;
            // Accumulate minutes so daily counter is correct
            updates['breakState.dailyAccumulatedMinutes'] = (userData.breakState?.dailyAccumulatedMinutes || 0) + duration;
        } else if (type === 'call') {
            updates['callState.isCalling'] = false;
        } else if (type === 'quick_work') {
            updates['quickWorkState.isQuickWorking'] = false;
        }

        if (Object.keys(updates).length > 0) {
            await updateDoc(userRef, updates);
        }

    } catch (err) {
        console.error("Error in endLegacySession:", err);
    }
};

const handleLegacyLogging = async (userId, userData, session, now, durationMinutes) => {
    if (durationMinutes <= (10 / 60)) return; // Ignore short
    const sessionDate = getLithuanianDateString(now);

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
