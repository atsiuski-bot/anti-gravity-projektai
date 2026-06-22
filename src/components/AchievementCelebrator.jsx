import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useAchievements } from '../hooks/useAchievements';

/**
 * Foreground badge celebration (C2). Mounted once in the authenticated tree: when the signed-in
 * user reaches a NEW tier while the app is open, it pops a success toast. The first SETTLED
 * snapshot for a user (badges already earned at load) is the baseline and never toasts — only
 * genuine upgrades after that fire. The closed-app case is the FCM push from the Cloud Function.
 * Renders nothing.
 */
export default function AchievementCelebrator() {
    const { currentUser } = useAuth();
    const { showToast } = useToast();
    const { achievements, loading } = useAchievements(currentUser?.uid);
    const seenRef = useRef(new Map()); // key -> highest tier seen
    const baselineUidRef = useRef(null); // uid whose baseline is captured in seenRef

    useEffect(() => {
        // Wait for the first real snapshot of the CURRENT user before judging anything — this
        // avoids comparing the new user's badges against the previous user's (stale) list.
        if (loading) return;

        const snapshot = new Map(achievements.map((a) => [a.key, a.tier || 0]));

        if (baselineUidRef.current !== currentUser?.uid) {
            // First settled snapshot for this user → it's the baseline, celebrate nothing.
            baselineUidRef.current = currentUser?.uid;
            seenRef.current = snapshot;
            return;
        }

        achievements.forEach((a) => {
            if ((a.tier || 0) > (seenRef.current.get(a.key) || 0)) {
                showToast(`${a.name}: ${a.tierName}`, { title: 'Naujas ženkliukas!', tone: 'success' });
            }
        });
        seenRef.current = snapshot;
    }, [achievements, loading, currentUser?.uid, showToast]);

    return null;
}
