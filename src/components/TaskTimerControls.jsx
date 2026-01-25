import React, { useState, useEffect } from 'react';
import { Play, Pause, Square } from 'lucide-react';
import { doc, updateDoc, collection, addDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { calculateCurrentTotalMinutes, formatMinutesToTimeString, parseTimeStringToMinutes } from '../utils/timeUtils';
import { startTask, pauseTask, resumeTask, archiveTask } from '../utils/taskActions';
import { useAuth } from '../context/AuthContext';

import { stopBreak, stopCall, stopQuickWork } from '../utils/userStateActions';

export default function TaskTimerControls({ task, onShowModal, role }) {
    const { isTakingBreak, currentUser, userRole, userData } = useAuth();
    const isAssignedToMe = currentUser?.uid === task.assignedWorkerId;

    // Only allow the assigned worker to control the task
    // And restrict managers from controlling tasks in the Team View (where role === 'manager')
    if (!isAssignedToMe || role === 'manager' || role === 'admin') return null;

    const isRunning = task.timerStatus === 'running';
    const isPaused = task.timerStatus === 'paused';

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
        try {
            if (currentUser) {
                // Check if Quick Work is running - if so, prompt to stop it first
                if (userData?.quickWorkState?.isQuickWorking) {
                    window.dispatchEvent(new CustomEvent('stop-quick-work'));
                    return;
                }

                // Stop other activities
                await stopBreak(currentUser.uid);
                await stopCall(currentUser.uid, currentUser.displayName);
                // await stopQuickWork(currentUser.uid, currentUser.displayName); // Removed as we handle it via event now

                await startTask(task, currentUser.uid);
            }
        } catch (err) {
            console.error("Error starting timer:", err);
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
            await pauseTask(task);
        } catch (err) {
            console.error("Error pausing timer:", err);
            if (navigator.onLine) {
                alert("Nepavyko sustabdyti laikmačio."); // Usually pause is less critical to alert
            }
        }
    };

    const handleResume = async (e) => {
        e.stopPropagation();
        try {
            if (currentUser) {
                // Check if Quick Work is running
                if (userData?.quickWorkState?.isQuickWorking) {
                    window.dispatchEvent(new CustomEvent('stop-quick-work'));
                    return;
                }

                // Also stop break/call if resuming? Usually resume implies start.
                await stopBreak(currentUser.uid);
                await stopCall(currentUser.uid, currentUser.displayName);

                await resumeTask(task, currentUser.uid);
            }
        } catch (err) {
            console.error("Error resuming timer:", err);
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
            const now = new Date();

            // 1. If running, calculate elapsed and update records
            if (isRunning && start) {
                const elapsedMinutes = (now - start) / (1000 * 60);
                finalTimerMinutes += elapsedMinutes;

                // Log work session
                if (elapsedMinutes > 0.1) {
                    try {
                        const sessionDate = start.toISOString().split('T')[0];
                        await addDoc(collection(db, 'work_sessions'), {
                            taskId: task.id,
                            taskTitle: task.title || 'Unknown Task',
                            workerId: task.assignedWorkerId,
                            workerName: currentUser.displayName || currentUser.email,
                            startTime: start.toISOString(),
                            endTime: now.toISOString(),
                            durationMinutes: elapsedMinutes,
                            date: sessionDate,
                            createdAt: new Date().toISOString()
                        });
                    } catch (logErr) {
                        console.error("Error logging final work session:", logErr);
                        // Non-critical, continue
                    }
                }
            }

            // 2. Prepare task data for completion
            const isManagerOrAdmin = userRole === 'manager' || userRole === 'admin';
            const totalMinutes = finalTimerMinutes + currentManualMinutes;
            const formattedTime = formatMinutesToTimeString(totalMinutes);

            const taskData = {
                ...task,
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

            // 3. Do NOT archive immediately. Update task status and completion.
            await updateDoc(doc(db, 'tasks', task.id), taskData);

            // 4. Update User Status to Idle
            await updateDoc(doc(db, 'users', currentUser.uid), {
                workStatus: {
                    isWorking: false,
                    status: 'idle',
                    activeTaskId: null,
                    lastUpdated: new Date().toISOString()
                },
                activeSession: null // Clear generic session
            });

            console.log(`Task ${task.id} finished and archived`);
        } catch (err) {
            console.error("Error finishing task:", err);
            if (navigator.onLine) {
                alert("Nepavyko užbaigti užduoties: " + err.message);
            }
        }
    };

    // If task is completed/confirmed, maybe don't show controls?
    if (task.status === 'completed' || task.status === 'confirmed') return null;

    return (
        <div className="flex items-center gap-2 mt-3 border-t pt-3">
            {/* Toggle Button: Pradėti / Pauzė / Tęsti */}
            {isRunning ? (
                <button
                    type="button"
                    onClick={handlePause}
                    disabled={isTakingBreak}
                    className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${isTakingBreak
                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                        }`}
                >
                    <Pause className="w-3.5 h-3.5 flex-shrink-0" />
                    Pauzė {elapsedString}
                </button>
            ) : (
                <button
                    type="button"
                    onClick={isPaused ? handleResume : handleStart}
                    disabled={isTakingBreak}
                    className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${isTakingBreak
                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                        }`}
                    title={isTakingBreak ? "Pertraukos metu negalima dirbti" : ""}
                >
                    <Play className="w-3.5 h-3.5 flex-shrink-0" />
                    {isPaused ? 'Tęsti' : 'Pradėti'} {elapsedString !== '00:00' ? elapsedString : ''}
                </button>
            )}

            {/* UŽBAIGTI */}
            <button
                type="button"
                onClick={handleFinish}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded transition-colors bg-gray-50 text-gray-700 hover:bg-gray-100 whitespace-nowrap"
            >
                <Square className="w-3.5 h-3.5 flex-shrink-0" />
                Užbaigti
            </button>
        </div>
    );
}
