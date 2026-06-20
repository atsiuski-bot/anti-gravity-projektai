import { db } from '../firebase';
import { doc, setDoc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { startOfWeek, format } from 'date-fns';
import { formatDisplayName } from './formatters';
import { getLithuanianNow } from './timeUtils';

export const logCalendarChange = async (currentUser, type, start, end) => {
    const now = getLithuanianNow();

    // Determine week start (Monday)
    const weekStart = startOfWeek(now, { weekStartsOn: 1 });
    const weekId = format(weekStart, 'yyyy-MM-dd');
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
