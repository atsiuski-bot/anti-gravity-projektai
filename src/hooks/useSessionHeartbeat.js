import { useEffect } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { logError } from '../utils/errorLog';
import { TIMER_HEARTBEAT_INTERVAL_MS } from '../utils/timeUtils';
import { getSecondarySession } from './useOrphanedSessionRecovery';
import { APP_INSTANCE_ID, isOwnedByThisInstance } from '../utils/appInstance';

// Captured once when this JS context boots — the legacy fallback anchor (see isBeatableSession).
const APP_LOAD_TIME = Date.now();

// May THIS app instance write the proof of life for this secondary session?
//
// Previously there was no test at all: every open context of the worker beat the session, so a
// break/call/quick-work whose phone died stayed "alive" as long as any other tab was open, and the
// abandonment recovery then credited it up to the reopen instead of the true last proof of life.
// Ownership is the same rule the task heartbeat uses; sessions started before ownership existed
// carry no ownerInstance and fall back to the boot-time proxy, which is conservative in the safe
// direction (a pre-boot session is left to the recovery hook to judge). Pure + exported for tests.
export function isBeatableSession(session, appLoadTime = APP_LOAD_TIME, instanceId = APP_INSTANCE_ID) {
    if (!session?.startTime) return false;
    if (session.ownerInstance) return isOwnedByThisInstance(session.ownerInstance, instanceId);
    const startMs = new Date(session.startTime).getTime();
    return Number.isFinite(startMs) && startMs >= appLoadTime;
}

/**
 * Keep a running break / call / quick-work session "alive" by stamping `activeSessionLastHeartbeat`
 * on the user doc every {@link TIMER_HEARTBEAT_INTERVAL_MS}. The secondary sibling of
 * {@link useTaskHeartbeat}.
 *
 * Unlike a task timer (which orphan recovery used to PAUSE on reload), a secondary session already
 * survives a reload — it is server-anchored and simply resumes from its persisted startTime. So the
 * heartbeat here is NOT about continuing the timer; it is about the OTHER end: when a session is
 * genuinely ABANDONED (crossed a Vilnius day or exceeded 16h) the recovery must credit it only up to
 * its last proof of life, not up to the arbitrary reopen instant. This beat is that proof.
 *
 * Design notes:
 * - Writes a FLAT top-level field, never a nested `activeSession.*` path. A nested write could
 *   resurrect a just-cleared session into a malformed `{lastHeartbeat}` map if it raced an
 *   endSession that nulled activeSession; a flat field can only ever leave a harmless leftover
 *   timestamp, which recovery ignores unless it is ≥ the live session's start.
 * - Does NOT go through the per-user session lock: it touches no field the lock protects
 *   (activeSession / the per-type flags), so last-write-wins on this one field is safe.
 * - Offline-safe (client-stamped ISO, queues + replays), same as the task heartbeat.
 * - Effect depends only on the stable session start instant, so the beat it writes does not
 *   re-arm the interval.
 *
 * @param {Object} currentUser - the authenticated user.
 */
export function useSessionHeartbeat(currentUser) {
    const { userData } = useAuth();
    const uid = currentUser?.uid;

    // Derive the active secondary session's start instant (stable within a session). Recomputed
    // each render, but only its VALUE drives the effect, so userData churn does not restart the beat.
    const session = userData ? getSecondarySession(userData) : null;
    const startKey = isBeatableSession(session) ? session.startTime : null;

    useEffect(() => {
        if (!uid || !startKey) return undefined;

        let cancelled = false;
        const beat = () => {
            if (cancelled) return;
            updateDoc(doc(db, 'users', uid), {
                activeSessionLastHeartbeat: new Date().toISOString(),
            }).catch((e) => logError(e, { source: 'sessionHeartbeat', userId: uid }));
        };

        beat();
        const id = setInterval(beat, TIMER_HEARTBEAT_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [uid, startKey]);
}
