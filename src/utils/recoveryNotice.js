import { logError } from './errorLog';

// One-time "your timer was recovered" notice, written by the crash/cap recovery hooks and
// consumed once by RecoveryNotice (mounted in Layout). It bridges the gap between the moment
// recovery runs (silently, on boot) and the next render where the worker can be told what
// happened — the credited duration, and whether the 16h clamp had to cut it down.
//
// localStorage (not React state) is the carrier on purpose: recovery fires from a hook that
// owns nothing the banner can read, the recovery is itself per-device (it keys off this tab's
// APP_LOAD_TIME), and the notice must survive the brief boot churn before the banner mounts.
// It is deliberately NOT synced to Firestore — a recovered timer is a local-device event, and
// showing it once on the device where it happened is the whole intent.

const KEY_PREFIX = 'wz_recoveryNotice_';

const keyFor = (uid) => `${KEY_PREFIX}${uid}`;

// A notice is meaningful for at most a short window — if the worker did not open the app for
// days, an old "timer recovered" banner is noise, not signal. Drop anything older than this on
// read so a stale notice never resurfaces.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function safeParse(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Record a one-time recovery notice for a user. Appends to any existing notices (a worker can
 * orphan both a session and one or more tasks in a single crash), de-duplicating a task by id so
 * a double-fire never stacks two banners for the same timer. Never throws — a notice is a
 * courtesy, never worth failing the recovery it describes.
 *
 * @param {string} uid
 * @param {Object} notice - { kind: 'session'|'task'|'task-gap', minutes?, wasCapped?, sessionType?,
 *                            taskId?, taskTitle?, gapMinutes?, fromIso?, toIso? }
 */
export function addRecoveryNotice(uid, notice) {
    if (!uid || !notice || typeof window === 'undefined' || !window.localStorage) return;
    try {
        const existing = safeParse(window.localStorage.getItem(keyFor(uid)));
        // Skip a duplicate task-keyed notice (the task hook can re-fire across snapshots before the
        // handled-set entry lands). Deduped per (kind, taskId) so a 'task' recovered notice and a
        // 'task-gap' claim offer for the same task can coexist, but neither stacks twice. Sessions
        // carry no stable id, so they are not deduped here — the hook's handledRef already
        // guarantees one stamp per app session.
        if (notice.taskId &&
            existing.some((n) => n.kind === notice.kind && n.taskId === notice.taskId)) {
            return;
        }
        existing.push({ ...notice, at: new Date().toISOString() });
        window.localStorage.setItem(keyFor(uid), JSON.stringify(existing));
    } catch (e) {
        logError(e, { source: 'recoveryNotice.add', userId: uid });
    }
}

/**
 * Read the pending recovery notices for a user, dropping any that have aged out. Pure read —
 * does not clear them (the banner clears on dismiss via clearRecoveryNotices).
 *
 * @param {string} uid
 * @returns {Array} notices (possibly empty)
 */
export function getRecoveryNotices(uid) {
    if (!uid || typeof window === 'undefined' || !window.localStorage) return [];
    try {
        const all = safeParse(window.localStorage.getItem(keyFor(uid)));
        const cutoff = Date.now() - MAX_AGE_MS;
        const fresh = all.filter((n) => {
            const t = n?.at ? new Date(n.at).getTime() : NaN;
            return !Number.isFinite(t) || t >= cutoff;
        });
        // Quietly compact the store if stale entries were dropped, so they never re-evaluate.
        if (fresh.length !== all.length) {
            if (fresh.length === 0) window.localStorage.removeItem(keyFor(uid));
            else window.localStorage.setItem(keyFor(uid), JSON.stringify(fresh));
        }
        return fresh;
    } catch (e) {
        logError(e, { source: 'recoveryNotice.get', userId: uid });
        return [];
    }
}

/**
 * Remove a single task-keyed notice (identified by kind + taskId), leaving the rest intact.
 * Used when the worker acts on ONE gap-claim offer without dismissing the whole banner. Returns
 * the remaining notices so the caller can sync its state without a re-read.
 *
 * @param {string} uid
 * @param {Object} match - { kind, taskId }
 * @returns {Array} the remaining notices
 */
export function removeRecoveryNotice(uid, { kind, taskId } = {}) {
    if (!uid || !taskId || typeof window === 'undefined' || !window.localStorage) return [];
    try {
        const existing = safeParse(window.localStorage.getItem(keyFor(uid)));
        const remaining = existing.filter((n) => !(n.kind === kind && n.taskId === taskId));
        if (remaining.length === 0) window.localStorage.removeItem(keyFor(uid));
        else window.localStorage.setItem(keyFor(uid), JSON.stringify(remaining));
        return remaining;
    } catch (e) {
        logError(e, { source: 'recoveryNotice.remove', userId: uid });
        return [];
    }
}

/**
 * Clear all pending recovery notices for a user (called when the banner is dismissed).
 *
 * @param {string} uid
 */
export function clearRecoveryNotices(uid) {
    if (!uid || typeof window === 'undefined' || !window.localStorage) return;
    try {
        window.localStorage.removeItem(keyFor(uid));
    } catch (e) {
        logError(e, { source: 'recoveryNotice.clear', userId: uid });
    }
}
