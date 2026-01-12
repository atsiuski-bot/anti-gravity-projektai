import React, { useState } from 'react';
import { Play, Square, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { db } from '../firebase';
import { doc, updateDoc, addDoc, collection } from 'firebase/firestore';

export default function WorkDayControls() {
    const { currentUser, workStatus, isTakingBreak } = useAuth();
    const [loading, setLoading] = useState(false);

    // workStatus structure from AuthContext (will need to be added):
    // { isWorking: boolean, currentShiftId: string | null }

    const isWorking = workStatus?.isWorking || false;

    const handleStartWork = async () => {
        if (!currentUser) return;
        setLoading(true);
        try {
            const now = new Date();
            const today = now.toISOString().split('T')[0];

            // 1. Create new shift log
            const shiftRef = await addDoc(collection(db, 'shift_logs'), {
                userId: currentUser.uid,
                date: today,
                startTime: now.toISOString(),
                endTime: null,
                createdAt: now.toISOString()
            });

            // 2. Update user status
            const userRef = doc(db, 'users', currentUser.uid);
            await updateDoc(userRef, {
                workStatus: {
                    isWorking: true,
                    currentShiftId: shiftRef.id,
                    startedAt: now.toISOString()
                },
                // Build reliability: Ensure break is off when starting work? 
                // Maybe not strictly required but good practice if they forgot to stop break.
                // For now, keep it simple.
            });

        } catch (error) {
            console.error("Error starting work:", error);
            alert("Nepavyko pradėti darbo: " + error.message);
        } finally {
            setLoading(false);
        }
    };

    const handleEndWork = async () => {
        if (!currentUser || !workStatus?.currentShiftId) return;
        if (!window.confirm("Ar tikrai norite pabaigti darbą šiai dienai?")) return;

        setLoading(true);
        try {
            const now = new Date();

            // 1. Update shift log
            const shiftRef = doc(db, 'shift_logs', workStatus.currentShiftId);
            await updateDoc(shiftRef, {
                endTime: now.toISOString(),
                updatedAt: now.toISOString()
            });

            // 2. Update user status
            const userRef = doc(db, 'users', currentUser.uid);
            await updateDoc(userRef, {
                workStatus: {
                    isWorking: false,
                    currentShiftId: null,
                    lastEndedAt: now.toISOString()
                }
            });

        } catch (error) {
            console.error("Error ending work:", error);
            alert("Nepavyko pabaigti darbo: " + error.message);
        } finally {
            setLoading(false);
        }
    };

    // If taking a break, we might want to disable "End Work" or allow it (auto-ending break).
    // Let's assume user must end break first, or we can leave it independent.
    // For now, simple independent states.

    return (
        <div className="flex items-center gap-2">
            {!isWorking ? (
                <button
                    onClick={handleStartWork}
                    disabled={loading}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium shadow-sm transition-colors text-sm disabled:opacity-50"
                >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
                    Pradėti darbą
                </button>
            ) : (
                <button
                    onClick={handleEndWork}
                    disabled={loading || isTakingBreak} // Cannot end work while on pause/break? Or maybe yes? Let's disable for safety to avoid weird states.
                    title={isTakingBreak ? "Pirmiausia pabaikite pertrauką" : "Baigti darbo dieną"}
                    className="flex items-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-medium shadow-sm transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4 fill-current" />}
                    Pabaigti darbą
                </button>
            )}
        </div>
    );
}
