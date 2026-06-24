/**
 * Pure decision logic for the worker timer safety net (Branch A).
 *
 * These functions carry the SAFETY-CRITICAL judgements TaskTimerControls makes — was an optimistic
 * write actually committed, should we warn before finishing with open checklist items, may this user
 * undo a finish — kept side-effect-free so they are unit-testable in the node test env (no jsdom)
 * and reusable without dragging in React / firebase. The component owns the wiring; this owns the
 * rules.
 */

import { getChecklistProgress } from '../utils/checklistActions';

// How long we wait for an ONLINE timer write to actually flush to the server before treating it as
// failed. Firestore's updateDoc resolves on the LOCAL optimistic accept, so awaiting it proves
// nothing about server commit. We race waitForPendingWrites (resolves once the queue drains) against
// this budget: long enough to ride out a slow-but-working link, short enough that a worker outdoors
// is not left staring. Offline links never reach this gate — they get a calm confirmation instead.
export const COMMIT_CONFIRM_TIMEOUT_MS = 8000;

// How long the post-finish "Atšaukti" (undo) toast stays actionable. Long enough to catch the
// "oops, wrong task / not actually done" reflex, short enough that completion still feels final.
export const FINISH_UNDO_WINDOW_MS = 90000;

/**
 * Classify the result of an optimistic timer write so the UI can react to reality instead of
 * trusting navigator.onLine alone.
 *
 *   - 'failed'         — the awaited write threw: a real, surfaced failure → alert + revert.
 *   - 'offline-queued' — offline when the write was issued: safely queued locally, will sync later
 *                        → calm success confirmation.
 *   - 'committed'      — online and the pending-writes queue drained within the budget → silent
 *                        happy path (the optimistic UI was already correct).
 *   - 'unconfirmed'    — online, did not throw, but the queue did NOT drain in time → treat as a
 *                        failure: alert + revert, because we cannot prove the server accepted it.
 *
 * @param {{ errored:boolean, wasOffline:boolean, drained:boolean }} signals
 * @returns {'failed'|'offline-queued'|'committed'|'unconfirmed'}
 */
export const classifyCommit = ({ errored, wasOffline, drained }) => {
    if (errored) return 'failed';
    if (wasOffline) return 'offline-queued';
    return drained ? 'committed' : 'unconfirmed';
};

/** A commit outcome that means the optimistic state must be rolled back and the user warned. */
export const commitNeedsRevert = (outcome) => outcome === 'failed' || outcome === 'unconfirmed';

/**
 * Soft (non-blocking) warning text when finishing a task that still has unticked checklist items.
 * Returns null when there is nothing to warn about (no checklist, or all items done) — some items
 * are legitimately N/A, so this NEVER blocks the finish, it only makes the worker pause.
 *
 * @param {Array} checklist
 * @returns {string|null}
 */
export const checklistFinishWarning = (checklist) => {
    const { done, total } = getChecklistProgress(checklist);
    if (total === 0) return null;
    const remaining = total - done;
    if (remaining <= 0) return null;
    return `Liko ${remaining} ${remaining === 1 ? 'nebaigtas punktas' : 'nebaigtų punktų'}. Vis tiek užbaigti?`;
};

/** Only the worker the task is assigned to may undo their own finish. */
export const canUndoOwnFinish = (task, uid) => !!task && !!uid && task.assignedUserId === uid;
