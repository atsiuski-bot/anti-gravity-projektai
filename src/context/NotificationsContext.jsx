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
        case 'time_extension_request': return { title: 'Laiko pratęsimo prašymas', body: task };
        case 'task_completion': return { title: 'Užduotis atlikta', body: task };
        case 'task_approval': return { title: 'Nauja užduotis tvirtinimui', body: task };
        case 'new_comment': return { title: 'Naujas komentaras', body: n.commentText ? `${task}: ${n.commentText}` : task };
        default: return { title: 'Naujas pranešimas', body: task };
    }
}

export function NotificationsProvider({ children }) {
    const { currentUser, userRole } = useAuth();
    const { showToast } = useToast();
    const [requestCount, setRequestCount] = useState(0);
    const [calendarCount, setCalendarCount] = useState(0);
    // null until the first snapshot — so existing items on load do NOT toast.
    const seenRef = useRef(null);

    const isManager = isManagerRole(userRole);

    // Unread request notifications (task approvals/completions/comments/time-extensions).
    useEffect(() => {
        if (!currentUser || !isManager) {
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
                fresh.forEach((n) => {
                    const { title, body } = copyFor(n);
                    showToast(body, { title, tone: 'notification' });
                });
                seenRef.current = ids;
            }
        }, (err) => console.error('NotificationsProvider: request listener', err));
        return () => unsub();
    }, [currentUser, isManager, showToast]);

    // Pending calendar approval requests.
    useEffect(() => {
        if (!currentUser || !isManager) {
            setCalendarCount(0);
            return undefined;
        }
        const q = query(
            collection(db, 'calendar_requests'),
            where('managerId', '==', currentUser.uid),
            where('status', '==', 'pending')
        );
        const unsub = onSnapshot(q, (snap) => setCalendarCount(snap.size),
            (err) => console.error('NotificationsProvider: calendar listener', err));
        return () => unsub();
    }, [currentUser, isManager]);

    const unreadCount = requestCount + calendarCount;

    // Mirror the unread count onto the OS app-icon badge.
    useEffect(() => {
        setAppBadge(unreadCount);
    }, [unreadCount]);

    // Register this device's FCM token once permission is granted (now or when the user grants
    // it via the first-interaction prompt, which dispatches 'notifications-granted').
    useEffect(() => {
        if (!currentUser) return undefined;
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            registerFcmToken(currentUser);
        }
        const onGranted = () => registerFcmToken(currentUser);
        window.addEventListener('notifications-granted', onGranted);
        return () => window.removeEventListener('notifications-granted', onGranted);
    }, [currentUser]);

    return (
        <NotificationsContext.Provider value={{ unreadCount, requestCount, calendarCount }}>
            {children}
        </NotificationsContext.Provider>
    );
}
