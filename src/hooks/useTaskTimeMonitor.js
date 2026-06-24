import { useState, useEffect, useRef, useCallback } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { calculateCurrentTotalMinutes, parseTimeStringToMinutes } from '../utils/timeUtils';
import { pauseTask, requestTimeExtension, completeTaskAtLimit } from '../utils/taskActions';
import { SoundManager } from '../utils/soundUtils';
import { useAuth } from '../context/AuthContext';

/**
 * Hook that monitors the active running task for time limit thresholds.
 * - At 70% of estimatedTime: shows warning popup + plays warning sound (FYI, task keeps running)
 * - At 100%: auto-pauses task (time STOPS), plays a repeating alarm, and shows the time-limit
 *   popup. The popup gives the worker two explicit choices — request more time from the manager
 *   (optionally with a note/photos) or finish the task (→ manager acceptance). The hook no longer
 *   auto-fires the extension request: that is now a deliberate worker action (see requestExtension).
 *
 * @param {Array} tasks - Array of task objects to monitor
 * @returns {Object} state for popups + the limit-popup action handlers
 */
export function useTaskTimeMonitor(tasks) {
    const { currentUser, userRole, userData } = useAuth();

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
        // Must not be finished. A task can briefly be both "completed/confirmed" AND still
        // carry timerStatus:'running' (e.g. a same-day completed task left in the list); without
        // this guard the monitor would auto-pause, alarm, and fire a manager time-extension
        // request on a task the worker already closed. Mirrors the resume guard in sessionActions.
        if (t.completed || t.status === 'completed' || t.status === 'confirmed' || t.status === 'deleted') return false;
        return true;
    });

    // Keep a live reference to the active task so the interval can read fresh data each tick
    // WITHOUT being torn down and recreated on every render. `activeTask` is a brand-new
    // object on every Firestore snapshot (and every 1s parent re-render), so depending on the
    // object directly churned the 10s interval before it could ever fire — making the
    // auto-pause/alarm detection unreliable. We depend on stable primitives instead.
    const activeTaskRef = useRef(null);
    activeTaskRef.current = activeTask;

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
            // Read the freshest task snapshot from the ref; bail if it changed/cleared.
            const task = activeTaskRef.current;
            if (!task || task.id !== taskId) return;

            const currentMinutes = calculateCurrentTotalMinutes(task);
            const percentage = (currentMinutes / estimatedMinutes) * 100;

            // Dynamic Unlatching: If time was manually deducted, re-arm the triggers and auto-heal the DB flags
            if (percentage < 100) {
                if (limitReachedRef.current.has(taskId)) limitReachedRef.current.delete(taskId);
                if (task.timeLimitReached) {
                    try { updateDoc(doc(db, 'tasks', taskId), { timeLimitReached: false }); } catch(e) { /* intentionally ignored */ }
                }
            }
            if (percentage < 70) {
                if (warned70Ref.current.has(taskId)) warned70Ref.current.delete(taskId);
                if (task.warningShown70) {
                    try { updateDoc(doc(db, 'tasks', taskId), { warningShown70: false }); } catch(e) { /* intentionally ignored */ }
                }
            }

            // 70% warning
            if (percentage >= 70 && percentage < 100 && !warned70Ref.current.has(taskId)) {
                // Check Firestore flag — maybe warning was already shown in a previous session
                if (!task.warningShown70) {
                    warned70Ref.current.add(taskId);
                    const remaining = Math.max(0, Math.round(estimatedMinutes - currentMinutes));
                    setWarningPopup({ task, remaining });
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
                if (!task.timeLimitReached) {
                    limitReachedRef.current.add(taskId);

                    // 1. Auto-pause the task
                    try {
                        await pauseTask(task);
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

                    // 3. Show popup — the worker decides from here (request more time OR finish).
                    //    The extension request is no longer auto-sent; it is a choice in the popup.
                    const actualTime = Math.round(currentMinutes);
                    setLimitPopup({
                        task,
                        estimatedTime: task.estimatedTime,
                        actualMinutes: actualTime
                    });

                    // 4. Start repeating alarm
                    SoundManager.startTimeLimitRepeat();
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
        // Depend on stable primitives, not the activeTask object reference, so the interval
        // survives snapshot churn and only resets on a genuine task / estimate / user change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTask?.id, activeTask?.estimatedTime, currentUser?.uid]);

    // Dismiss handler (warning popup only — the limit popup is forced and closes via its actions).
    const dismissWarning = useCallback(() => {
        setWarningPopup(null);
    }, []);

    // Worker chose "request more time" in the limit popup. Sends the manager an extension request
    // carrying an optional note + photos, then silences the alarm and closes the popup. The task
    // stays paused; the manager granting re-arms the monitor (extendTaskTime clears the latch).
    const requestExtension = useCallback(async ({ commentText, attachmentUrls } = {}) => {
        if (!limitPopup?.task) return;
        await requestTimeExtension({
            task: limitPopup.task,
            currentUser,
            estimatedTime: limitPopup.estimatedTime,
            actualMinutes: limitPopup.actualMinutes,
            commentText,
            attachmentUrls
        });
        SoundManager.stopTimeLimitRepeat();
        setLimitPopup(null);
    }, [limitPopup, currentUser]);

    // Worker chose "finish work" in the limit popup. The timer is already paused, so this only
    // writes the completion fields (→ manager acceptance for a worker) and closes the popup.
    const finishFromLimit = useCallback(async () => {
        if (!limitPopup?.task) return;
        const result = await completeTaskAtLimit(limitPopup.task, { currentUser, userData, userRole });
        SoundManager.stopTimeLimitRepeat();
        setLimitPopup(null);
        return result;
    }, [limitPopup, currentUser, userData, userRole]);

    return {
        warningPopup,
        limitPopup,
        dismissWarning,
        requestExtension,
        finishFromLimit
    };
}
