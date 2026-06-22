import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * Subscribes to a user's earned achievements (users/{uid}/achievements). Returns the earned
 * badge docs — excluding the internal `_stats` rollup (and any `_`-prefixed id) — newest tier
 * first. Works for ANY userId (own profile or, later, a peer), since the read rule is team-wide.
 *
 * The read requires the achievements rule to be deployed; until then (or on a transient error) a
 * permission-denied is swallowed so the profile renders an empty, encouraging shelf rather than
 * an error. Earned-only by design — there are never "locked" placeholders here (guardrail W4).
 */
export function useAchievements(userId) {
    const [achievements, setAchievements] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!userId) {
            setAchievements([]);
            setLoading(false);
            return undefined;
        }
        setLoading(true);
        const ref = collection(db, 'users', userId, 'achievements');
        const unsub = onSnapshot(
            ref,
            (snap) => {
                const list = snap.docs
                    .filter((d) => !d.id.startsWith('_'))
                    .map((d) => ({ id: d.id, ...d.data() }))
                    .filter((a) => (a.tier || 0) >= 1)
                    .sort((a, b) => String(b.earnedAt || '').localeCompare(String(a.earnedAt || '')));
                setAchievements(list);
                setLoading(false);
            },
            () => {
                // Rule not deployed yet, or a transient read error — show an empty shelf, not an error.
                setAchievements([]);
                setLoading(false);
            }
        );
        return unsub;
    }, [userId]);

    return { achievements, loading };
}
