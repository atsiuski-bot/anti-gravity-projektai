import { useEffect } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { logError } from '../utils/errorLog';
import { TIMER_HEARTBEAT_INTERVAL_MS } from '../utils/timeUtils';
import { getSecondarySession } from './useOrphanedSessionRecovery';

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
    const startKey = session?.startTime || null;

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
