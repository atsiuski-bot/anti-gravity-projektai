import { useEffect, useRef, useState } from 'react';
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { privateScopeConstraints } from '../utils/teamScope';
import { logError } from '../utils/errorLog';

const HISTORY_LIMIT = 400; // most-recently-archived planned tasks — the relevant recency window
const MIN_COUNT = 2;       // a root must have routed to someone >=2x before it suggests them

// Reduce a task title to its "kind" keys for matching: the first word, and the first two words.
// Lowercased, whitespace-collapsed, leading clock-stamp stripped (defensive). A 2-word key
// distinguishes "savaitinis mašinų" from "savaitinis fakyrų"; the 1-word key is the looser fallback.
function rootKeys(title) {
    const t = String(title || '')
        .toLowerCase()
        .replace(/^\s*\d{1,2}:\d{2}\s*/, '')
        .trim()
        .replace(/\s+/g, ' ');
    if (!t) return { one: '', two: '' };
    const w = t.split(' ');
    return { one: w[0], two: w.length > 1 ? `${w[0]} ${w[1]}` : w[0] };
}

/**
 * useAssigneeAffinity — "who usually does this kind of job?" The manager's task picker has no
 * memory; this learns it from history so a planned task can suggest its likely assignee instead of
 * re-paying the recall cost every time (the data showed routing is near-deterministic per
 * title-root: e.g. pudriniai fakelai → Jogile, garsas → Giedrius, kostiumai → Simona).
 *
 * Reads the most-recently-archived PLANNED tasks (quick-work/system excluded), SCOPED to what the
 * viewer may read via privateScopeConstraints — so a scoped manager only learns from their own
 * subtree and the query never requests a row the rules would deny. Ordered by archivedAt (served by
 * the existing teamManagerIds+archivedAt / assignedUserId+archivedAt indexes — no new index). A
 * one-shot read while enabled (the modal is open); affinity does not change minute-to-minute.
 *
 * Returns { ready, suggestAssignees(title, max) -> assigneeId[] } — suggestions only; the manager
 * still confirms via the normal picker, so scoping/userId-pin write rules are untouched.
 */
export function useAssigneeAffinity({ currentUser, userData, userRole, enabled = true }) {
    const [ready, setReady] = useState(false);
    const mapsRef = useRef({ one: new Map(), two: new Map() }); // root -> Map(assigneeId -> {count,lastAt})

    const uid = currentUser?.uid;
    const role = userData?.role;
    const scoped = userData?.scopedManager;

    useEffect(() => {
        if (!enabled || !uid) {
            setReady(false);
            return undefined;
        }
        let cancelled = false;

        (async () => {
            try {
                const constraints = privateScopeConstraints({
                    userData,
                    uid,
                    effectiveRole: userRole,
                    ownerField: 'assignedUserId',
                });
                const q = query(
                    collection(db, 'archived_tasks'),
                    ...constraints,
                    orderBy('archivedAt', 'desc'),
                    limit(HISTORY_LIMIT)
                );
                const snap = await getDocs(q);

                const one = new Map();
                const two = new Map();
                const bump = (map, key, assignee, at) => {
                    if (!key || !assignee) return;
                    let inner = map.get(key);
                    if (!inner) { inner = new Map(); map.set(key, inner); }
                    const cur = inner.get(assignee) || { count: 0, lastAt: 0 };
                    cur.count += 1;
                    if (at > cur.lastAt) cur.lastAt = at;
                    inner.set(assignee, cur);
                };

                snap.forEach((d) => {
                    const t = d.data();
                    if (t.isQuickWork || t.isSystemTask) return; // affinity is about PLANNED-work routing
                    const assignee = t.assignedUserId;
                    if (!assignee || !t.title) return;
                    const at = new Date(t.archivedAt || t.completedAt || t.createdAt || 0).getTime() || 0;
                    const { one: k1, two: k2 } = rootKeys(t.title);
                    bump(one, k1, assignee, at);
                    bump(two, k2, assignee, at);
                });

                if (!cancelled) {
                    mapsRef.current = { one, two };
                    setReady(true);
                }
            } catch (err) {
                logError(err, { source: 'useAssigneeAffinity', uid });
                if (!cancelled) setReady(false);
            }
        })();

        return () => { cancelled = true; };
        // role/scoped are the scope-determining inputs; depending on the whole userData object would
        // re-fetch on every render (new identity each time).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, uid, userRole, role, scoped]);

    const suggestAssignees = (title, max = 3) => {
        if (!ready) return [];
        const { one: k1, two: k2 } = rootKeys(title);
        const pick = mapsRef.current.two.get(k2) || mapsRef.current.one.get(k1);
        if (!pick) return [];
        return [...pick.entries()]
            .filter(([, v]) => v.count >= MIN_COUNT)
            .sort((a, b) => (b[1].count - a[1].count) || (b[1].lastAt - a[1].lastAt))
            .slice(0, max)
            .map(([id]) => id);
    };

    return { ready, suggestAssignees };
}
