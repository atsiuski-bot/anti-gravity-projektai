import React, { useState, useEffect } from 'react';
import { Phone, Square, PhoneOff } from 'lucide-react';
import { doc, getDoc, updateDoc, collection, query, where, getDocs, addDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, resumeTask } from '../utils/taskActions';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { SoundManager } from '../utils/soundUtils';

import { stopBreak, stopQuickWork } from '../utils/userStateActions';

export default function CallTimer({ compact = false }) {
    const { currentUser } = useAuth();
    const [isCalling, setIsCalling] = useState(false);
    const [currentSessionMinutes, setCurrentSessionMinutes] = useState(0);
    const [startTime, setStartTime] = useState(null);

    // Real-time call state listener
    useEffect(() => {
        if (!currentUser) return;

        const userRef = doc(db, 'users', currentUser.uid);

        // Subscribe to real-time updates
        const unsubscribe = onSnapshot(userRef, (userSnap) => {
            if (userSnap.exists()) {
                const data = userSnap.data().callState || {};
                if (data.isCalling) {
                    setIsCalling(true);
                    if (data.lastStartedAt) {
                        setStartTime(new Date(data.lastStartedAt));
                    }
                } else {
                    setIsCalling(false);
                    setStartTime(null);
                    setCurrentSessionMinutes(0);
                }
            }
        });

        return () => unsubscribe();
    }, [currentUser]);

    // Timer effect
    useEffect(() => {
        let interval;
        if (isCalling && startTime) {
            // Update immediately
            const updateTimer = () => {
                const now = new Date();
                const session = (now - startTime) / (1000 * 60);
                setCurrentSessionMinutes(session);
            };
            updateTimer();

            interval = setInterval(updateTimer, 1000);

            // Start sound notification
            SoundManager.startPeriodicBeep();
        } else {
            setCurrentSessionMinutes(0);
            SoundManager.stopPeriodicBeep();
        }
        return () => {
            clearInterval(interval);
            SoundManager.stopPeriodicBeep();
        };
    }, [isCalling, startTime]);

    const handleToggleCall = async () => {
        if (!currentUser) return;

        const userRef = doc(db, 'users', currentUser.uid);

        try {
            if (!isCalling) {
                // START CALL
                // 1. Pause currently running tasks
                const q = query(
                    collection(db, 'tasks'),
                    where('assignedWorkerId', '==', currentUser.uid),
                    where('timerStatus', '==', 'running')
                );
                const snapshot = await getDocs(q);

                const pausePromises = snapshot.docs.map(docSnap => {
                    const taskData = { id: docSnap.id, ...docSnap.data() };
                    return pauseTask(taskData);
                });
                const resumableTaskIds = snapshot.docs.map(doc => doc.id);

                await stopBreak(currentUser.uid);
                await stopQuickWork(currentUser.uid, currentUser.displayName);

                await Promise.all(pausePromises);

                const now = new Date();

                // 2. Update stats in Firestore
                await updateDoc(userRef, {
                    callState: {
                        isCalling: true,
                        lastStartedAt: now.toISOString(),
                        resumableTaskIds: resumableTaskIds
                    }
                });

                setStartTime(now);
                setIsCalling(true);

            } else {
                // STOP CALL
                const now = new Date();
                let sessionDuration = 0;

                if (startTime) {
                    sessionDuration = (now - startTime) / (1000 * 60);
                } else {
                    // Fallback if local state is missing but remote says were calling
                    const s = await getDoc(userRef);
                    const startStr = s.data()?.callState?.lastStartedAt;
                    if (startStr) {
                        const actualStartTime = new Date(startStr);
                        sessionDuration = (now - actualStartTime) / (1000 * 60);
                    }
                }

                // 1. Create the Task for this call
                if (sessionDuration > 0.1) { // Only save if > 6 seconds
                    await addDoc(collection(db, 'tasks'), {
                        title: "Skambutis",
                        description: "Automatiškai sukurtas",
                        status: "completed", // Work hour calculations usually rely on 'completed' status for finished tasks
                        priority: "Medium",
                        assignedWorkerId: currentUser.uid,
                        assignedWorkerName: currentUser.displayName || currentUser.email,
                        createdBy: currentUser.uid,
                        creatorName: currentUser.displayName || currentUser.email,
                        createdAt: new Date().toISOString(),
                        completedAt: now.toISOString(),
                        manualMinutes: sessionDuration, // Store duration here
                        isSystemTask: true // Flag to potentially identify these later
                    });
                }

                // 2. Resume Tasks
                const userSnap = await getDoc(userRef);
                const resumableTaskIds = userSnap.data()?.callState?.resumableTaskIds || [];

                if (resumableTaskIds.length > 0) {
                    const resumePromises = resumableTaskIds.map(async (taskId) => {
                        const tDoc = await getDoc(doc(db, 'tasks', taskId));
                        if (tDoc.exists()) {
                            const tData = { id: tDoc.id, ...tDoc.data() };
                            // Only resume if it's still paused (user didn't change it manually elsewhere)
                            if (tData.timerStatus === 'paused') {
                                return resumeTask(tData, currentUser.uid);
                            }
                        }
                    });
                    await Promise.all(resumePromises);
                }

                // 3. Clear Call State
                await updateDoc(userRef, {
                    callState: {
                        isCalling: false,
                        lastStartedAt: null,
                        resumableTaskIds: []
                    }
                });

                setIsCalling(false);
                setStartTime(null);
                setCurrentSessionMinutes(0);
            }
        } catch (err) {
            console.error("Error toggling call:", err);
            alert("Klaida keičiant skambučio būseną.");
        }
    };

    const totalDisplay = formatMinutesToTimeString(currentSessionMinutes);

    // Render Compact (Mobile)
    if (compact) {
        return (
            <div className="flex flex-col items-center">
                {/* Timer Display */}
                {isCalling && (
                    <span className="text-[10px] font-bold text-blue-600 font-mono mb-1 leading-none animate-pulse">
                        {totalDisplay}
                    </span>
                )}
                {!isCalling && (
                    <span className="text-[10px] font-bold text-transparent font-mono mb-1 leading-none select-none">
                        00:00
                    </span>
                )}

                <button
                    onClick={handleToggleCall}
                    className={clsx(
                        "p-2 rounded-lg transition-all active:scale-95 flex items-center justify-center",
                        isCalling
                            ? 'bg-sky-400 text-white ring-2 ring-sky-100'
                            : 'text-gray-600 hover:bg-gray-100'
                    )}
                    title={isCalling ? "Baigti skambutį" : "Pradėti skambutį"}
                >
                    {isCalling ? (
                        <Square className="w-5 h-5 fill-current" />
                    ) : (
                        <Phone className="w-5 h-5" />
                    )}
                </button>
            </div>
        );
    }

    // Render Desktop (Wide)
    return (
        <button
            onClick={handleToggleCall}
            className={clsx(
                "flex-1 flex items-center justify-between px-4 py-3 rounded-xl transition-all shadow-sm active:scale-95 border min-w-[140px]",
                isCalling
                    ? 'bg-sky-50 border-sky-200 text-sky-900 ring-1 ring-sky-200'
                    : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-gray-300'
            )}
        >
            <div className="flex items-center gap-3">
                <div className={clsx("p-1.5 rounded-lg", isCalling ? "bg-sky-200 text-sky-700" : "bg-gray-100 text-gray-500")}>
                    {isCalling ? (
                        <Square className="w-5 h-5 fill-current" />
                    ) : (
                        <Phone className="w-5 h-5" />
                    )}
                </div>
                <div className="flex flex-col items-start leading-none">
                    <span className="text-xs font-bold uppercase tracking-wider opacity-70">Skambutis</span>
                    {isCalling && <span className="text-[10px] font-semibold text-sky-600">Skambinama...</span>}
                </div>
            </div>

            <span className={clsx(
                "text-lg font-mono font-bold ml-2",
                isCalling ? "text-sky-600" : "text-gray-400"
            )}>
                {totalDisplay}
            </span>
        </button>
    );
}
