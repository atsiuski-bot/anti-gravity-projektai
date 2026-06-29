import { useMemo } from 'react';
import { useAuth } from '../context/AuthContext';

// Human label for whatever session is currently blocking a new action, so a disabled
// timer can say *which* activity is in progress instead of a generic "another action".
const SESSION_TYPE_LABELS = {
    break: 'pertrauka',
    call: 'skambutis',
    quickWork: 'greita veikla',
    task: 'užduotis',
};

export const getActiveSessionLabel = (type) => SESSION_TYPE_LABELS[type] || 'kitas veiksmas';

// Reason shown on a disabled timer (aria-label + tooltip): names the in-progress activity.
export const getInterruptionReason = (type) => `Šiuo metu vyksta ${getActiveSessionLabel(type)}`;

/**
 * Pure derivation of the session status the UI keys off, exported so the policy is unit-testable
 * without a React renderer (mirrors getSecondarySession in useOrphanedSessionRecovery).
 *
 * The secondary-session BLOCK is gated on `activeSession` ALONE. A genuine break / call / quick-work
 * ALWAYS writes `activeSession` alongside its legacy flag (see sessionActions.startSession), so a
 * lingering legacy `*State` flag with NO `activeSession` is an ORPHAN/corrupt remnant, never a live
 * session. Treating that remnant as active created an INVISIBLE, inescapable lock: the loud
 * whole-screen session colour is `activeSession`-driven, so a stale flag would disable
 * Pradėti/Užbaigti while presenting no on-screen session to end. The start/resume paths already
 * self-heal a stale legacy flag on the next tap (and starting any secondary session clears it).
 *
 * `isTaskActive` may still consult the legacy `workStatus.status === 'running'` flag — task recovery
 * keys off `workStatus` — but that is a separate signal from the secondary-session block.
 */
export const deriveSessionStatus = (userData) => {
    if (!userData) {
        return { isSecondarySessionActive: false, isTaskActive: false, activeSessionType: null };
    }

    const activeType = userData.activeSession?.type;
    const hasActiveSession = !!activeType;

    const isSecondarySessionActive =
        activeType === 'break' || activeType === 'call' || activeType === 'quickWork';

    const isLegacyTask = !hasActiveSession && userData.workStatus?.status === 'running';
    const isTaskActive = isLegacyTask || activeType === 'task';

    // The blocking activity's type (names the in-progress session on a disabled control).
    const activeSessionType = activeType || (isLegacyTask ? 'task' : null);

    return { isSecondarySessionActive, isTaskActive, activeSessionType };
};

export const useActiveSessionStatus = () => {
    const { userData } = useAuth();
    return useMemo(() => deriveSessionStatus(userData), [userData]);
};
