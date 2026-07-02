import { useEffect } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { logError } from '../utils/errorLog';
import { TIMER_HEARTBEAT_INTERVAL_MS } from '../utils/timeUtils';

// Captured once when this JS context boots (same convention as the recovery hooks). A running task
// whose timerStartedAt predates this moment is a PRE-BOOT run this device merely OBSERVES — it is
// orphan-recovery's to judge, and this hook must never beat it (see isBeatableRun).
const APP_LOAD_TIME = Date.now();

// Is this task a run THIS app session started (or re-anchored), i.e. one this device may beat?
// Pre-boot runs are excluded on purpose: the beat is the "proof of life" orphan recovery uses to
// tell a live timer from an abandoned one, and it now server-confirms that proof before acting.
// The old unconditional immediate beat stamped a fresh beat onto every orphan at boot — blessing
// an abandoned timer as alive and poisoning that confirmation. Every legitimate continuation of a
// pre-boot run re-anchors timerStartedAt (creditAndResumeTask / resumeTask / startTask), so it
// becomes beatable the instant recovery decides it really is live. Pure + exported for tests.
export function isBeatableRun(task, uid, appLoadTime = APP_LOAD_TIME) {
    if (!task || task.timerStatus !== 'running' || !task.timerStartedAt) return false;
    if (!uid || task.assignedUserId !== uid) return false;
    const startMs = new Date(task.timerStartedAt).getTime();
    return Number.isFinite(startMs) && startMs >= appLoadTime;
}

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

    // Derive the stable id of the user's own beatable running task (if any) — a run THIS session
    // started, never a pre-boot orphan (see isBeatableRun). Recomputed each render but only its
    // VALUE drives the effect below, so snapshot churn does not restart the interval.
    const running = Array.isArray(tasks) ? tasks.find((t) => isBeatableRun(t, uid)) : null;
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
