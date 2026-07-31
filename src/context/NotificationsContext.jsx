import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';
import { isManagerRole } from '../utils/formatters';
import { registerFcmToken } from '../utils/messaging';
import { notificationCopy, notificationSound } from '../notifications/registry';
import { subscribePushIntent, takeUrlPushIntent } from '../notifications/pushIntent';
import { SoundManager } from '../utils/soundUtils';

/**
 * App-wide notification state for managers — a single always-mounted source of the unread
 * count (request notifications + pending calendar requests). It powers:
 *   - the nav unread badge (useNotifications().unreadCount),
 *   - the OS app-icon badge (navigator.setAppBadge),
 *   - a foreground toast when a NEW item arrives while the app is open.
 *
 * Foreground alerts come from these Firestore listeners (real-time, no push needed); FCM only
 * adds the BACKGROUND case (handled by the SW). It also registers this device's FCM token once
 * notification permission is granted.
 */
const NotificationsContext = createContext({
    unreadCount: 0,
    requestCount: 0,
    calendarCount: 0,
    pushIntent: null,
    clearPushIntent: () => {},
});

// eslint-disable-next-line react-refresh/only-export-components -- hook co-located with its provider; dev-HMR-only lint.
export function useNotifications() {
    return useContext(NotificationsContext);
}

function setAppBadge(count) {
    try {
        if ('setAppBadge' in navigator && count > 0) {
            navigator.setAppBadge(count);
        } else if ('clearAppBadge' in navigator) {
            navigator.clearAppBadge();
        }
    } catch {
        /* Badging API unavailable / not permitted — ignore */
    }
}

// The toast copy and the per-type sound cue both come from the ONE notification registry
// (src/notifications/registry.js), which the server's push copy mirrors — so the toast a user sees in
// the foreground and the push they get in the background always read the same.

