import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { BADGE_CATALOG } from '../utils/badgeCatalog';

/**
 * The badge engine keeps an O(1) running count per badge in users/{uid}/achievements/_stats
 * (see functions/index.js BADGES). The thresholds for the four tiers live client-side on
 * BADGE_CATALOG, but the NAME of the counter field is server-only — so the bridge between a
 * catalog badge `key` and its `_stats` field lives here. This must stay in lockstep with the
 * server `BADGES[key].stat`. Exported so a unit test can assert the bridge has no gaps (every
 * catalog badge maps to a field) and so it cannot silently drift from the server BADGES map.
 */
export const STAT_FIELD_BY_KEY = {
    follow_through: 'completedTasks',
    steady_rhythm: 'workDays',
    on_estimate: 'onEstimate',
    plans_ahead: 'planAheadWeeks',
    on_time_start: 'punctualDays',
    approved_craft: 'confirmedTasks',
    thorough: 'thorough',
    hard_tasks: 'hardTasks',
};

/**
 * Derive a per-badge progress view from the raw `_stats` counters: where the running count sits
 * relative to the four catalog thresholds, and how far the NEXT tier is. Returns a map keyed by
 * badge `key`:
 *   { count, tier, nextThreshold, prevThreshold, nextTier, atMax }
 * `atMax` means every tier is already reached (the bar is full and there is nothing ahead). When
 * the counter is missing (engine never fired for this user) `count` is 0 — the badge is simply at
 * the start of its first tier, which renders as an honest, encouraging empty bar.
 *
 * Exported (alongside the hook) so the tier-boundary maths can be unit-tested directly without a
 * React render harness.
 */
export function deriveProgress(stats) {
    const map = {};
    BADGE_CATALOG.forEach((def) => {
        const field = STAT_FIELD_BY_KEY[def.key];
        const count = Number(stats?.[field]) || 0;
        const thresholds = def.thresholds || [];
        // Tier reached = how many thresholds the count has met (mirrors server tierForCount).
        let tier = 0;
        for (let i = 0; i < thresholds.length; i += 1) {
            if (count >= thresholds[i]) tier = i + 1;
        }
        const atMax = tier >= thresholds.length;
        map[def.key] = {
            count,
            tier,
            prevThreshold: tier > 0 ? thresholds[tier - 1] : 0,
            nextThreshold: atMax ? thresholds[thresholds.length - 1] : thresholds[tier],
            nextTier: atMax ? tier : tier + 1,
            atMax,
        };
    });
    return map;
}

/**
 * Subscribes to a user's earned achievements (users/{uid}/achievements). Returns the earned
 * badge docs — excluding the internal `_stats` rollup (and any `_`-prefixed id) — newest tier
 * first. Works for ANY userId (own profile or, later, a peer), since the read rule is team-wide.
 *
 * The read requires the achievements rule to be deployed; until then (or on a transient error) a
 * permission-denied is swallowed so the profile renders an empty, encouraging shelf rather than
 * an error. Earned-only by design — there are never "locked" placeholders here (guardrail W4).
 *
 * Alongside the earned ladder it also exposes the running `_stats` counters and a derived
 * `progress` map (count vs. the next tier threshold per badge), used by the OWNER's profile to
 * draw a "progress to next tier" bar. Existing callers that destructure only `achievements` are
 * unaffected — the extra fields are additive.
 */
export function useAchievements(userId) {
    const [achievements, setAchievements] = useState([]);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!userId) {
            setAchievements([]);
            setStats(null);
            setLoading(false);
            return undefined;
        }
        setLoading(true);
        const ref = collection(db, 'users', userId, 'achievements');
        const unsub = onSnapshot(
            ref,
            (snap) => {
                // The `_stats` rollup is a sibling doc in the SAME subcollection; pull its counters
                // aside, then build the earned-only ladder from the remaining real badge docs.
                const statsDoc = snap.docs.find((d) => d.id === '_stats');
                setStats(statsDoc ? statsDoc.data() : null);

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
                setStats(null);
                setLoading(false);
            }
        );
        return unsub;
    }, [userId]);

    const progress = useMemo(() => deriveProgress(stats), [stats]);

    return { achievements, stats, progress, loading };
}
