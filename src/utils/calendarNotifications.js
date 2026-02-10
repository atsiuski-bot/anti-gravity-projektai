import { db } from '../firebase';
import { doc, setDoc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { startOfWeek, format } from 'date-fns';
import { formatDisplayName } from './formatters';
import { getLithuanianNow } from './timeUtils';

export const logCalendarChange = async (currentUser, type, start, end) => {
    const now = getLithuanianNow();
    const day = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Check time window: Mon 00:01 to Fri 14:00
    let isWithinWindow = false;
    if (day === 1) { // Monday
        if (hour > 0 || (hour === 0 && minute >= 1)) isWithinWindow = true;
    } else if (day > 1 && day < 5) { // Tue, Wed, Thu
        isWithinWindow = true;
    } else if (day === 5) { // Friday
        if (hour < 14) isWithinWindow = true;
    }

    if (!isWithinWindow) return;

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
