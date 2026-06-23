import { db } from '../firebase';
import { doc, setDoc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { formatDisplayName } from './formatters';
import { getLithuanianNow, getLithuanianWeekId } from './timeUtils';

export const logCalendarChange = async (currentUser, type, start, end) => {
    const now = getLithuanianNow();

    // Week key = Monday of the Vilnius calendar week. MUST match the manager-side reader's key
    // (ManagerNotifications), so both derive it from the same Vilnius-day helper rather than the
    // browser-local date-fns week — otherwise two devices near the Monday boundary disagree and
    // the notification silently never matches.
    const weekId = getLithuanianWeekId(now);
    const docId = `${currentUser.uid}_${weekId}`;

    const change = {
        type, // 'add' or 'delete'
        start: start.toISOString(),
        end: end.toISOString(),
        timestamp: now.toISOString()
    };

    const notificationRef = doc(db, 'calendar_notifications', docId);

    try {
        const docSnap = await getDoc(notificationRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            // If it was dismissed by anyone, we assume the previous batch was "seen".
            // Start a fresh batch for the new change to avoid clutter.
            const wasDismissed = data.dismissedBy && data.dismissedBy.length > 0;

            if (wasDismissed) {
                await updateDoc(notificationRef, {
                    changes: [change],
                    dismissedBy: []
                });
            } else {
                await updateDoc(notificationRef, {
                    changes: arrayUnion(change),
                    dismissedBy: []
                });
            }
        } else {
            await setDoc(notificationRef, {
                userId: currentUser.uid,
                userName: formatDisplayName(currentUser.displayName) || currentUser.email,
                weekStart: weekId,
                changes: [change],
                dismissedBy: []
            });
        }
    } catch (error) {
        console.error("Error logging calendar change:", error);
    }
};
