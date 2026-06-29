import { useEffect } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { logError } from '../utils/errorLog';
import { TIMER_HEARTBEAT_INTERVAL_MS } from '../utils/timeUtils';

/**
 * Keep a running task timer "alive" by stamping `timerLastHeartbeat` on its task doc every
 * {@link TIMER_HEARTBEAT_INTERVAL_MS}. This is the write side of the crash/reload-survivable
 * timer: a live timer is only a stored start instant, so on the next app load orphan recovery
 * cannot otherwise tell a brief reload-while-working from a genuinely abandoned timer. The
 * per-minute beat is that missing proof of life — recovery credits up to the last beat and, when
 * the gap since it is small, simply continues the timer instead of stopping it.
 *
 * Design notes:
 * - Single-field, last-write-wins update. It does NOT read-modify-write `activeSession`, so it
 *   needs no user lock (unlike start/pause/resume).
 * - Offline-safe: Firestore queues the write in the local cache stamped with the CLIENT clock
 *   (an ISO string, not a serverTimestamp), so a no-signal-but-app-alive stretch is preserved
 *   and replays in order on reconnect.
 * - The effect depends ONLY on the stable running-task id (not the `tasks` array reference), so
 *   the beat it writes — which produces a new snapshot every minute — does not re-arm the
 *   interval or fire an extra immediate beat. Without this it would be a write loop.
 * - Only the CURRENT user's own running task is beaten (one timer per worker by design).
 *
 * @param {Array} tasks - the live tasks list (already scoped to the current user).
 * @param {Object} currentUser - the authenticated user.
 */
export function useTaskHeartbeat(tasks, currentUser) {
    const uid = currentUser?.uid;

    // Derive the stable id of the user's own running task (if any). Recomputed each render but
    // only its VALUE drives the effect below, so snapshot churn does not restart the interval.
    const running = Array.isArray(tasks)
        ? tasks.find(
              (t) => t && t.timerStatus === 'running' && t.timerStartedAt && t.assignedUserId === uid
          )
        : null;
    const runningId = running?.id || null;

    useEffect(() => {
        if (!uid || !runningId) return undefined;

        let cancelled = false;
        const beat = () => {
            if (cancelled) return;
            updateDoc(doc(db, 'tasks', runningId), {
                timerLastHeartbeat: new Date().toISOString(),
            }).catch((e) => logError(e, { source: 'taskHeartbeat', taskId: runningId }));
        };

        // Beat once immediately (covers a timer started just before this mount, and anchors a
        // resumed timer right away), then on the interval.
        beat();
        const id = setInterval(beat, TIMER_HEARTBEAT_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [uid, runningId]);
}
