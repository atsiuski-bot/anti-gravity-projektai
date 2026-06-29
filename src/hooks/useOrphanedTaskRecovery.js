import { useEffect, useRef } from 'react';
import { pauseTask, creditAndResumeTask } from '../utils/taskActions';
import { addRecoveryNotice } from '../utils/recoveryNotice';
import { logError } from '../utils/errorLog';
import { TIMER_HEARTBEAT_CONTINUE_MS, MAX_SESSION_MINUTES } from '../utils/timeUtils';

// Captured once when this module is first evaluated — i.e. when the app/tab boots.
// A task whose timerStartedAt predates this moment was left timerStatus:'running'
// across an app restart, reload, or crash: the live timer that started it no longer
// exists, so it is an ORPHAN, not a running session. (A timer started during this
// app session has timerStartedAt >= APP_LOAD_TIME and is left untouched.)
const APP_LOAD_TIME = Date.now();

/**
 * Crash/reload recovery for orphaned running tasks — heartbeat-aware.
 *
 * A live task timer is only a stored start instant; the next manual pause credits
 * (now - timerStartedAt). Without recovery, a task left "running" when the app died would crash
 * the ENTIRE offline gap into work_sessions on the next pause. The original fix bluntly paused
 * every such orphan — but that ALSO stopped the timer of a worker whose app merely reloaded
 * mid-shift, silently dropping the rest of their work until they noticed (the reported incident).
 *
 * With the per-minute heartbeat ({@link useTaskHeartbeat}) we can do better, using the last beat
 * as the "last proof of work" instant:
 *   1. No heartbeat at all (pre-heartbeat data, or a timer killed within the first beat) →
 *      preserve the original safe behaviour: pause, crediting up to now, clamped to 16h.
 *   2. Small tail (load time − last beat ≤ {@link TIMER_HEARTBEAT_CONTINUE_MS}) → a brief reload
 *      WHILE WORKING: credit up to the last beat and RE-ANCHOR the timer to keep running. Seamless,
 *      no banner — the worker never has to restart.
 *   3. Large tail → the app was genuinely closed: credit only up to the last beat (never the dead
 *      gap), pause, and surface (a) the usual "timer recovered" notice and (b) a one-tap offer to
 *      claim the untracked gap as work, so a real no-signal stretch isn't silently lost.
 *
 * Each task is handled at most once per app session.
 *
 * @param {Array} tasks - the live tasks list (already scoped to the current user).
 */
export function useOrphanedTaskRecovery(tasks) {
    const handledRef = useRef(new Set());

    useEffect(() => {
        if (!Array.isArray(tasks) || tasks.length === 0) return;

        tasks.forEach((task) => {
            if (!task || task.timerStatus !== 'running' || !task.timerStartedAt) return;
            if (handledRef.current.has(task.id)) return;

            const startedAt = new Date(task.timerStartedAt).getTime();
            if (!Number.isFinite(startedAt)) return;

            // Only recover a timer that began BEFORE this app session — it survived a
            // restart and is therefore orphaned. A timer started in this session is live.
            if (startedAt >= APP_LOAD_TIME) return;

            handledRef.current.add(task.id);

            const beatMs = task.timerLastHeartbeat ? new Date(task.timerLastHeartbeat).getTime() : NaN;
            const hasBeat = Number.isFinite(beatMs);

            // (1) No proof of life — fall back to the original behaviour exactly: credit up to
            // now (clamped), pause, and tell the worker. We have nothing better to go on.
            if (!hasBeat) {
                pauseTask(task)
                    .then((result) => stampRecoveredNotice(task, result))
                    .catch((e) => logError(e, { source: 'orphanRecovery:pauseTask', taskId: task.id }));
                return;
            }

            // The last proven-alive instant can't be before the timer started (guard a stale beat).
            const lastBeat = Math.max(beatMs, startedAt);
            const tailMs = APP_LOAD_TIME - lastBeat;

            // (2) Brief reload while working — continue seamlessly, no banner.
            if (tailMs <= TIMER_HEARTBEAT_CONTINUE_MS) {
                creditAndResumeTask(task, lastBeat).catch((e) =>
                    logError(e, { source: 'orphanRecovery:creditAndResume', taskId: task.id })
                );
                return;
            }

            // (3) Large tail — credit only up to the last beat, pause, then offer to claim the gap.
            pauseTask(task, { endTime: lastBeat })
                .then((result) => {
                    stampRecoveredNotice(task, result);

                    // Offer a one-tap claim for the untracked gap [lastBeat → load time], but only
                    // when it is plausibly a single real stretch (≤16h). A longer gap is almost
                    // certainly a multi-day forgotten timer, not one offline shift — leave that to a
                    // manual correction rather than inviting a 1-tap credit of implausible time.
                    const gapMinutes = Math.round(tailMs / 60000);
                    if (gapMinutes >= 1 && gapMinutes <= MAX_SESSION_MINUTES && task.assignedUserId) {
                        addRecoveryNotice(task.assignedUserId, {
                            kind: 'task-gap',
                            taskId: task.id,
                            taskTitle: task.title || '',
                            gapMinutes,
                            fromIso: new Date(lastBeat).toISOString(),
                            toIso: new Date(APP_LOAD_TIME).toISOString(),
                        });
                    }
                })
                .catch((e) => logError(e, { source: 'orphanRecovery:pauseTask', taskId: task.id }));
        });
    }, [tasks]);
}

// Stamp the one-time "timer recovered" notice when a pause actually credited time. Keyed to the
// task OWNER (assignedUserId), the same uid the banner reads on next open. A sub-minute orphan
// credits nothing and recovers invisibly.
function stampRecoveredNotice(task, result) {
    if (result && result.creditedMinutes > 0 && task.assignedUserId) {
        addRecoveryNotice(task.assignedUserId, {
            kind: 'task',
            taskId: task.id,
            taskTitle: task.title || '',
            minutes: result.creditedMinutes,
            wasCapped: !!result.wasCapped,
        });
    }
}
