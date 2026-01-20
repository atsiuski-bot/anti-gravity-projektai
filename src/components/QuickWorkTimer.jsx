import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { Zap, Square, X, Check } from 'lucide-react';
import { doc, getDoc, updateDoc, collection, query, where, getDocs, addDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask, resumeTask } from '../utils/taskActions';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { SoundManager } from '../utils/soundUtils';

import { stopBreak, stopCall } from '../utils/userStateActions';

// Separate memoized modal component to prevent re-renders from timer updates
const QuickWorkModalComponent = React.memo(({ onSubmit, onClose, currentSessionMinutes, isSubmitting }) => {
    const textareaRef = useRef(null);
    const totalDisplay = formatMinutesToTimeString(currentSessionMinutes);

    const handleSubmit = (e) => {
        e.preventDefault();
        const titleFromTextarea = textareaRef.current?.value || '';
        if (titleFromTextarea.trim()) {
            onSubmit(titleFromTextarea);
        }
    };

    return ReactDOM.createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4">
            <form
                onSubmit={handleSubmit}
                className="bg-white w-full max-w-md rounded-3xl shadow-2xl flex flex-col overflow-hidden"
                style={{ maxHeight: '80vh' }}
            >
                {/* Header */}
                <div className="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
                    <div>
                        <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                            <Zap className="w-6 h-6 text-red-500 fill-current" />
                            Greito darbo pabaiga
                        </h3>
                        <p className="text-sm text-gray-500 mt-1">Įveskite atlikto darbo aprašymą</p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 p-3 hover:bg-gray-100 rounded-full transition-colors"
                    >
                        <X className="w-7 h-7" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-5 flex-1 overflow-y-auto">
                    <div className="mb-5 bg-red-50 rounded-2xl p-4 border border-red-200 flex items-center justify-between">
                        <span className="text-red-700 font-semibold text-base">Užfiksuotas laikas:</span>
                        <span className="text-4xl font-mono font-bold text-red-600">{totalDisplay}</span>
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-gray-700 mb-2 uppercase tracking-wide">
                            Ką nuveikėte?
                        </label>
                        <textarea
                            ref={textareaRef}
                            id="quickWorkTextarea"
                            name="taskDescription"
                            placeholder="Trumpai aprašykite atliktą darbą..."
                            autoFocus
                            lang="en"
                            dir="ltr"
                            rows={4}
                            style={{
                                width: '100%',
                                padding: '12px',
                                fontSize: '16px',
                                border: '2px solid #e5e7eb',
                                borderRadius: '12px',
                                resize: 'none',
                                background: 'white',
                                color: '#000',
                                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                                direction: 'ltr',
                                textAlign: 'left'
                            }}
                            required
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-200 bg-gray-50 flex gap-3 justify-end">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-6 py-3 text-sm text-gray-600 bg-white border-2 border-gray-300 hover:bg-gray-50 rounded-xl font-semibold transition-all shadow-sm">
                        Atšaukti
                    </button>
                    <button
                        type="submit"
                        disabled={isSubmitting}
                        className="px-8 py-3 text-sm bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {isSubmitting ? 'Saugoma...' : (
                            <>
                                <Check className="w-5 h-5" />
                                Išsaugoti darbą
                            </>
                        )}
                    </button>
                </div>
            </form>
        </div>,
        document.body
    );
});