export function NotificationsProvider({ children }) {
    const { currentUser, userRole, userData } = useAuth();
    const { showToast } = useToast();
    const [requestCount, setRequestCount] = useState(0);
    const [calendarCount, setCalendarCount] = useState(0);
    // null until the first snapshot — so existing items on load do NOT toast.
    const seenRef = useRef(null);

    // A tapped background notification (ADR 0024). This provider is the app-wide holding place for
    // the intent, not its executor: it sits above the router, so it cannot navigate, and the
    // handlers that own each decision live in the bell's feed. NotificationBell routes + opens the
    // panel; ManagerNotifications runs the matching handler and clears the intent.
    //
    // Two sources, one state: a cold start carries the intent in the URL (taken once, at module
    // load), and a running app receives it by postMessage from the FCM worker.
    //
    // The cold-start intent is claimed in an EFFECT, never as a useState lazy initializer. The
    // initializer would look tidier, but React StrictMode calls initializers twice on mount and
    // keeps only one result — and takeUrlPushIntent() is a once-only consumer, so the surviving
    // render could easily be the one that got null. The decision would then be silently dropped in
    // development. An effect's double-invoke is harmless here: the second pass reads null and the
    // guard leaves the already-captured intent alone.
    const [pushIntent, setPushIntent] = useState(null);
    const clearPushIntent = useCallback(() => setPushIntent(null), []);
    useEffect(() => {
        const coldStart = takeUrlPushIntent();
        if (coldStart) setPushIntent(coldStart);
        return subscribePushIntent(setPushIntent);
    }, []);

    const isManager = isManagerRole(userRole);

    // Per-user profile toggle (missing field => enabled), mirrored from useSessionNotification.
    // A ref lets the live Firestore listeners read the latest value without re-subscribing on
    // every toggle. This is the SAME flag the OS status-bar notifications already honor, so the
    // profile switch now governs the FCM/in-app stack too.
    const notificationsEnabled = userData?.notificationsEnabled !== false;
    const notificationsEnabledRef = useRef(notificationsEnabled);
    useEffect(() => { notificationsEnabledRef.current = notificationsEnabled; }, [notificationsEnabled]);

    // Unread request notifications. This feed is now TWO-WAY: a manager's approvals/completions/
    // comments/time-extensions AND a worker's assigned/approved/confirmed/reverted/extension/
    // calendar-decision notices. The rule already keys reads on recipientId, so every user counts
    // and toasts their OWN unread — no manager gate here.
    useEffect(() => {
        if (!currentUser) {
            setRequestCount(0);
            seenRef.current = null;
            return undefined;
        }
        const q = query(
            collection(db, 'request_notifications'),
            where('recipientId', '==', currentUser.uid),
            where('isRead', '==', false)
        );
        const unsub = onSnapshot(q, (snap) => {
            setRequestCount(snap.size);
            const ids = new Set();
            const fresh = [];
            snap.forEach((d) => {
                ids.add(d.id);
                if (seenRef.current && !seenRef.current.has(d.id)) {
                    fresh.push({ id: d.id, ...d.data() });
                }
            });
            if (seenRef.current === null) {
                seenRef.current = ids; // seed; no toast for pre-existing unread
            } else {
                // Suppress foreground toasts when the user has notifications off — but still mark
                // these ids seen, so re-enabling does not retroactively toast the backlog.
                if (notificationsEnabledRef.current) {
                    let cue = null; // play ONE sound per snapshot batch — 'alert' outranks 'info'
                    fresh.forEach((n) => {
                        // The badge toast is owned by AchievementCelebrator (a listener on the
                        // achievements subcollection), so skip it here to avoid a double-toast — the
                        // bell row and the unread count (driven by the snapshot, not this loop) still
                        // include it, and the background push is unaffected.
                        if (n.type === 'achievement') return;
                        const { title, body } = notificationCopy(n);
                        showToast(body, { title, tone: 'notification' });
                        const s = notificationSound(n.type);
                        if (s === 'alert') cue = 'alert';
                        else if (s && !cue) cue = s;
                    });
                    // The visible toast and an audible cue are now the SAME foreground event, for every
                    // type — not just time-extensions, and not only while the bell panel is open. The OS
                    // notification sound on a background push is separate (owned by the OS).
                    if (cue) { try { SoundManager.playNotificationCue(cue); } catch { /* audio is best-effort */ } }
                }
                seenRef.current = ids;
            }
        }, (err) => console.error('NotificationsProvider: request listener', err));
        return () => unsub();
    }, [currentUser, showToast]);

    // Pending calendar approval requests. This MUST use the SAME predicate the bell's card list
    // uses (ManagerNotifications) or the badge and the list disagree: a calendar request fans out
    // to ALL of a worker's managers via the `managerIds` array, so a worker with several managers
    // would see a badge counting only the requests where they were the single legacy `managerId`,
    // while the list (array-contains) shows all of them. Query the array (single-field
    // array-contains needs no composite index) and filter to pending in memory, so badge and cards
    // derive from one source.
    useEffect(() => {
        if (!currentUser || !isManager) {
            setCalendarCount(0);
            return undefined;
        }
        const q = query(
            collection(db, 'calendar_requests'),
            where('managerIds', 'array-contains', currentUser.uid)
        );
        const unsub = onSnapshot(
            q,
            (snap) => {
                let pending = 0;
                snap.forEach((d) => { if (d.data().status === 'pending') pending += 1; });
                setCalendarCount(pending);
            },
            (err) => console.error('NotificationsProvider: calendar listener', err)
        );
        return () => unsub();
    }, [currentUser, isManager]);

    const unreadCount = requestCount + calendarCount;

    // Mirror the unread count onto the OS app-icon badge — but only while notifications are on;
    // when the user turns them off, clear the badge (setAppBadge(0) routes to clearAppBadge).
    useEffect(() => {
        setAppBadge(notificationsEnabled ? unreadCount : 0);
    }, [unreadCount, notificationsEnabled]);

    // Register this device's FCM token once permission is granted (now or when the user grants
    // it via the first-interaction prompt, which dispatches 'notifications-granted'). Also
    // re-register on every return to the foreground: FCM tokens rotate, and registering only at
    // login would let a rotated token silently go stale (it gets pruned server-side on the next
    // send failure and never re-added). arrayUnion dedupes, so re-registration is cheap.
    //
    // Skipped entirely when the user has notifications off — no token means this device is not
    // targeted for new push. (Already-registered tokens are also gated server-side in
    // sendToUser, so push stops there too even if a token lingers from before the toggle.)
    useEffect(() => {
        if (!currentUser || !notificationsEnabled) return undefined;
        const tryRegister = () => {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                registerFcmToken(currentUser);
            }
        };
        tryRegister();
        const onGranted = () => registerFcmToken(currentUser);
        const onVisible = () => { if (document.visibilityState === 'visible') tryRegister(); };
        window.addEventListener('notifications-granted', onGranted);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.removeEventListener('notifications-granted', onGranted);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [currentUser, notificationsEnabled]);

    return (
        <NotificationsContext.Provider value={{ unreadCount, requestCount, calendarCount, pushIntent, clearPushIntent }}>
            {children}
        </NotificationsContext.Provider>
    );
}
