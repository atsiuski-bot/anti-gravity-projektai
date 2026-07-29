import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { calculateCurrentTotalMinutes } from '../utils/timeUtils';

/**
 * Live time readout for the currently running task: the minutes already spent (ticked once a
 * second) and the estimate they are running against.
 *
 * The elapsed value is the SAME number the task card shows, otherwise one task would display two
 * different elapsed times on one screen (the card's total vs. a bare current-stretch delta) and the
 * worker has no way to tell which one is real. So this deliberately reuses the task document and
 * `calculateCurrentTotalMinutes` — the canonical total (credited minutes + manual + adjustments +
 * the live running stretch, clamped) — instead of recomputing an independent elapsed from
 * `activeSession.startTime`. The plan is handed back as the task's OWN raw `estimatedTime` string
 * ("15min", "2h 30min") — the exact text the card prints after its slash — so the planned figure
 * reads identically in both places instead of being re-formatted into a second dialect.
 *
 * `minutes` stays `null` while no task is running or its document has not arrived yet, so the caller
 * can render nothing rather than flash a placeholder 0; `estimatedTime` is empty when unplanned.
 *
 * The task DOCUMENT is handed back too, so the pill's own card can be opened from the copy already
 * subscribed here instead of a second listener on the same document — one subscription, one truth.
 *
 * @param {string|null|undefined} taskId the running task's id (null when idle)
 * @returns {{minutes: number|null, estimatedTime: string, task: Object|null}}
 */
export const useActiveTaskElapsedMinutes = (taskId) => {
    const [task, setTask] = useState(null);

    useEffect(() => {
        if (!taskId) {
            setTask(null);
            return undefined;
        }
        const unsubscribe = onSnapshot(
            doc(db, 'tasks', taskId),
            (snapshot) => setTask(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null),
            // A read failure here is cosmetic (the card remains the authority), so stay silent and
            // simply render no time rather than surfacing an error in the top bar.
            () => setTask(null)
        );
        return unsubscribe;
    }, [taskId]);

    const [minutes, setMinutes] = useState(null);

    useEffect(() => {
        if (!task) {
            setMinutes(null);
            return undefined;
        }
        const tick = () => setMinutes(calculateCurrentTotalMinutes(task));
        tick();
        // Only a RUNNING task grows on its own; a paused one is a static total, so no ticker.
        if (task.timerStatus !== 'running') return undefined;
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [task]);

    return {
        minutes,
        estimatedTime: typeof task?.estimatedTime === 'string' ? task.estimatedTime.trim() : '',
        task,
    };
};
