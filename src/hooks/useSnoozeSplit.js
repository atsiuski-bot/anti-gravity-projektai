import { useEffect, useMemo, useState } from 'react';
import { getLithuanianNow } from '../utils/timeUtils';
import { splitSnoozedTasks, nextSnoozeWakeMs } from '../utils/taskSnooze';

// Re-check at least this often, so a long sleep (phone locked, tab backgrounded) or a clock
// correction can never leave a returned task hidden for long.
const MAX_WAIT_MS = 60 * 60 * 1000;

/**
 * useSnoozeSplit — {active, snoozed} for a task list, re-split by itself at the moment the next
 * parked task is due back. One timer aimed at the SOONEST return instant (not a per-minute poll),
 * so a list with nothing parked runs no timer at all.
 */
export function useSnoozeSplit(tasks) {
    const [tick, setTick] = useState(0);

    // tick carries no value — it only forces a re-split when the clock passes a return instant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const split = useMemo(() => splitSnoozedTasks(tasks, getLithuanianNow()), [tasks, tick]);

    useEffect(() => {
        const now = getLithuanianNow().getTime();
        const wake = nextSnoozeWakeMs(tasks, now);
        if (wake == null) return undefined;
        const delay = Math.min(Math.max(wake - now + 500, 1000), MAX_WAIT_MS);
        const id = setTimeout(() => setTick((t) => t + 1), delay);
        return () => clearTimeout(id);
    }, [tasks, tick]);

    return split;
}
