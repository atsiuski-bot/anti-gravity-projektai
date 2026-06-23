import { db } from '../firebase';
import { collection, query, where, getDocs, updateDoc, doc } from 'firebase/firestore';
import { archiveTask } from './taskActions';
import { getLithuanianNow, getLithuanianDateString, getLithuanian3AMCutoff, addDaysToDateString } from './timeUtils';
import { PRIORITIES, normalizePriority } from './priority';

/**
 * Checks all active tasks and promotes their priority based on deadline proximity.
 * - Tasks due today, tomorrow, or overdue -> Priority: Urgent
 * - Tasks due day after tomorrow -> Priority: High
 * 
 * This should be called once per session (or daily) by managers/admins.
 */
export async function checkAndPromoteTasks() {
    try {
        // Fetch all non-completed tasks
        const tasksQuery = query(
            collection(db, 'tasks'),
            where('status', 'in', ['pending', 'in-progress'])
        );

        const snapshot = await getDocs(tasksQuery);
        const tasks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Compare deadlines as Vilnius calendar-day strings (YYYY-MM-DD), which sort
        // lexically and are timezone-correct. The old code built local-midnight Date
        // objects from the browser's timezone, so a UTC-stamped deadline (e.g.
        // 2025-12-01T22:00:00Z = 2025-12-02 in Vilnius) was bucketed on the wrong day and
        // priority promotion fired a day late.
        const now = getLithuanianNow();
        const todayStr = getLithuanianDateString(now);
        const dayAfterTomorrowStr = addDaysToDateString(todayStr, 2);
        const threeDaysStr = addDaysToDateString(todayStr, 3);

        let updatedCount = 0;

        for (const task of tasks) {
            if (!task.deadline) continue;

            // Bucket the deadline to its Vilnius calendar day, however it was stored.
            const deadlineStr = getLithuanianDateString(new Date(task.deadline));

            let newPriority = null;

            // Compare against the CANONICAL priority, not the raw stored value: tasks may carry
            // either casing historically (e.g. 'Urgent' vs 'URGENT'), and an un-normalized
            // comparison would re-promote an already-urgent task on every run (a redundant write,
            // and a casing flip-flop). normalizePriority collapses both to the PRIORITIES token.
            const currentPriority = normalizePriority(task.priority);

            // Overdue, today, or tomorrow -> Urgent. (dayAfterTomorrowStr == today+2, so
            // deadlineStr < it covers everything up to and including tomorrow.)
            if (deadlineStr < dayAfterTomorrowStr) {
                if (currentPriority !== PRIORITIES.URGENT) {
                    newPriority = PRIORITIES.URGENT;
                }
            } else if (deadlineStr < threeDaysStr) {
                // Day after tomorrow -> High
                if (currentPriority !== PRIORITIES.URGENT && currentPriority !== PRIORITIES.HIGH) {
                    newPriority = PRIORITIES.HIGH;
                }
            }

            // Update if needed
            if (newPriority) {
                await updateDoc(doc(db, 'tasks', task.id), {
                    priority: newPriority,
                    updatedAt: new Date().toISOString()
                });
                updatedCount++;
            }
        }

        console.log(`[Automation] Promoted ${updatedCount} tasks based on deadline proximity.`);
        return updatedCount;
    } catch (error) {
        console.error('[Automation] Error promoting tasks:', error);
        return 0;
    }
}

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
 * Runs the FULL daily automation set (promote + archive) behind the once-per-day latch.
 * Both Dashboard and Layout call this. Previously each gated `shouldRunAutomation()` and then
 * ran a different subset (Dashboard: promote + archive; Layout: promote only), so whichever
 * mounted first consumed the latch — and when Layout won, archiveOldTasks never ran that day.
 * Defining the latch and the work it gates together makes them impossible to drift.
 */
export async function runDailyAutomation() {
    if (!shouldRunAutomation()) return;
    await checkAndPromoteTasks();
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
