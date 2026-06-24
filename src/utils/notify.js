import { addDoc, collection } from 'firebase/firestore';
import { db } from '../firebase';
import { NOTIFICATIONS, notificationCategory } from '../notifications/registry';

/**
 * Single funnel for in-app notifications — the `request_notifications` collection, which is the
 * unified, TWO-WAY notification feed the bell surfaces (workers and managers both receive their
 * own; the rule already keys reads on `recipientId`). Centralising the write here lets us:
 *   - stamp the invariants firestore.rules requires on create — a non-empty string `recipientId`,
 *     an unread flag, and provenance (the caller's uid as `createdBy`), so a notification can
 *     never be forged "from" someone else;
 *   - tag each notification with a `category` ('action' = needs a decision, 'info' = FYI) from the
 *     ONE registry ({@link NOTIFICATIONS}), so the hybrid bell, the toast and the push can never
 *     disagree with the sender; and
 *   - clamp the only free-form field (`commentText`) before it can reach a lockscreen.
 *
 * A notification is never delivered to its own actor (`recipientId === actorUid` is dropped).
 *
 * The type's category, copy, sound and external-push intent all live in src/notifications/registry.js
 * — every write site (and the manager-facing decision sites) routes through {@link notify} here, so
 * there is no longer any inline write that can drift from those invariants.
 */

// Re-exported from the registry so existing importers keep working; the registry is the source.
export const NOTIFICATION_CATEGORY = Object.fromEntries(
    Object.entries(NOTIFICATIONS).map(([type, entry]) => [type, entry.category]),
);

/** The bell tier for a notification type. Unknown/legacy types fall back to 'info'. */
export const categoryOf = (type) => notificationCategory(type);

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
