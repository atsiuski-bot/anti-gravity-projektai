import { db } from '../firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { archiveTask } from './taskActions';
import { getLithuanianNow, getLithuanianDateString, getWorkDayCutoff, addDaysToDateString } from './timeUtils';

// NOTE: deadline-based PRIORITY ESCALATION used to live here (checkAndPromoteTasks) and ran in the
// browser, gated to whole-team admins/managers. It was MOVED to a scheduled Cloud Function
// (functions/index.js → escalateTaskPriorities) so it runs deterministically every day regardless of
// who opens the app, and so it can NOTIFY the assignee (a same-origin client write could not reach
// the worker reliably). Only ARCHIVING remains client-side below.

/**
 * Has today's sweep already run to completion? READ-ONLY — the latch is claimed only after the work
 * actually succeeds (see runDailyAutomation).
 */
export function shouldRunAutomation() {
    return localStorage.getItem('lastAutomationRun') !== getLithuanianDateString(); // YYYY-MM-DD
}

/**
 * Runs the client-side daily archive sweep behind a once-per-day latch.
 *
 * THE LATCH IS CLAIMED ON SUCCESS, NOT ON ATTEMPT. It used to be stamped the moment the check ran,
 * so the first app-open of the day consumed the day's only chance: if the sweep then failed
 * (offline, a permission blip, a mid-flight tab close), nothing retried until tomorrow and the
 * finished tasks stayed in everyone's live list for another full day. Marking the day done only
 * after the work completes turns every later app-open into a free retry — and re-running a
 * successful sweep is harmless anyway, because it is defined by a query that finds nothing once the
 * tasks have moved.
 *
 * This is now a FALLBACK for the scheduled archiveFinishedTasks Cloud Function, which does the same
 * sweep daily regardless of who opens the app. Kept because a code push does not deploy functions,
 * and because whichever runs second simply finds an empty candidate set.
 */
export async function runDailyAutomation() {
    if (!shouldRunAutomation()) return;
    const ok = await archiveOldTasks();
    if (ok) localStorage.setItem('lastAutomationRun', getLithuanianDateString());
}

/**
 * ARCHIVE OLD TASKS
 * Checks for tasks that are 'completed' or 'confirmed' and were finished BEFORE today.
 * Moves them to 'archived_tasks'.
 *
 * @returns {Promise<boolean>} true when the whole sweep completed — the ONLY condition under which
 *   the caller may mark the day done. A partial sweep (one task's archive threw) reports false so
 *   the next app-open retries the remainder.
 */
export async function archiveOldTasks() {
    try {
        console.log("[Automation] Checking for confirmed/deleted tasks to archive...");

        // 1. Archive old confirmed tasks
        const confirmedQ = query(
            collection(db, 'tasks'),
            where('status', '==', 'confirmed')
        );

        // 2. Also archive old deleted-but-kept tasks (from "keep work hours" deletion)
        const deletedQ = query(
            collection(db, 'tasks'),
            where('isDeleted', '==', true)
        );

        const [confirmedSnap, deletedSnap] = await Promise.all([
            getDocs(confirmedQ),
            getDocs(deletedQ)
        ]);

        // Merge and deduplicate by ID
        const taskMap = new Map();
        confirmedSnap.docs.forEach(d => taskMap.set(d.id, { id: d.id, ...d.data() }));
        deletedSnap.docs.forEach(d => taskMap.set(d.id, { id: d.id, ...d.data() }));
        const tasks = Array.from(taskMap.values());

        // Archive rule: the work-day flips at WORK_DAY_START_HOUR Vilnius time. Derive the
        // current work-day as a Vilnius date string, rolling back one day when the moment is
        // still before today's Vilnius cutoff. The old code used the BROWSER's
        // local getHours(), so an off-Vilnius device flipped the day at the wrong
        // hour and mis-archived (or skipped archiving) yesterday's tasks.
        const now = getLithuanianNow();
        const todayStr = getLithuanianDateString(now);
        const cutOffStr = (now < getWorkDayCutoff(todayStr))
            ? addDaysToDateString(todayStr, -1)
            : todayStr;

        let archivedCount = 0;

        for (const task of tasks) {
            const relevantDate = task.deletedAt || task.confirmedAt || task.updatedAt;
            if (!relevantDate) continue;

            // Bucket the stored UTC ISO timestamp to its Vilnius calendar day before comparing
            // against cutOffStr (also a Vilnius day). Using relevantDate.split('T')[0] took the
            // UTC date, so a task confirmed 21:00–24:00 Vilnius in summer (UTC+3) carried a
            // UTC date one day earlier and was archived a cycle too soon. Mirrors line 40.
            const dateStr = getLithuanianDateString(new Date(relevantDate));
            if (dateStr < cutOffStr) {
                // It's from a previous cycle
                await archiveTask(task, 'system_automation');
                archivedCount++;
            }
        }

        if (archivedCount > 0) {
            console.log(`[Automation] Archived ${archivedCount} old confirmed/deleted tasks.`);
        }
        return true;
    } catch (error) {
        console.error("[Automation] Error archiving tasks:", error);
        return false;
    }
}
