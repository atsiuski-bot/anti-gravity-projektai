/**
 * NOTIFICATION REGISTRY — the single source of truth for every `request_notifications` type.
 *
 * Until this file existed, a notification's identity was scattered across four places that had to be
 * edited together and could silently disagree:
 *   1. the type→category map (utils/notify.js),
 *   2. the in-app toast copy (context/NotificationsContext.jsx),
 *   3. the push copy on the server (functions/index.js → copyForRequestNotification),
 *   4. the feed card/row renderer (components/ManagerNotifications.jsx).
 * The copy lived in (2) and (3) with NOTHING linking them, and it had already drifted (task_confirmed
 * said "priimta" in the toast but "patvirtinta" in the push).
 *
 * This registry collapses the DATA of a notification — its tier, its human copy, its in-app sound and
 * its external-push intent — into ONE entry per type. The client (toast, sound, category) reads it
 * directly. The Cloud Function cannot import client ESM across the deploy boundary, so it keeps a
 * hand-copied MIRROR (copyForRequestNotification) that `src/__tests__/firebaseConsistency.test.js`
 * locks against this file: any divergence fails the test gate before a ship, exactly like the other
 * client↔functions mirrors (priority enum, estimate scale, recurrence).
 *
 * Each entry declares the FOUR delivery dimensions of the notification:
 *   - category : 'action' (a decision is owed → floats to the top of the bell) | 'info' (FYI row)
 *   - copy(n)  : the Lithuanian { title, body } shown in the toast AND the OS push (one definition)
 *   - sound    : the in-app Web-Audio cue played on the always-on foreground plane —
 *                'alert' (a decision arrived) | 'info' (FYI) | null (silent). The OS notification
 *                sound on a BACKGROUND push is separate (owned by the OS), so a notification is
 *                audible whether the app is open (this cue) or closed (the OS sound).
 *   - push     : whether this type fans out to an external OS/lockscreen notification via FCM. Every
 *                request_notification does today; the flag documents the intent and lets a future
 *                in-app-only type opt out without touching the server switch.
 *   - link     : the in-app tab the notification deep-links to when tapped (the server MIRRORs this
 *                rule: calendar decisions → the calendar, everything else → tasks).
 *
 * To add a new notification type, add ONE entry here, mirror its copy in the Cloud Function, and
 * (if it is server-fired) add the trigger. See docs/guides/adding-a-notification.md.
 */

// Collapse whitespace and clamp free-form, user-authored text before it can reach a lockscreen or a
// toast. Identical to the clamp the Cloud Function applies, so the mirror compares equal.
const clamp = (text, max = 100) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

// Deep-link targets. The Cloud Function mirrors the same rule when it builds the push `link`.
const TAB_TASKS = '/?tab=tasks';
const TAB_CALENDAR = '/?tab=calendar';

