import { db } from '../firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { archiveTask } from './taskActions';
import { getLithuanianNow, getLithuanianDateString, getLithuanian3AMCutoff, addDaysToDateString } from './timeUtils';

// NOTE: deadline-based PRIORITY ESCALATION used to live here (checkAndPromoteTasks) and ran in the
// browser, gated to whole-team admins/managers. It was MOVED to a scheduled Cloud Function
// (functions/index.js → escalateTaskPriorities) so it runs deterministically every day regardless of
// who opens the app, and so it can NOTIFY the assignee (a same-origin client write could not reach
// the worker reliably). Only ARCHIVING remains client-side below.

/**
 * Checks if automation should run today.
 * Uses localStorage to track last run date.
 */
export function shouldRunAutomation() {
    const lastRun = localStorage.getItem('lastAutomationRun');
    const today = getLithuanianDateString(); // YYYY-MM-DD

    if (lastRun !== today) {
        localStorage.setItem('lastAutomationRun', today);
        return true;
    }

    return false;
}

/**
 * Runs the client-side daily automation (now just ARCHIVING) behind the once-per-day latch.
 * Both Dashboard and Layout call this; defining the latch and the work it gates together keeps
 * them from drifting. Priority escalation moved server-side (see the note at the top of this file),
 * so the only remaining browser-side daily job is sweeping confirmed/deleted tasks into the archive.
 */
export async function runDailyAutomation() {
    if (!shouldRunAutomation()) return;
    await archiveOldTasks();
}

/**
 * ARCHIVE OLD TASKS
 * Checks for tasks that are 'completed' or 'confirmed' and were finished BEFORE today.
 * Moves them to 'archived_tasks'.
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

        // Archive rule: the work-day flips at 03:00 Vilnius time. Derive the current
        // work-day as a Vilnius date string, rolling back one day when the moment is
        // still before today's 03:00 Vilnius cutoff. The old code used the BROWSER's
        // local getHours() < 3, so an off-Vilnius device flipped the day at the wrong
        // hour and mis-archived (or skipped archiving) yesterday's tasks.
        const now = getLithuanianNow();
        const todayStr = getLithuanianDateString(now);
        const cutOffStr = (now < getLithuanian3AMCutoff(todayStr))
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
    } catch (error) {
        console.error("[Automation] Error archiving tasks:", error);
    }
}
