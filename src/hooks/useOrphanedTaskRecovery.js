import { useEffect, useRef } from 'react';
import { pauseTask } from '../utils/taskActions';
import { logError } from '../utils/errorLog';

// Captured once when this module is first evaluated — i.e. when the app/tab boots.
// A task whose timerStartedAt predates this moment was left timerStatus:'running'
// across an app restart, reload, or crash: the live timer that started it no longer
// exists, so it is an ORPHAN, not a running session. (A timer started during this
// app session has timerStartedAt >= APP_LOAD_TIME and is left untouched.)
const APP_LOAD_TIME = Date.now();

/**
 * Crash/reload recovery for orphaned running tasks.
 *
 * Without this, a task left "running" when the app died keeps accumulating
 * (now - timerStartedAt) every time its total is computed, and the next manual Pause
 * credits the ENTIRE offline gap as work — e.g. a crash at 09:00 and a reload at 17:00
 * would crash 8 hours of ghost time into work_sessions. Here we detect such an orphan
 * as soon as the tasks snapshot arrives and auto-pause it via pauseTask, which clamps
 * the credited elapsed to MAX_SESSION_MINUTES (so even an undetected multi-day gap is
 * bounded). Each task is handled at most once per app session.
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

            pauseTask(task).catch((e) =>
                logError(e, { source: 'orphanRecovery:pauseTask', taskId: task.id })
            );
        });
    }, [tasks]);
}