export const NOTIFICATIONS = {
    // ── Worker → manager (a decision is owed) ────────────────────────────────────────────────────
    task_approval: {
        category: 'action',
        sound: 'alert',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Nauja užduotis tvirtinimui', body: n.taskTitle || 'WORKZ' }),
    },
    task_completion: {
        category: 'action',
        sound: 'alert',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Užduotis atlikta', body: n.taskTitle || 'WORKZ' }),
    },
    time_extension_request: {
        category: 'action',
        sound: 'alert',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Laiko pratęsimo prašymas', body: n.taskTitle || 'WORKZ' }),
    },
    session_correction_request: {
        category: 'action',
        sound: 'alert',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({
            title: 'Pranešimas apie veiklos laiko klaidą',
            body: n.commentText ? `${n.day || 'Veiklos laikas'}: ${clamp(n.commentText)}` : (n.day || 'Veiklos laikas'),
        }),
    },

    // ── Worker → manager (an attention flag was raised on a task) ────────────────────────────────
    // The vykdytojas tagged a task. needsManager is an action (a decision/attention is owed → floats
    // up + alert cue); waiting is an FYI (the worker is blocked). The actor rides as createdBy, so
    // the feed shows WHO raised it.
    task_needs_manager: {
        category: 'action',
        sound: 'alert',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Reikia vadovo', body: n.taskTitle || 'WORKZ' }),
    },
    task_waiting: {
        category: 'info',
        sound: 'info',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Pažymėta „Laukiama“', body: n.taskTitle || 'WORKZ' }),
    },

    // ── Both → manager (FYI) ─────────────────────────────────────────────────────────────────────
    new_comment: {
        category: 'info',
        sound: 'info',
        push: true,
        link: TAB_TASKS,
        copy: (n) => {
            const task = n.taskTitle || 'WORKZ';
            const snippet = clamp(n.commentText);
            return { title: 'Naujas komentaras', body: snippet ? `${task}: ${snippet}` : task };
        },
    },

    // ── Manager → worker ─────────────────────────────────────────────────────────────────────────
    task_assigned: {
        category: 'info',
        sound: 'info',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Nauja užduotis', body: n.taskTitle || 'WORKZ' }),
    },
    task_approved: {
        category: 'info',
        sound: 'info',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Užduotis patvirtinta', body: n.taskTitle || 'WORKZ' }),
    },
    task_confirmed: {
        category: 'info',
        sound: 'info',
        push: true,
        link: TAB_TASKS,
        // COMPLETION-gate vocabulary is "priimta/priimtas" (two-gate split, ADR 0015 vocab) — kept in
        // lockstep with the toast and the Reports sub-tab. The push MIRROR must say the same.
        copy: (n) => ({ title: 'Užduotis užbaigta ir priimta', body: n.taskTitle || 'WORKZ' }),
    },
    task_reverted: {
        category: 'action',
        sound: 'alert',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Užduotis grąžinta taisyti', body: n.taskTitle || 'WORKZ' }),
    },
    extension_granted: {
        category: 'info',
        sound: 'info',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Laikas pratęstas', body: n.taskTitle || 'WORKZ' }),
    },
    extension_denied: {
        category: 'info',
        sound: 'info',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Laikas nepratęstas', body: n.taskTitle || 'WORKZ' }),
    },
    calendar_decision: {
        category: 'info',
        sound: 'info',
        push: true,
        link: TAB_CALENDAR,
        copy: (n) => ({
            title: n.decision === 'approved' ? 'Kalendoriaus pakeitimas patvirtintas' : 'Kalendoriaus pakeitimas atmestas',
            body: 'Veiklos kalendorius',
        }),
    },

    // ── Admin → worker (their paid time was corrected) ───────────────────────────────────────────
    session_edited: {
        category: 'info',
        sound: 'info',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Pakoreguotas veiklos laikas', body: n.day || 'Veiklos laikas' }),
    },
    session_deleted: {
        category: 'info',
        sound: 'info',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Pašalintas veiklos laikas', body: n.day || 'Veiklos laikas' }),
    },

    // ── System → admin / manager ─────────────────────────────────────────────────────────────────
    account_approval: {
        category: 'action',
        sound: 'alert',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Naujas vartotojas laukia patvirtinimo', body: n.targetUserName || n.targetUserEmail || 'WORKZ' }),
    },
    recurring_reassign: {
        category: 'action',
        sound: 'alert',
        push: true,
        link: TAB_TASKS,
        copy: (n) => ({ title: 'Priskirkite kitą vykdytoją', body: n.taskTitle || 'WORKZ' }),
    },
};

/** Every registered notification type, in declaration order. */
export const NOTIFICATION_TYPES = Object.keys(NOTIFICATIONS);

/** The bell tier for a type. Unknown/legacy types fall back to 'info'. */
export const notificationCategory = (type) => NOTIFICATIONS[type]?.category || 'info';

/** The in-app sound cue key for a type ('alert' | 'info' | null). */
export const notificationSound = (type) => NOTIFICATIONS[type]?.sound || null;

/** The deep-link tab a type opens when tapped. */
export const notificationLink = (type) => NOTIFICATIONS[type]?.link || TAB_TASKS;

/**
 * The Lithuanian { title, body } for a notification document. One definition feeds the in-app toast
 * AND (via the locked server mirror) the OS push, so the two can never disagree. Unknown types get a
 * safe generic fallback.
 */
export function notificationCopy(n) {
    const entry = NOTIFICATIONS[n?.type];
    if (!entry) return { title: 'Naujas pranešimas', body: n?.taskTitle || 'WORKZ' };
    return entry.copy(n);
}
