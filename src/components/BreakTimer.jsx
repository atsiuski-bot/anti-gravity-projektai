import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTimerState } from '../hooks/useTimerState';
import { Coffee, Play } from 'lucide-react';
import { doc, getDoc, updateDoc, collection, query, where, getDocs, setDoc, arrayUnion, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, resumeTask } from '../utils/taskActions';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import clsx from 'clsx';
import { SoundManager } from '../utils/soundUtils';

import { stopBreak, stopCall, stopQuickWork } from '../utils/userStateActions';

export default function BreakTimer({ currentUser: propUser, compact = false }) {
    const { currentUser, userData } = useAuth();
    const {
        isActive: isTakingBreak,
        setIsActive: setIsTakingBreak,
        currentSessionMinutes,
        accumulatedMinutes,
        setAccumulatedMinutes
    } = useTimerState(currentUser, 'breakState', 'isTakingBreak');

    const handleToggleBreak = async () => {
        if (!currentUser) return;

        const userRef = doc(db, 'users', currentUser.uid);
        const today = new Date().toISOString().split('T')[0];

        try {
            if (!isTakingBreak) {
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

                // Collect currently running tasks
                const currentTaskIds = snapshot.docs.map(doc => doc.id);

                // Fetch existing state
                const userSnap = await getDoc(userRef);
                const userData = userSnap.data() || {};
                const callResumables = userData.callState?.resumableTaskIds || [];
                const quickWorkResumables = userData.quickWorkState?.resumableTaskIds || [];

                // Combine all resumables (prevent duplicates)
                const allResumableTaskIds = [...new Set([...currentTaskIds, ...callResumables, ...quickWorkResumables])];

                // Check for Quick Work
                if (userData?.quickWorkState?.isQuickWorking) {
                    window.dispatchEvent(new CustomEvent('stop-quick-work'));
                    return;
                }

                await stopCall(currentUser.uid, currentUser.displayName);
                // await stopQuickWork(currentUser.uid, currentUser.displayName); // Handled via event

                await Promise.all(pausePromises);

                await updateDoc(userRef, {
                    breakState: {
                        isTakingBreak: true,
                        lastStartedAt: new Date().toISOString(),
                        dailyAccumulatedMinutes: accumulatedMinutes,
                        lastDate: today,
                        resumableTaskIds: allResumableTaskIds
                    }
                });

                // Play Break sound
                SoundManager.playBreakSound();

                setIsTakingBreak(true);

            } else {
                await stopBreak(currentUser.uid);

                // Play Break sound when stopping
                SoundManager.playBreakSound();

                // Fetch stats to update local component state if needed (optional but good for syncing)
                const s = await getDoc(userRef);
                const data = s.data().breakState || {};
                setAccumulatedMinutes(data.dailyAccumulatedMinutes || 0);

                setIsTakingBreak(false);
            }
        } catch (err) {
            console.error("Error toggling break:", err);
            alert("Klaida keičiant pertraukos būseną.");
        }
    };

    const totalDisplay = formatMinutesToTimeString(currentSessionMinutes);

    if (compact) {
        return (
            <div className="flex flex-col items-center">
                {isTakingBreak && (
                    <span className="text-[10px] font-bold text-gray-700 font-mono mb-1 leading-none">
                        {totalDisplay}
                    </span>
                )}
                {!isTakingBreak && (
                    <span className="text-[10px] font-bold text-transparent font-mono mb-1 leading-none select-none">
                        00:00
                    </span>
                )}
                <button
                    onClick={handleToggleBreak}
                    className={clsx(
                        "p-2 rounded-lg transition-all active:scale-95",
                        isTakingBreak
                            ? 'bg-amber-500 text-white ring-2 ring-amber-100'
                            : 'text-gray-600 hover:bg-gray-100'
                    )}
                    title={isTakingBreak ? "Tęsti darbą" : "Pertrauka"}
                >
                    {isTakingBreak ? (
                        <Play className="w-5 h-5 fill-current" />
                    ) : (
                        <Coffee className="w-5 h-5" />
                    )}
                </button>
            </div>
        );
    }



    return (
        <div className="flex items-center gap-3">
            {isTakingBreak && (
                <div className="flex flex-col items-end mr-2">
                    <span className="text-sm font-medium text-gray-700 font-mono">
                        {totalDisplay}
                    </span>
                </div>
            )}

            <button
                onClick={handleToggleBreak}
                className={`
                    flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm
                    ${isTakingBreak
                        ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 border border-amber-200'
                        : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-300'
                    }
                `}
            >
                {isTakingBreak ? (
                    <>
                        <Play className="w-4 h-4 fill-current" />
                        Tęsti darbą
                    </>
                ) : (
                    <>
                        <Coffee className="w-4 h-4" />
                        Pertrauka
                    </>
                )}
            </button>
        </div>
    );
}
