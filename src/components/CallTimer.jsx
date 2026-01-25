import React, { useState, useEffect } from 'react';
import { useTimerState } from '../hooks/useTimerState';
import { Phone, Square, PhoneOff } from 'lucide-react';
import { doc, getDoc, updateDoc, collection, query, where, getDocs, addDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, resumeTask } from '../utils/taskActions';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { SoundManager } from '../utils/soundUtils';

import { stopBreak, stopQuickWork, stopCall } from '../utils/userStateActions';

export default function CallTimer({ compact = false }) {
    const { currentUser, userData } = useAuth(); // Added userData

    const {
        isActive: isCalling,
        setIsActive: setIsCalling,
        currentSessionMinutes,
    } = useTimerState(currentUser, 'callState', 'isCalling');

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

                // Collect currently running tasks
                const currentTaskIds = snapshot.docs.map(doc => doc.id);

                // Fetch existing state to see if we need to inherit resumable IDs
                const userSnap = await getDoc(userRef);
                const userData = userSnap.data() || {};
                const breakResumables = userData.breakState?.resumableTaskIds || [];
                const quickWorkResumables = userData.quickWorkState?.resumableTaskIds || [];

                // Combine all resumables (prevent duplicates)
                const allResumableTaskIds = [...new Set([...currentTaskIds, ...breakResumables, ...quickWorkResumables])];

                // Check if Quick Work is running
                if (userData?.quickWorkState?.isQuickWorking) {
                    window.dispatchEvent(new CustomEvent('stop-quick-work'));
                    return;
                }

                await stopBreak(currentUser.uid);
                // await stopQuickWork(currentUser.uid, currentUser.displayName); // Handled via event


                await Promise.all(pausePromises);

                const now = new Date();

                // 2. Update stats in Firestore
                await updateDoc(userRef, {
                    callState: {
                        isCalling: true,
                        lastStartedAt: now.toISOString(),
                        resumableTaskIds: allResumableTaskIds
                    }
                });

                // Play Call sound
                SoundManager.playCallSound();

                setIsCalling(true);

            } else {
                // STOP CALL
                await stopCall(currentUser.uid, currentUser.displayName);

                // Play Call sound when stopping
                SoundManager.playCallSound();

                setIsCalling(false);
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
