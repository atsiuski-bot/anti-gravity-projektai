import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, Square, Clock } from 'lucide-react';
import { doc, updateDoc, collection, addDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString, parseTimeStringToMinutes, getLithuanianNow, getLithuanianDateString } from '../utils/timeUtils';
import { startTask, pauseTask, resumeTask, archiveTask } from '../utils/taskActions';
import { isManagerRole } from '../utils/formatters';
import { useAuth } from '../context/AuthContext';
import { useActiveSessionStatus } from '../hooks/useActiveSessionStatus';

// stopBreak/stopCall no longer needed — startTask/resumeTask handle session cleanup

export default function TaskTimerControls({ task, onShowModal, role }) {
    const { currentUser, userRole, userData, setOptimisticUserData } = useAuth();
    const { isSecondarySessionActive } = useActiveSessionStatus();
    const isAssignedToMe = currentUser?.uid === task.assignedUserId;

    // Only allow the assigned worker to control the task
    // And restrict managers from controlling tasks in the Team View (where role === 'manager')
    if (!isAssignedToMe || isManagerRole(role)) return null;

    // Strict UI logic: The task document (timerStatus) is the ULTIMATE source of truth for the timer.
    // We only display as running if BOTH the task and user profile agree.
    let isRunning = false;
    let isPaused = false;

    if (isAssignedToMe) {
        if (task.timerStatus === 'running') {
            isRunning = true;
        }
        
        // If it's not running right now, but timerStatus is explicitly 'paused', it must be paused
        if (!isRunning && task.timerStatus === 'paused') {
            isPaused = true;
        }
    } else {
         isRunning = task.timerStatus === 'running';
         isPaused = task.timerStatus === 'paused';
    }

    const [elapsedString, setElapsedString] = useState('');

    useEffect(() => {
        const updateTime = () => {
            const totalMinutes = calculateCurrentTotalMinutes(task);
            const h = Math.floor(totalMinutes / 60);
            const m = Math.floor(totalMinutes % 60);
            setElapsedString(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
        };

        updateTime();

        let interval;
        if (isRunning) {
            interval = setInterval(updateTime, 1000);
        }
        return () => clearInterval(interval);
    }, [isRunning, task]);

    const handleStart = async (e) => {
        e.stopPropagation();
        if (isSecondarySessionActive) return;
        try {
            if (currentUser) {
                // Check if Quick Work is running - if so, prompt to stop it first
                if (userData?.quickWorkState?.isQuickWorking) {
                    window.dispatchEvent(new CustomEvent('stop-quick-work'));
                    return;
                }

                // Optimistic UI Update: Instantly assume task started and clear other sessions
                setOptimisticUserData({
                    ...userData,
                    activeSession: { type: 'task', startTime: new Date().toISOString(), taskId: task.id },
                    workStatus: { isWorking: true, status: 'running', activeTaskId: task.id },
                    breakState: { ...userData?.breakState, isTakingBreak: false },
                    callState: { ...userData?.callState, isCalling: false },
                    quickWorkState: { ...userData?.quickWorkState, isQuickWorking: false }
                });

                // Start task directly — startTask handles pausing other tasks
                // and updating the activeSession. No need to stop break/call separately.
                await startTask(task, currentUser.uid);
            }
        } catch (err) {
            console.error("Error starting timer:", err);
            setOptimisticUserData(null); // Revert on error
            // Only alert if we think it's a critical failure and we are online
            if (navigator.onLine) {
                alert("Nepavyko pradėti laikmačio.");
            }
        }
    };

    const handlePause = async (e) => {
        e.stopPropagation();
        if (!task.timerStartedAt) return;

        try {
            // Optimistic UI: instantly show paused state
            setOptimisticUserData({
                ...userData,
                activeSession: null,
                workStatus: { isWorking: false, status: 'paused', activeTaskId: task.id }
            });

            await pauseTask(task);
        } catch (err) {
            console.error("Error pausing timer:", err);
            setOptimisticUserData(null);
            if (navigator.onLine) {
                alert("Nepavyko sustabdyti laikmačio.");
            }
        }
    };

    const handleResume = async (e) => {
        e.stopPropagation();
        if (isSecondarySessionActive) return;
        try {
            if (currentUser) {
                // Check if Quick Work is running
                if (userData?.quickWorkState?.isQuickWorking) {
                    window.dispatchEvent(new CustomEvent('stop-quick-work'));
                    return;
                }

                // Optimistic UI Update: Instantly assume task resumed and clear other sessions
                setOptimisticUserData({
                    ...userData,
                    activeSession: { type: 'task', startTime: new Date().toISOString(), taskId: task.id },
                    workStatus: { isWorking: true, status: 'running', activeTaskId: task.id },
                    breakState: { ...userData?.breakState, isTakingBreak: false },
                    callState: { ...userData?.callState, isCalling: false }
                });

                // Resume task directly — resumeTask handles pausing other tasks
                // and updating the activeSession. No need to stop break/call separately.
                await resumeTask(task, currentUser.uid);
            }
        } catch (err) {
            console.error("Error resuming timer:", err);
            setOptimisticUserData(null); // Revert
            if (navigator.onLine) {
                alert("Nepavyko atnaujinti laikmačio.");
            }
        }
    };

    const handleFinish = async (e) => {
        e.stopPropagation();

        if (!window.confirm("Ar tikrai norite užbaigti užduotį?")) {
            return;
        }

        try {
            let finalTimerMinutes = task.timerMinutes || 0;
            let currentManualMinutes = task.manualMinutes || 0;
            const start = task.timerStartedAt ? new Date(task.timerStartedAt) : null;
            const now = getLithuanianNow();

            // 1. If running, calculate elapsed
            if (isRunning && start) {
                const elapsedMinutes = (now - start) / (1000 * 60);
                finalTimerMinutes += elapsedMinutes;
            }

            // 2. Prepare task data for completion
            const isManagerOrAdmin = isManagerRole(userRole) || currentUser?.uid === task.managerId;
            const totalMinutes = finalTimerMinutes + currentManualMinutes;
            const formattedTime = formatMinutesToTimeString(totalMinutes);

            const { assignedUserName, assignedWorkerColor, creatorName, ...cleanTask } = task;

            const taskData = {
                ...cleanTask,
                timerStatus: 'paused',
                timerStartedAt: null,
                timerMinutes: finalTimerMinutes,
                manualMinutes: currentManualMinutes,
                actualTime: formattedTime,
                status: isManagerOrAdmin ? 'confirmed' : 'completed',
                completed: true,
                completedAt: now.toISOString(),
                confirmedBy: isManagerOrAdmin ? currentUser.uid : null,
                confirmedAt: isManagerOrAdmin ? now.toISOString() : null,
                updatedAt: now.toISOString()
            };

            // 3. Run task update + user status update in PARALLEL, work session log fire-and-forget
            if (isRunning && start) {
                const elapsedMinutes = (now - start) / (1000 * 60);
                if (elapsedMinutes > 0.1) {
                    // Fire and forget work session log
                    // Attribute to the end date (now), consistent with the other
                    // work_sessions writers - start-based mis-bucketed midnight-spanning work.
                    const sessionDate = getLithuanianDateString(now);
                    addDoc(collection(db, 'work_sessions'), {
                        taskId: task.id,
                        taskTitle: task.title || 'Unknown Task',
                        userId: task.assignedUserId,
                        userName: currentUser.displayName || currentUser.email,
                        startTime: start.toISOString(),
                        endTime: now.toISOString(),
                        durationMinutes: elapsedMinutes,
                        date: sessionDate,
                        createdAt: new Date().toISOString()
                    }).catch(logErr => console.error("Error logging final work session:", logErr));
                }
            }

            const promises = [updateDoc(doc(db, 'tasks', task.id), taskData)];

            if (task.assignedUserId === currentUser.uid) {
                // Determine if this task was the user's active one based on stale closure
                const wasRunning = isRunning && start;
                const wasActiveSession = userData?.activeSession?.taskId === task.id;
                const wasWorkStatusActive = userData?.workStatus?.activeTaskId === task.id;

                let shouldClearUserSession = false;

                if (wasRunning || wasActiveSession || wasWorkStatusActive) {
                    // Fetch real-time user doc to prevent race condition 
                    // where user actively started another task before finish completed
                    try {
                        const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
                        if (userSnap.exists()) {
                            const uData = userSnap.data();
                            const currentActiveTaskId = uData?.activeSession?.taskId || uData?.workStatus?.activeTaskId;
                            // Only clear if no task is active, or the currently active task is THIS task
                            if (!currentActiveTaskId || currentActiveTaskId === task.id) {
                                shouldClearUserSession = true;
                            }
                        } else {
                            shouldClearUserSession = true;
                        }
                    } catch (fetchErr) {
                        console.warn("Failed to fetch user doc to validate finish:", fetchErr);
                        shouldClearUserSession = true; // Fallback
                    }
                }

                if (shouldClearUserSession) {
                    promises.push(
                        updateDoc(doc(db, 'users', currentUser.uid), {
                            workStatus: {
                                isWorking: false,
                                status: 'idle',
                                activeTaskId: null,
                                lastUpdated: new Date().toISOString()
                            },
                            activeSession: null
                        })
                    );
                }
            }

            await Promise.all(promises);

            // Send task_completion notification to manager (workers only)
            if (!isManagerOrAdmin) {
                try {
                    // Determine recipient: task manager, fallback to user's defaultManager
                    let recipientId = task.managerId || null;
                    if (!recipientId || recipientId === currentUser.uid) {
                        recipientId = userData?.defaultManager || null;
                    }
                    if (recipientId && recipientId !== currentUser.uid) {
                        await addDoc(collection(db, 'request_notifications'), {
                            recipientId,
                            type: 'task_completion',
                            taskId: task.id,
                            taskTitle: task.title || 'Užduotis',
                            actualTime: formattedTime,
                            actualMinutes: totalMinutes,
                            userName: currentUser.displayName || currentUser.email || 'Darbuotojas',
                            userId: currentUser.uid,
                            completedAt: now.toISOString(),
                            isRead: false,
                            createdAt: new Date().toISOString()
                        });
                    }
                } catch (notifErr) {
                    console.error('Failed to send task completion notification:', notifErr);
                }
            }

            console.log(`Task ${task.id} finished and archived`);
        } catch (err) {
            console.error("Error finishing task:", err);
            if (navigator.onLine) {
                alert("Nepavyko užbaigti užduoties: " + err.message);
            }
        }
    };

    // If task is completed/confirmed, show the final total time instead of hiding
    if (task.status === 'completed' || task.status === 'confirmed' || task.status === 'unapproved') {
        const totalMinutes = calculateCurrentTotalMinutes(task);
        return (
            <div className="mt-3 border-t pt-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500">Praleistas laikas:</span>
                <span className="text-sm font-bold text-blue-600 flex items-center gap-1">
                    <Clock className="w-4 h-4" />
                    {formatMinutesToTimeString(totalMinutes)}
                </span>
            </div>
        );
    }

    const currentTotalMinutes = calculateCurrentTotalMinutes(task);
    const estMinutes = parseTimeStringToMinutes(task.estimatedTime || '0');
    // If estimated time is > 0 and we've reached it, the limit is exceeded.
    // This perfectly encapsulates normal limits, time extensions, and time deductions.
    const isLimitExceeded = estMinutes > 0 && currentTotalMinutes >= estMinutes;

    return (
        <div className="flex items-center gap-2 mt-3 border-t pt-3">
            {/* Toggle Button: Pradėti / Pauzė / Tęsti */}
            {isRunning ? (
                <button
                    type="button"
                    onClick={handlePause}
                    disabled={isSecondarySessionActive}
                    className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${isSecondarySessionActive
                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                        }`}
                >
                    <Pause className="w-3.5 h-3.5 flex-shrink-0" />
                    Pauzė {elapsedString}
                </button>
            ) : isLimitExceeded ? (
                /* Start Button Removed when Limit Exceeded (User request: remove start button) */
                <div className="flex-1 flex items-center justify-center px-2 py-1.5 text-xs font-semibold text-red-500 bg-red-50 rounded border border-red-100 whitespace-nowrap">
                    Laikas išnaudotas
                </div>
            ) : (
                <button
                    type="button"
                    onClick={isPaused ? handleResume : handleStart}
                    disabled={isSecondarySessionActive}
                    className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${isSecondarySessionActive
                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                        }`}
                    title={isSecondarySessionActive ? "Kitas veiksmas jau aktyvus" : ""}
                >
                    <Play className="w-3.5 h-3.5 flex-shrink-0" />
                    {isPaused ? 'Tęsti' : 'Pradėti'} {elapsedString !== '00:00' ? elapsedString : ''}
                </button>
            )}

            {/* UŽBAIGTI */}
            <button
                type="button"
                onClick={handleFinish}
                disabled={isSecondarySessionActive}
                className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${isSecondarySessionActive
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
                    }`}
                title={isSecondarySessionActive ? "Kitas veiksmas jau aktyvus" : ""}
            >
                <Square className="w-3.5 h-3.5 flex-shrink-0" />
                Užbaigti
            </button>
        </div>
    );
}
