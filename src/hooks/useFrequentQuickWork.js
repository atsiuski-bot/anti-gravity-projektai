import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { logError } from '../utils/errorLog';

// A root must recur at least this many times in the worker's OWN history before it becomes a chip.
// Quick-work repetition is bimodal: managers + workshop staff retype a few roots, field workers are
// ~85% one-offs. This threshold IS the cohort gate — a one-off logger never crosses it, so they see
// no chips and the unchanged free-text box, and no chip is ever a fabricated activity.
const MIN_ROOT_COUNT = 3;
const MAX_CHIPS = 5;

// Reduce a quick-work title to its "activity root" for clustering: lowercase, drop a leading
// clock-stamp if one leaked into the title, collapse whitespace, then take the first word — except
// a "su <name>" coordination log, where the first two words are the meaningful root. Lithuanian
// inflection/typos still fragment some roots, but that only UNDER-counts (a near-miss simply fails
// to reach the threshold); it can never mint a wrong chip.
function activityRoot(title) {
    const t = String(title || '')
        .toLowerCase()
        .replace(/^\s*\d{1,2}:\d{2}\s*/, '')
        .trim()
        .replace(/\s+/g, ' ');
    if (!t) return '';
    const words = t.split(' ');
    if (words[0] === 'su' && words.length > 1) return `${words[0]} ${words[1]}`;
    return words[0];
}

/**
 * Per-user "frequent quick-work" chips, derived READ-ONLY from the worker's own history so the
 * repetitive cohort can one-tap a recurring activity instead of re-typing it (median quick-work is
 * ~10 min, so the typing cost rivals the work). Returns the most-recent actual title per frequent
 * root, newest/most-frequent first, capped at MAX_CHIPS. Returns [] for one-off loggers (cohort
 * gate), so field workers are never shown — and never auto-fed — a wrong activity.
 *
 * Data source is `archived_tasks` (the live `tasks` collection is emptied nightly by archival, so
 * history lives there). Queried by assignedUserId ALONE: that single-field equality is served by
 * the default index (no composite to provision — the isQuickWork+createdAt composite is absent),
 * and firestore.rules lets a worker read their own archived rows (ownsAssignedUser). One-shot read
 * on mount, not a live subscription — frequency does not change fast.
 *
 * @param {{ uid: string } | null} currentUser
 * @returns {string[]} chip labels (actual prior titles), most-frequent first; [] when none qualify
 */
export function useFrequentQuickWork(currentUser) {
    const [chips, setChips] = useState([]);

    useEffect(() => {
        if (!currentUser?.uid) {
            setChips([]);
            return undefined;
        }
        let cancelled = false;

        (async () => {
            try {
                const snap = await getDocs(query(
                    collection(db, 'archived_tasks'),
                    where('assignedUserId', '==', currentUser.uid)
                ));

                const clusters = new Map(); // root -> { count, lastAt, label }
                snap.forEach((d) => {
                    const t = d.data();
                    if (t.isQuickWork !== true) return;
                    if (t.autoStopped === true) return; // placeholder-titled, not a real activity
                    if (t.isDeleted) return;
                    const title = (t.title || '').trim();
                    if (!title) return;
                    const root = activityRoot(title);
                    if (!root) return;
                    const at = new Date(t.completedAt || t.createdAt || 0).getTime() || 0;
                    const prev = clusters.get(root);
                    if (!prev) {
                        clusters.set(root, { count: 1, lastAt: at, label: title });
                    } else {
                        prev.count += 1;
                        // The most-recent wording becomes the chip label (matches what the worker
                        // last actually typed for this activity).
                        if (at >= prev.lastAt) { prev.lastAt = at; prev.label = title; }
                    }
                });

                const ranked = Array.from(clusters.values())
                    .filter((c) => c.count >= MIN_ROOT_COUNT)
                    .sort((a, b) => (b.count - a.count) || (b.lastAt - a.lastAt))
                    .slice(0, MAX_CHIPS)
                    .map((c) => c.label);

                if (!cancelled) setChips(ranked);
            } catch (err) {
                logError(err, { source: 'useFrequentQuickWork', uid: currentUser?.uid });
                if (!cancelled) setChips([]);
            }
        })();

        return () => { cancelled = true; };
    }, [currentUser?.uid]);

    return chips;
}
