import { addDoc, collection } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * Single funnel for in-app notifications — the `request_notifications` collection, which is the
 * unified, TWO-WAY notification feed the bell surfaces (workers and managers both receive their
 * own; the rule already keys reads on `recipientId`). Centralising the write here lets us:
 *   - stamp the invariants firestore.rules requires on create — a non-empty string `recipientId`,
 *     an unread flag, and provenance (the caller's uid as `createdBy`), so a notification can
 *     never be forged "from" someone else;
 *   - tag each notification with a `category` ('action' = needs a decision, 'info' = FYI) from one
 *     type→category map, so the hybrid bell can never disagree with the sender; and
 *   - clamp the only free-form field (`commentText`) before it can reach a lockscreen.
 *
 * A notification is never delivered to its own actor (`recipientId === actorUid` is dropped).
 *
 * NOTE: the five legacy write-sites (task_approval, task_completion ×2, time_extension_request,
 * new_comment) still write inline; the bell derives their category from `type` via {@link categoryOf}
 * so they need no change. New notification kinds should route through {@link notify} here.
 */

// One source of truth for how the bell weights each type. 'action' floats to the top tier and
// stays until the underlying work is resolved; 'info' is a read/unread row.
export const NOTIFICATION_CATEGORY = {
    // ── Worker → manager (existing) ──────────────────────────────────────────
    task_approval: 'action',            // worker submitted a task → the assigned manager approves
    task_completion: 'action',          // worker finished → the assigned manager confirms / reverts
    time_extension_request: 'action',   // worker hit the estimate → the assigned manager decides
    new_comment: 'info',                // someone commented on a task
    // ── Manager → worker (new, two-way) ──────────────────────────────────────
    task_assigned: 'info',              // a manager assigned a new task to the worker
    task_approved: 'info',              // the worker's submitted task was approved (may start)
    task_confirmed: 'info',             // the worker's finished task was confirmed (closed)
    task_reverted: 'action',            // the manager sent it back — the worker reopens & fixes
    extension_granted: 'info',          // the manager extended the estimate
    extension_denied: 'info',           // the manager declined to extend
    calendar_decision: 'info',          // the manager approved/declined a calendar request
    // ── System → manager ─────────────────────────────────────────────────────
    recurring_reassign: 'action',       // a recurring job's usual assignee is away — reassign it
    session_correction_request: 'action', // worker flagged a logged time row as wrong → manager corrects it
};

/** The bell tier for a notification type. Unknown/legacy types fall back to 'info'. */
export const categoryOf = (type) => NOTIFICATION_CATEGORY[type] || 'info';

/**
 * Write one notification. `actorUid`/`actorName` identify the signed-in user causing it (stamped
 * as `createdBy`/`createdByName` to satisfy the rules' provenance check, unless the caller already
 * supplied the worker-as-author `userId` convention). Type-specific display fields (taskId,
 * taskTitle, userName, actualTime, …) pass through verbatim.
 */
export async function notify({ recipientId, type, actorUid, actorName, ...rest } = {}) {
    if (!recipientId || !type) return;
    if (recipientId === actorUid) return; // never notify someone about their own action

    const data = {
        recipientId,
        type,
        category: categoryOf(type),
        isRead: false,
        createdAt: new Date().toISOString(),
        ...rest,
    };
    // Provenance for firestore.rules: createdBy OR userId must equal the caller.
    if (actorUid && !data.createdBy && !data.userId) data.createdBy = actorUid;
    if (actorName && !data.createdByName) data.createdByName = actorName;
    if (data.commentText) {
        data.commentText = String(data.commentText).replace(/\s+/g, ' ').trim().slice(0, 2000);
    }

    try {
        await addDoc(collection(db, 'request_notifications'), data);
    } catch (err) {
        console.error('notify failed', type, err);
    }
}

/**
 * Fan a notification out to several recipients at once (e.g. ALL of a worker's managers for a
 * person-level event). Deduped; the actor is never notified about their own action.
 */
export async function notifyMany(recipientIds, opts = {}) {
    const unique = [...new Set((recipientIds || []).filter(Boolean))];
    await Promise.all(unique.map((recipientId) => notify({ ...opts, recipientId })));
}
