import React, { useState, useEffect } from 'react';
import { Coffee, Play } from 'lucide-react';
import { doc, getDoc, updateDoc, collection, query, where, getDocs, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, resumeTask } from '../utils/taskActions';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import clsx from 'clsx';

export default function BreakTimer({ currentUser, compact = false }) {
    const [isTakingBreak, setIsTakingBreak] = useState(false);
    const [accumulatedMinutes, setAccumulatedMinutes] = useState(0);
    const [currentSessionMinutes, setCurrentSessionMinutes] = useState(0);

    // Load initial break state
    useEffect(() => {
        if (!currentUser) return;

        const loadBreakState = async () => {
            const userRef = doc(db, 'users', currentUser.uid);
            const userSnap = await getDoc(userRef);

            if (userSnap.exists()) {
                const data = userSnap.data().breakState || {};
                const today = new Date().toISOString().split('T')[0];

                if (data.lastDate !== today) {
                    setAccumulatedMinutes(0);
                    if (data.isTakingBreak) {
                        setIsTakingBreak(true);
                    }
                } else {
                    setAccumulatedMinutes(data.dailyAccumulatedMinutes || 0);
                    setIsTakingBreak(data.isTakingBreak || false);
                }
            }
        };

        loadBreakState();
    }, [currentUser]);

    const [startTime, setStartTime] = useState(null);

    useEffect(() => {
        if (!currentUser) return;
        if (isTakingBreak) {
            const fetchStart = async () => {
                const userRef = doc(db, 'users', currentUser.uid);
                const snap = await getDoc(userRef);
                if (snap.exists() && snap.data().breakState?.lastStartedAt) {
                    setStartTime(new Date(snap.data().breakState.lastStartedAt));
                }
            };
            fetchStart();
        } else {
            setStartTime(null);
            setCurrentSessionMinutes(0);
        }
    }, [isTakingBreak, currentUser]);

    useEffect(() => {
        if (isTakingBreak && startTime) {
            const interval = setInterval(() => {
                const now = new Date();
                const session = (now - startTime) / (1000 * 60);
                setCurrentSessionMinutes(session);
            }, 1000);
            return () => clearInterval(interval);
        }
    }, [isTakingBreak, startTime]);


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
                const resumableTaskIds = snapshot.docs.map(doc => doc.id);

                await Promise.all(pausePromises);

                await updateDoc(userRef, {
                    breakState: {
                        isTakingBreak: true,
                        lastStartedAt: new Date().toISOString(),
                        dailyAccumulatedMinutes: accumulatedMinutes,
                        lastDate: today,
                        resumableTaskIds: resumableTaskIds
                    }
                });

                setIsTakingBreak(true);

            } else {
                const now = new Date();
                let session = 0;

                if (startTime) {
                    session = (now - startTime) / (1000 * 60);
                } else {
                    const s = await getDoc(userRef);
                    const startStr = s.data()?.breakState?.lastStartedAt;
                    if (startStr) {
                        session = (now - new Date(startStr)) / (1000 * 60);
                    }
                }

                const userSnap = await getDoc(userRef);
                const resumableTaskIds = userSnap.data()?.breakState?.resumableTaskIds || [];

                if (resumableTaskIds.length > 0) {
                    const resumePromises = resumableTaskIds.map(async (taskId) => {
                        const tDoc = await getDoc(doc(db, 'tasks', taskId));
                        if (tDoc.exists()) {
                            const tData = { id: tDoc.id, ...tDoc.data() };
                            if (tData.timerStatus === 'paused') {
                                return resumeTask(tData);
                            }
                        }
                    });

                    await Promise.all(resumePromises);
                }

                const newTotal = accumulatedMinutes + session;

                await updateDoc(userRef, {
                    breakState: {
                        isTakingBreak: false,
                        lastStartedAt: null,
                        dailyAccumulatedMinutes: newTotal,
                        lastDate: today,
                        resumableTaskIds: []
                    }
                });

                try {
                    const statsId = `${currentUser.uid}_${today}`;
                    await setDoc(doc(db, 'daily_stats', statsId), {
                        userId: currentUser.uid,
                        date: today,
                        breakMinutes: newTotal,
                        updatedAt: new Date().toISOString()
                    }, { merge: true });
                } catch (err) {
                    console.error("Error logging daily stats:", err);
                }

                setAccumulatedMinutes(newTotal);
                setIsTakingBreak(false);
                setCurrentSessionMinutes(0);
            }
        } catch (err) {
            console.error("Error toggling break:", err);
            alert("Klaida keičiant pertraukos būseną.");
        }
    };

    const totalDisplay = formatMinutesToTimeString(accumulatedMinutes + currentSessionMinutes);

    if (compact) {
        return (
            <div className="flex flex-col items-center">
                <span className="text-[10px] font-bold text-gray-700 font-mono mb-1 leading-none">
                    {totalDisplay}
                </span>
                <button
                    onClick={handleToggleBreak}
                    className={clsx(
                        "p-2.5 rounded-full transition-all shadow-md active:scale-95",
                        isTakingBreak
                            ? 'bg-amber-500 text-white ring-4 ring-amber-100'
                            : 'bg-blue-600 text-white hover:bg-blue-700'
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
            <div className="flex flex-col items-end mr-2">
                <span className="text-sm font-medium text-gray-700 font-mono">
                    {totalDisplay}
                </span>
            </div>

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
