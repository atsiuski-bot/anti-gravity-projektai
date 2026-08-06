/**
 * Workload vs. capacity for the team weekly summary.
 *
 * Three pure steps that together answer one manager question: "will this person get their
 * urgent work done this week?"
 *   1. summarizePlannedHours   — how much shift time is planned, and how much of it is STILL AHEAD
 *   2. sumRemainingPriorityWork — how many hours of urgent/high work are LEFT to do
 *   3. assessCapacity          — the verdict comparing the two
 *
 * Kept out of the component so the arithmetic is unit-testable; the component only renders it.
 */
import { PRIORITIES, normalizePriority } from './priority';
import { calculateCurrentTotalMinutes, parseTimeStringToMinutes } from './timeUtils';

const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * Planned shift hours for one user in the week, split into the total and the part not yet
 * elapsed.
 *
 * `plannedRemainingHours` is deliberately NOT `planned - worked`: a Monday shift that was
 * under-worked is gone, it does not reappear as spare capacity on Thursday. Only clock time
 * still to come can absorb work that is left, so a shift is clipped to its overlap with
 * [now, weekEnd].
 *
 * Approved leave (`isVacation`, set for every absence type) is time OFF, not planned work —
 * the same exclusion Reports and DailyWorkProgress apply.
 */
export function summarizePlannedHours(workHours, { userId, now, weekEnd }) {
    let plannedHours = 0;
    let plannedRemainingHours = 0;
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const weekEndMs = weekEnd instanceof Date ? weekEnd.getTime() : Number(weekEnd);

    (workHours || []).forEach(wh => {
        if (!wh || wh.userId !== userId || wh.isVacation) return;
        const startMs = new Date(wh.start).getTime();
        const endMs = new Date(wh.end).getTime();
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;

        plannedHours += (endMs - startMs) / MS_PER_HOUR;

        const remFrom = Math.max(startMs, nowMs);
        const remTo = Math.min(endMs, weekEndMs);
        if (remTo > remFrom) {
            plannedRemainingHours += (remTo - remFrom) / MS_PER_HOUR;
        }
    });

    return { plannedHours, plannedRemainingHours };
}

/**
 * Hours of URGENT/HIGH work still outstanding for one user — "how much is left to do", not
 * "how much was assigned".
 *
 * Each open task contributes max(0, estimate − total worked), where the worked total spans the
 * task's WHOLE life (manual + timer + the live run). A task started last week therefore counts
 * only for its remainder: last week's hours have already eaten into the estimate. This is what
 * makes the figure correct across week boundaries without any per-week session bookkeeping.
 *
 * Overrun tasks (worked >= estimate) contribute 0 — what is actually left is unknown and
 * guessing would inflate the number. Tasks with no estimate cannot be sized at all, so they are
 * counted separately rather than silently dropped, which also makes the total a LOWER BOUND.
 */
export function sumRemainingPriorityWork(tasks, { userId }) {
    let urgentMinutes = 0;
    let highMinutes = 0;
    let noEstimateCount = 0;

    (tasks || []).forEach(t => {
        if (!t || t.assignedUserId !== userId) return;
        if (t.isQuickWork || t.isSystemTask || t.isDeleted) return;
        // Finished/archived tasks are no longer workload; unapproved ones are not yet actionable
        // work (the gate the shared list applies), so neither may count.
        if (t.completed === true || t.status === 'completed' || t.status === 'confirmed'
            || t.status === 'deleted' || t.status === 'unapproved' || t.archivedAt) return;

        const p = normalizePriority(t.priority);
        if (p !== PRIORITIES.URGENT && p !== PRIORITIES.HIGH) return;

        const estimate = Number(t.estimatedTimeMinutes) > 0
            ? Number(t.estimatedTimeMinutes)
            : parseTimeStringToMinutes(t.estimatedTime || '');
        if (!estimate) {
            noEstimateCount += 1;
            return;
        }

        const left = Math.max(0, estimate - calculateCurrentTotalMinutes(t));
        if (p === PRIORITIES.URGENT) urgentMinutes += left;
        else highMinutes += left;
    });

    return { urgentMinutes, highMinutes, noEstimateCount };
}

/**
 * The verdict: is there more priority work left than there is planned time left to do it in?
 *
 * Gated on the user having a plan at all. An empty calendar means capacity is UNKNOWN, not zero —
 * flagging it would fire on every unplanned worker every week and the signal would be ignored.
 * Once there IS a plan, a remaining capacity of zero is a real verdict: the week is booked out
 * and the work still stands.
 */
export function assessCapacity({ priorityLeftHours, plannedRemainingHours, plannedHours }) {
    // `netRemainingHours` is the balance the UI states outright as "X − Y = Z": planned time left
    // MINUS priority work left. It is returned from here rather than recomputed at the call site so
    // the number on screen and the verdict beside it can never be derived from different arithmetic
    // and disagree — the deficit is exactly its negation.
    const netRemainingHours = plannedRemainingHours - priorityLeftHours;
    const capacityDeficitHours = -netRemainingHours;
    return {
        netRemainingHours,
        capacityDeficitHours,
        isOverloaded: plannedHours > 0 && capacityDeficitHours > 0
    };
}
