import { useAuth } from '../context/AuthContext';
import { useActiveSessionStatus } from '../hooks/useActiveSessionStatus';
import { useTimerState } from '../hooks/useTimerState';
import { Coffee, Play } from 'lucide-react';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import clsx from 'clsx';
import { SoundManager } from '../utils/soundUtils';
import { startSession, endSession } from '../utils/sessionActions';

export default function BreakTimer({ currentUser: _propUser, compact = false }) {
    const { currentUser, userData, setOptimisticUserData } = useAuth();
    const { isSecondarySessionActive, activeSessionType } = useActiveSessionStatus();
    const {
        isActive: isTakingBreak,
        currentSessionMinutes
    } = useTimerState(currentUser, 'breakState', 'isTakingBreak', null, null, 'break');

    const isDisabled = isSecondarySessionActive && !isTakingBreak && activeSessionType !== 'quickWork';

    const handleToggleBreak = async () => {
        if (!currentUser || isDisabled) return;

        try {
            if (!isTakingBreak) {
                // Optimistic UI Update: Instantly assume break started, clear all other sessions
                setOptimisticUserData({
                    ...userData,
                    activeSession: { type: 'break', startTime: new Date().toISOString() },
                    breakState: { ...userData?.breakState, isTakingBreak: true, lastStartedAt: new Date().toISOString() },
                    // Clear other session flags so Layout shows break color
                    callState: { ...userData?.callState, isCalling: false },
                    quickWorkState: { ...userData?.quickWorkState, isQuickWorking: false },
                    workStatus: { ...userData?.workStatus, isWorking: false, status: 'paused' }
                });

                // Start Break Session
                await startSession(currentUser.uid, 'break');

                // Play Break sound
                SoundManager.playBreakSound();

            } else {
                // Determine what session was paused by this break
                const pausedSession = userData?.activeSession?.pausedSession;
                const pausedType = pausedSession?.type;

                // Build the optimistic state based on what will be restored
                const optimistic = {
                    ...userData,
                    breakState: { ...userData?.breakState, isTakingBreak: false },
                };

                if (pausedType === 'quickWork') {
                    // Quick Work will be restored
                    optimistic.activeSession = pausedSession;
                    optimistic.quickWorkState = { ...userData?.quickWorkState, isQuickWorking: true };
                    optimistic.workStatus = { ...userData?.workStatus, isWorking: false, status: 'idle' };
                } else if (pausedType === 'call') {
                    // Call will be restored
                    optimistic.activeSession = pausedSession;
                    optimistic.callState = { ...userData?.callState, isCalling: true };
                    optimistic.workStatus = { ...userData?.workStatus, isWorking: false, status: 'idle' };
                } else if (pausedType === 'task' && pausedSession?.taskId) {
                    // Task will be restored
                    optimistic.activeSession = pausedSession;
                    optimistic.workStatus = { isWorking: true, status: 'running', activeTaskId: pausedSession.taskId };
                } else {
                    // Check resumable tasks as fallback
                    const resumableTasks = userData?.breakState?.resumableTaskIds || [];
                    const activeTaskId = resumableTasks.length > 0 ? resumableTasks[0] : null;
                    optimistic.activeSession = activeTaskId ? { type: 'task', startTime: new Date().toISOString(), taskId: activeTaskId } : null;
                    optimistic.workStatus = activeTaskId ? { isWorking: true, status: 'running', activeTaskId } : userData?.workStatus;
                }

                setOptimisticUserData(optimistic);

                // End Break Session
                await endSession(currentUser.uid);

                // Play Break sound when stopping
                SoundManager.playBreakSound();
            }
        } catch (err) {
            console.error("Error toggling break:", err);
            // Revert optimistic update on failure (it will naturally happen on next snapshot, but we can clear it immediately)
            setOptimisticUserData(null);
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
                    disabled={isDisabled}
                    className={clsx(
                        "p-2 rounded-lg transition-all active:scale-95",
                        isDisabled
                            ? "opacity-50 cursor-not-allowed bg-gray-50 text-gray-400"
                            : isTakingBreak
                                ? 'bg-amber-500 text-white ring-2 ring-amber-100'
                                : 'text-gray-600 hover:bg-gray-100'
                    )}
                    title={isTakingBreak ? "Tęsti darbą" : (isDisabled ? "Kitas veiksmas jau aktyvus" : "Pertrauka")}
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
                disabled={isDisabled}
                className={clsx(
                    "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm",
                    isDisabled ? "bg-gray-100 text-gray-400 cursor-not-allowed border border-gray-200" :
                        isTakingBreak
                            ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 border border-amber-200'
                            : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-300'
                )}
                title={isDisabled ? "Kitas veiksmas jau aktyvus" : ""}
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
