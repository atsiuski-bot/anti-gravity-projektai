import { useMemo } from 'react';
import { useAuth } from '../context/AuthContext';

export const useActiveSessionStatus = () => {
    const { userData } = useAuth();

    return useMemo(() => {
        if (!userData) {
            return {
                isSecondarySessionActive: false,
                isTaskActive: false,
                activeSessionType: null
            };
        }

        // Check activeSession object (new system)
        const activeType = userData.activeSession?.type;
        const hasActiveSession = !!activeType;

        // Only check legacy fields if no activeSession exists to prevent corrupted state locking
        const isBreak = activeType === 'break' || (!hasActiveSession && userData.breakState?.isTakingBreak);
        const isCall = activeType === 'call' || (!hasActiveSession && userData.callState?.isCalling);
        const isQuickWork = activeType === 'quickWork' || (!hasActiveSession && userData.quickWorkState?.isQuickWorking);
        const isLegacyTask = !hasActiveSession && userData.workStatus?.status === 'running';

        const isSecondarySessionActive = isBreak || isCall || isQuickWork;
        const isTaskActive = isLegacyTask || activeType === 'task';

        // Helper to get exactly what is active
        let type = activeType;
        if (!type) {
            if (isBreak) type = 'break';
            else if (isCall) type = 'call';
            else if (isQuickWork) type = 'quickWork';
            else if (isLegacyTask) type = 'task';
        }

        return {
            isSecondarySessionActive,
            isTaskActive,
            activeSessionType: type
        };
    }, [userData]);
};
