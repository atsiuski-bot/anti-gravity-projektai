import { useState, useEffect, useRef, useCallback } from 'react';
import { doc, updateDoc, addDoc, collection } from 'firebase/firestore';
import { db } from '../firebase';
import { calculateCurrentTotalMinutes, parseTimeStringToMinutes } from '../utils/timeUtils';
import { pauseTask } from '../utils/taskActions';
import { SoundManager } from '../utils/soundUtils';
import { useAuth } from '../context/AuthContext';

/**
 * Hook that monitors the active running task for time limit thresholds.
 * - At 80% of estimatedTime: shows warning popup + plays warning sound
 * - At 100%: auto-pauses task, plays alarm, starts repeating sound, sends manager notification
 * 
 * @param {Array} tasks - Array of task objects to monitor
 * @returns {Object} state for popups
 */
export function useTaskTimeMonitor(tasks) {
    const { currentUser } = useAuth();

    // Popup state
    const [warningPopup, setWarningPopup] = useState(null);  // { task, remaining }
    const [limitPopup, setLimitPopup] = useState(null);       // { task, estimatedTime, actualTime }

    // Track which tasks have already triggered warnings/limits (by task id)
    const warned70Ref = useRef(new Set());
    const limitReachedRef = useRef(new Set());
    // Track the task's estimatedTimeMinutes at the time we triggered, so extensions reset it
    const lastEstimatedRef = useRef(new Map()); // taskId -> estimatedMinutes when triggered

    // Find the currently running task
    const activeTask = tasks?.find(t => {
        if (t.timerStatus !== 'running' || !t.estimatedTime) return false;
        // Must be assigned to current user
        if (t.assignedUserId !== currentUser?.uid) return false;
        return true;
    });

    // Check thresholds on an interval
    useEffect(() => {
        if (!activeTask) return;

        const taskId = activeTask.id;
        const estimatedMinutes = parseTimeStringToMinutes(activeTask.estimatedTime);
        if (estimatedMinutes <= 0) return;

        // If the estimated time changed (extension was granted), reset tracking for this task
        const prevEstimated = lastEstimatedRef.current.get(taskId);
        if (prevEstimated && prevEstimated !== estimatedMinutes) {
            warned70Ref.current.delete(taskId);
            limitReachedRef.current.delete(taskId);
        }
        lastEstimatedRef.current.set(taskId, estimatedMinutes);

        const checkTime = async () => {
            const currentMinutes = calculateCurrentTotalMinutes(activeTask);
            const percentage = (currentMinutes / estimatedMinutes) * 100;

            // Dynamic Unlatching: If time was manually deducted, re-arm the triggers and auto-heal the DB flags
            if (percentage < 100) {
                if (limitReachedRef.current.has(taskId)) limitReachedRef.current.delete(taskId);
                if (activeTask.timeLimitReached) {
                    try { updateDoc(doc(db, 'tasks', taskId), { timeLimitReached: false }); } catch(e) {}
                }
            }
            if (percentage < 70) {
                if (warned70Ref.current.has(taskId)) warned70Ref.current.delete(taskId);
                if (activeTask.warningShown70) {
                    try { updateDoc(doc(db, 'tasks', taskId), { warningShown70: false }); } catch(e) {}
                }
            }

            // 70% warning
            if (percentage >= 70 && percentage < 100 && !warned70Ref.current.has(taskId)) {
                // Check Firestore flag — maybe warning was already shown in a previous session
                if (!activeTask.warningShown70) {
                    warned70Ref.current.add(taskId);
                    const remaining = Math.max(0, Math.round(estimatedMinutes - currentMinutes));
                    setWarningPopup({ task: activeTask, remaining });
                    SoundManager.playTimeWarning70Sound();

                    // Mark on Firestore so it doesn't re-fire after page reload
                    try {
                        await updateDoc(doc(db, 'tasks', taskId), { warningShown70: true });
                    } catch (e) {
                        console.warn('Failed to mark 70% warning:', e);
                    }
                } else {
                    warned70Ref.current.add(taskId); // Already shown, just track locally
                }
            }

            // 100% limit
            if (percentage >= 100 && !limitReachedRef.current.has(taskId)) {
                if (!activeTask.timeLimitReached) {
                    limitReachedRef.current.add(taskId);

                    // 1. Auto-pause the task
                    try {
                        await pauseTask(activeTask);
                    } catch (e) {
                        console.error('Failed to auto-pause task at time limit:', e);
                    }

                    // 2. Mark on Firestore
                    try {
                        await updateDoc(doc(db, 'tasks', taskId), {
                            timeLimitReached: true,
                            updatedAt: new Date().toISOString()
                        });
                    } catch (e) {
                        console.warn('Failed to mark time limit reached:', e);
                    }

                    // 3. Show popup
                    const actualTime = Math.round(currentMinutes);
                    setLimitPopup({
                        task: activeTask,
                        estimatedTime: activeTask.estimatedTime,
                        actualMinutes: actualTime
                    });

                    // 4. Start repeating alarm
                    SoundManager.startTimeLimitRepeat();

                    // 5. Send notification to manager
                    const managerId = activeTask.managerId || activeTask.taskAuditor;
                    if (managerId) {
                        try {
                            await addDoc(collection(db, 'request_notifications'), {
                                recipientId: managerId,
                                type: 'time_extension_request',
                                taskId: taskId,
                                taskTitle: activeTask.title || 'Užduotis',
                                estimatedTime: activeTask.estimatedTime,
                                actualMinutes: actualTime,
                                userName: currentUser?.displayName || currentUser?.email || 'Darbuotojas',
                                userId: currentUser?.uid,
                                isRead: false,
                                createdAt: new Date().toISOString()
                            });
                        } catch (e) {
                            console.error('Failed to send time extension notification:', e);
                        }
                    }
                } else {
                    limitReachedRef.current.add(taskId); // Already reached, just track
                }
            }
        };

        // Check immediately
        checkTime();

        // Then check every 10 seconds
        const interval = setInterval(checkTime, 10000);
        return () => clearInterval(interval);
    }, [activeTask, currentUser]);

    // Dismiss handlers
    const dismissWarning = useCallback(() => {
        setWarningPopup(null);
    }, []);

    const dismissLimit = useCallback(() => {
        SoundManager.stopTimeLimitRepeat();
        setLimitPopup(null);
    }, []);

    return {
        warningPopup,
        limitPopup,
        dismissWarning,
        dismissLimit
    };
}
