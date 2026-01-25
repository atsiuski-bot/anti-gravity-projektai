import React, { useState, useEffect } from 'react';
import { useTimerState } from '../hooks/useTimerState';
import { Phone, Square, PhoneOff } from 'lucide-react';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { SoundManager } from '../utils/soundUtils';
import { startSession, endSession } from '../utils/sessionActions';

export default function CallTimer({ compact = false }) {
    const { currentUser, userData } = useAuth(); // Added userData

    const {
        isActive: isCalling,
        currentSessionMinutes,
    } = useTimerState(currentUser, 'callState', 'isCalling', null, null, 'call');

    const handleToggleCall = async () => {
        if (!currentUser) return;

        try {
            if (!isCalling) {
                // START CALL
                await startSession(currentUser.uid, 'call');

                // Play Call sound
                SoundManager.playCallSound();

            } else {
                // STOP CALL
                await endSession(currentUser.uid);

                // Play Call sound when stopping
                SoundManager.playCallSound();
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
