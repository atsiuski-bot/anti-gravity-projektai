import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';
import { isManagerRole } from '../utils/formatters';
import { registerFcmToken } from '../utils/messaging';

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
const NotificationsContext = createContext({ unreadCount: 0, requestCount: 0, calendarCount: 0 });

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

function copyFor(n) {
    const task = n.taskTitle || 'WORKZ';
    switch (n.type) {
        // Worker → manager
        case 'time_extension_request': return { title: 'Laiko pratęsimo prašymas', body: task };
        case 'task_completion': return { title: 'Užduotis atlikta', body: task };
        case 'task_approval': return { title: 'Nauja užduotis tvirtinimui', body: task };
        case 'new_comment': return { title: 'Naujas komentaras', body: n.commentText ? `${task}: ${n.commentText}` : task };
        // Manager → worker
        case 'task_assigned': return { title: 'Nauja užduotis', body: task };
        case 'task_approved': return { title: 'Užduotis patvirtinta', body: task };
        case 'task_confirmed': return { title: 'Užduotis užbaigta ir priimta', body: task };
        case 'task_reverted': return { title: 'Užduotis grąžinta taisyti', body: task };
        case 'extension_granted': return { title: 'Laikas pratęstas', body: task };
        case 'extension_denied': return { title: 'Laikas nepratęstas', body: task };
        case 'calendar_decision': return {
            title: n.decision === 'approved' ? 'Kalendoriaus pakeitimas patvirtintas' : 'Kalendoriaus pakeitimas atmestas',
            body: 'Darbo kalendorius',
        };
        // Admin → worker: their logged (paid) time was corrected / removed.
        case 'session_edited': return { title: 'Pakoreguotas darbo laikas', body: n.day || 'Darbo laikas' };
        case 'session_deleted': return { title: 'Pašalintas darbo laikas', body: n.day || 'Darbo laikas' };
        // Worker → manager: a logged-time error report.
        case 'session_correction_request': return { title: 'Pranešimas apie darbo laiko klaidą', body: n.commentText ? `${n.day || 'Darbo laikas'}: ${n.commentText}` : (n.day || 'Darbo laikas') };
        // System → admin: a new sign-up awaits approval.
        case 'account_approval': return { title: 'Naujas vartotojas laukia patvirtinimo', body: n.targetUserName || n.targetUserEmail || 'WORKZ' };
        default: return { title: 'Naujas pranešimas', body: task };
    }
}

export function NotificationsProvider({ children }) {
    const { currentUser, userRole, userData } = useAuth();
    const { showToast } = useToast();
    const [requestCount, setRequestCount] = useState(0);
    const [calendarCount, setCalendarCount] = useState(0);
    // null until the first snapshot — so existing items on load do NOT toast.
    const seenRef = useRef(null);

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
                    fresh.forEach((n) => {
                        const { title, body } = copyFor(n);
                        showToast(body, { title, tone: 'notification' });
                    });
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
        <NotificationsContext.Provider value={{ unreadCount, requestCount, calendarCount }}>
            {children}
        </NotificationsContext.Provider>
    );
}
