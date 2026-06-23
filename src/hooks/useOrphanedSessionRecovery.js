import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { endSession } from '../utils/sessionActions';
import { logError } from '../utils/errorLog';

// Captured once when the app/tab boots. A secondary session (break / call / quick-work) whose
// startTime predates this moment was left running across an app restart, reload, or crash: the
// live timer that would have stopped it no longer exists, so it is an ORPHAN, not a running
// session. (A session started during this app session has startTime >= APP_LOAD_TIME.)
const APP_LOAD_TIME = Date.now();

// Resolve an active secondary session's (type, startTime) from either the canonical
// activeSession or the legacy per-type flags. Tasks are deliberately ignored here — they have
// their own recovery (useOrphanedTaskRecovery) and a different end path (pauseTask).
// Exported (pure, no side effects) so the "what gets recovered" decision is unit-testable
// without a React renderer — see useOrphanedSessionRecovery.test.js.
export const getSecondarySession = (userData) => {
    const as = userData?.activeSession;
    if (as && (as.type === 'break' || as.type === 'call' || as.type === 'quickWork') && as.startTime) {
        return { type: as.type, startTime: as.startTime };
    }
    if (userData?.breakState?.isTakingBreak && userData.breakState.lastStartedAt) {
        return { type: 'break', startTime: userData.breakState.lastStartedAt };
    }
    if (userData?.callState?.isCalling && userData.callState.lastStartedAt) {
        return { type: 'call', startTime: userData.callState.lastStartedAt };
    }
    if (userData?.quickWorkState?.isQuickWorking && userData.quickWorkState.lastStartedAt) {
        return { type: 'quickWork', startTime: userData.quickWorkState.lastStartedAt };
    }
    return null;
};

/**
 * Crash/reload recovery for an orphaned break / call / quick-work session.
 *
 * useOrphanedTaskRecovery covers only TASK timers; secondary sessions had no equivalent, which
 * is the root cause of the catastrophic "190-day break" in the early data — a break timer was
 * left running, the app closed, and the eventual end credited the entire offline gap. Here we
 * detect such an orphan once per app session (its start predates this boot) and end it via
 * endSession, which clamps the credited elapsed to MAX_SESSION_MINUTES (so even an undetected
 * multi-day gap is bounded) and leaves the user idle (skipResume — there is no live worker to
 * resume a queued task on boot).
 *
 * @param {Object} currentUser - the authenticated user (needs uid).
 */
export function useOrphanedSessionRecovery(currentUser) {
    const { userData } = useAuth();
    const handledRef = useRef(false);

    useEffect(() => {
        if (handledRef.current) return;
        if (!currentUser?.uid || !userData) return;

        const session = getSecondarySession(userData);
        if (!session) return;

        const startedAt = new Date(session.startTime).getTime();
        if (!Number.isFinite(startedAt)) return;

        // Only recover a session that began BEFORE this app session — it survived a restart and
        // is therefore orphaned. A session started in this session is live and left untouched.
        if (startedAt >= APP_LOAD_TIME) return;

        handledRef.current = true;

        endSession(currentUser.uid, userData, {}, true).catch((e) =>
            logError(e, { source: 'orphanRecovery:endSession', userId: currentUser.uid, sessionType: session.type })
        );
    }, [currentUser, userData]);
}