export default function QuickWorkTimer({ compact = false }) {
    const { currentUser } = useAuth();
    const [isQuickWorking, setIsQuickWorking] = useState(false);
    const [currentSessionMinutes, setCurrentSessionMinutes] = useState(0);
    const [startTime, setStartTime] = useState(null);
    const [showTitleModal, setShowTitleModal] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Real-time quick work state listener
    useEffect(() => {
        if (!currentUser) return;

        const userRef = doc(db, 'users', currentUser.uid);

        // Subscribe to real-time updates
        const unsubscribe = onSnapshot(userRef, (userSnap) => {
            if (userSnap.exists()) {
                const data = userSnap.data().quickWorkState || {};
                if (data.isQuickWorking) {
                    setIsQuickWorking(true);
                    if (data.lastStartedAt) {
                        setStartTime(new Date(data.lastStartedAt));
                    }
                } else {
                    setIsQuickWorking(false);
                    setStartTime(null);
                }
            }
        });

        return () => unsubscribe();
    }, [currentUser]);

    // Timer
    useEffect(() => {
        let interval;
        if (isQuickWorking && startTime) {
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
    }, [isQuickWorking, startTime]);

    const handleStartQuickWork = async () => {
        if (!currentUser) return;

        try {
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
            await stopCall(currentUser.uid, currentUser.displayName);

            await Promise.all(pausePromises);

            const now = new Date();
            const userRef = doc(db, 'users', currentUser.uid);

            // 2. Update Firestore
            await updateDoc(userRef, {
                quickWorkState: {
                    isQuickWorking: true,
                    lastStartedAt: now.toISOString(),
                    resumableTaskIds: resumableTaskIds
                }
            });

            setStartTime(now);
            setIsQuickWorking(true);
        } catch (err) {
            console.error("Error starting quick work:", err);
            alert("Klaida pradedant greitą darbą.");
        }
    };

    const handleStopQuickWork = () => {
        setShowTitleModal(true);
    };

    const handleCompleteQuickWork = useCallback(async (taskTitle) => {
        if (!taskTitle || !taskTitle.trim()) return;

        setIsSubmitting(true);
        const userRef = doc(db, 'users', currentUser.uid);
        const now = new Date();

        try {
            // Calculate final duration
            let sessionDuration = 0;
            if (startTime) {
                sessionDuration = (now - startTime) / (1000 * 60);
            } else {
                // Fallback check
                const s = await getDoc(userRef);
                const startStr = s.data()?.quickWorkState?.lastStartedAt;
                if (startStr) {
                    sessionDuration = (now - new Date(startStr)) / (1000 * 60);
                }
            }

            // 1. Create Task
            if (sessionDuration > 0) {
                await addDoc(collection(db, 'tasks'), {
                    title: taskTitle,
                    description: "Greitas darbas",
                    status: "completed",
                    priority: "Medium",
                    assignedWorkerId: currentUser.uid,
                    assignedWorkerName: currentUser.displayName || currentUser.email,
                    createdBy: currentUser.uid,
                    creatorName: currentUser.displayName || currentUser.email,
                    createdAt: new Date().toISOString(),
                    completedAt: now.toISOString(),
                    manualMinutes: sessionDuration,
                    isQuickWork: true
                });
            }

            // 2. Resume Tasks
            const userSnap = await getDoc(userRef);
            const resumableTaskIds = userSnap.data()?.quickWorkState?.resumableTaskIds || [];

            if (resumableTaskIds.length > 0) {
                const resumePromises = resumableTaskIds.map(async (taskId) => {
                    const tDoc = await getDoc(doc(db, 'tasks', taskId));
                    if (tDoc.exists()) {
                        const tData = { id: tDoc.id, ...tDoc.data() };
                        if (tData.timerStatus === 'paused') {
                            return resumeTask(tData, currentUser.uid);
                        }
                    }
                });
                await Promise.all(resumePromises);
            }

            // 3. Clear State
            await updateDoc(userRef, {
                quickWorkState: {
                    isQuickWorking: false,
                    lastStartedAt: null,
                    resumableTaskIds: []
                }
            });

            setIsQuickWorking(false);
            setStartTime(null);
            setCurrentSessionMinutes(0);
            setShowTitleModal(false);

        } catch (err) {
            console.error("Error completing quick work:", err);
            alert("Klaida išsaugant greitą darbą.");
        } finally {
            setIsSubmitting(false);
        }
    }, [currentUser, startTime]);

    // Render modal if showing
    const renderModal = showTitleModal && (
        <QuickWorkModalComponent
            onSubmit={handleCompleteQuickWork}
            onClose={() => setShowTitleModal(false)}
            currentSessionMinutes={currentSessionMinutes}
            isSubmitting={isSubmitting}
        />
    );

    // Render Compact (Mobile)
    if (compact) {
        return (
            <div className="flex flex-col items-center">
                {/* Timer Display */}
                {isQuickWorking && (
                    <span className="text-[10px] font-bold text-red-600 font-mono mb-1 leading-none animate-pulse">
                        {formatMinutesToTimeString(currentSessionMinutes)}
                    </span>
                )}
                {!isQuickWorking && (
                    // Invisible placeholder to keep alignment
                    <span className="text-[10px] font-bold text-transparent font-mono mb-1 leading-none select-none">
                        00:00
                    </span>
                )}

                <button
                    onClick={isQuickWorking ? handleStopQuickWork : handleStartQuickWork}
                    className={clsx(
                        "p-2 rounded-lg transition-all active:scale-95 flex items-center justify-center",
                        isQuickWorking
                            ? 'bg-red-500 text-white ring-2 ring-red-200 shadow-lg shadow-red-500/20'
                            : 'text-gray-600 hover:bg-gray-100'
                    )}
                    title={isQuickWorking ? "Baigti greitą darbą" : "Greitas darbas"}
                >
                    {isQuickWorking ? (
                        <Square className="w-5 h-5 fill-current" />
                    ) : (
                        <Zap className="w-5 h-5 fill-current" />
                    )}
                </button>

                {renderModal}
            </div>
        );
    }

    // Render Desktop (Wide)
    return (
        <>
            <button
                onClick={isQuickWorking ? handleStopQuickWork : handleStartQuickWork}
                className={clsx(
                    "flex-1 flex items-center justify-between px-4 py-3 rounded-xl transition-all shadow-sm active:scale-95 border min-w-[140px]",
                    isQuickWorking
                        ? 'bg-red-50 border-red-200 text-red-900 ring-1 ring-red-200'
                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-gray-300'
                )}
            >
                <div className="flex items-center gap-3">
                    <div className={clsx("p-1.5 rounded-lg", isQuickWorking ? "bg-red-200 text-red-700" : "bg-gray-100 text-gray-500")}>
                        {isQuickWorking ? (
                            <Square className="w-5 h-5 fill-current" />
                        ) : (
                            <Zap className="w-5 h-5 fill-current" />
                        )}
                    </div>
                    <div className="flex flex-col items-start leading-none">
                        <span className="text-xs font-bold uppercase tracking-wider opacity-70">Greitas</span>
                        {isQuickWorking && <span className="text-[10px] font-semibold text-red-600">Vyksta...</span>}
                    </div>
                </div>
                <span className={clsx(
                    "text-lg font-mono font-bold ml-2",
                    isQuickWorking ? "text-red-600" : "text-gray-400"
                )}>
                    {formatMinutesToTimeString(currentSessionMinutes)}
                </span>
            </button>

            {renderModal}
        </>
    );
}
