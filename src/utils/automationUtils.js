import { db } from '../firebase';
import { collection, query, where, getDocs, updateDoc, doc } from 'firebase/firestore';
import { archiveTask } from './taskActions';
import { getLithuanianNow, getLithuanianDateString } from './timeUtils';

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

        // Get today's date at midnight for comparison
        const now = getLithuanianNow();
        const todayStr = getLithuanianDateString(now);
        const today = new Date(todayStr); // 00:00 local time on that date
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayAfterTomorrow = new Date(today);
        dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
        const threeDaysFromNow = new Date(today);
        threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

        let updatedCount = 0;

        for (const task of tasks) {
            if (!task.deadline) continue;

            const deadline = new Date(task.deadline);
            const deadlineDate = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());

            let newPriority = null;

            // Rule 1: Today, Tomorrow, or Overdue -> Urgent
            if (deadlineDate < threeDaysFromNow && deadlineDate >= today) {
                if (deadlineDate < dayAfterTomorrow) {
                    // Today or Tomorrow
                    if (task.priority !== 'Urgent') {
                        newPriority = 'Urgent';
                    }
                } else if (deadlineDate >= dayAfterTomorrow && deadlineDate < threeDaysFromNow) {
                    // Day After Tomorrow
                    if (task.priority !== 'Urgent' && task.priority !== 'High') {
                        newPriority = 'High';
                    }
                }
            } else if (deadlineDate < today) {
                // Overdue
                if (task.priority !== 'Urgent') {
                    newPriority = 'Urgent';
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

        // Archive rule: Flip "today" at 3:00 AM
        const now = getLithuanianNow();
        const cutOff = new Date(now);
        if (now.getHours() < 3) {
            cutOff.setDate(cutOff.getDate() - 1);
        }
        const cutOffStr = getLithuanianDateString(cutOff);

        let archivedCount = 0;

        for (const task of tasks) {
            const relevantDate = task.deletedAt || task.confirmedAt || task.updatedAt;
            if (!relevantDate) continue;

            const dateStr = relevantDate.split('T')[0];
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
