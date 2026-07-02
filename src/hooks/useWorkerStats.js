import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { privateScopeConstraints } from '../utils/teamScope';
import { computeWorkerStats } from '../utils/workerStats';
import { addDaysToDateString } from '../utils/timeUtils';
import { resolveUserId } from '../utils/formatters';
import { logError } from '../utils/errorLog';

/** Drop soft-deleted (voided) session docs — mirrors Reports.jsx / reportData.js. */
export const excludeDeleted = (docs) => docs.filter((x) => !x.isDeleted);

/** Inclusive day count of a YYYY-MM-DD window (UTC calendar arithmetic, DST-independent). */
const dayCount = (startStr, endStr) =>
    Math.round((Date.parse(`${endStr}T00:00:00Z`) - Date.parse(`${startStr}T00:00:00Z`)) / 86400000) + 1;

/** The equal-length window immediately preceding [startStr, endStr]. */
function previousWindow(startStr, endStr) {
    const span = Math.max(1, dayCount(startStr, endStr));
    const prevEnd = addDaysToDateString(startStr, -1);
    const prevStart = addDaysToDateString(prevEnd, -(span - 1));
    return { startStr: prevStart, endStr: prevEnd };
}

/**
 * Fetch the raw documents for ONE worker over the union of the selected period and the previous
 * equal-length period, then compute both halves with `computeWorkerStats`. One fetch, two computes
 * → the panel can render a delta per metric.
 *
 * Permission/index-safe by mirroring how Reports/DailyStatistics already read these collections:
 * session/task queries carry `privateScopeConstraints` (the viewer's team scope — whole-team `[]`
 * or `teamManagerIds array-contains`), then the target worker is filtered out client-side. The
 * indexes for (teamManagerIds|userId, date) and (…, archivedAt) already exist. `work_hours` is
 * world-readable (rules) so it is queried directly by userId. `calendar_requests` is best-effort:
 * a failure there only blanks the two reschedule rows, never the panel.
 *
 * @param {Object}  args
 * @param {string}  args.userId            target worker uid
 * @param {Object}  args.viewerData        the signed-in viewer's user doc (for scope)
 * @param {string}  args.viewerUid         the signed-in viewer's uid
 * @param {string}  args.viewerRole        the signed-in viewer's effective role
 * @param {number}  args.expectedWeeklyHours  the worker's weekly-hours baseline (norm coverage)
 * @param {Object}  args.period            { key, startStr, endStr }
 * @param {boolean} args.enabled           gate the fetch (e.g. only while the tab is open)
 * @returns {{ loading: boolean, error: boolean, current: Object|null, previous: Object|null }}
 */
export function useWorkerStats({ userId, viewerData, viewerUid, viewerRole, expectedWeeklyHours, period, enabled }) {
    const [state, setState] = useState({ loading: true, error: false, current: null, previous: null });
    const startStr = period?.startStr;
    const endStr = period?.endStr;

    useEffect(() => {
        if (!enabled || !userId || !startStr || !endStr) return undefined;
        let cancelled = false;
        setState((s) => ({ ...s, loading: true, error: false }));

        const run = async () => {
            try {
                const prev = previousWindow(startStr, endStr);
                const unionStart = prev.startStr;
                const unionEnd = endStr;

                const sessScope = privateScopeConstraints({ userData: viewerData, uid: viewerUid, effectiveRole: viewerRole, ownerField: 'userId' });
                const taskScope = privateScopeConstraints({ userData: viewerData, uid: viewerUid, effectiveRole: viewerRole, ownerField: 'assignedUserId' });

                const wsQ = query(collection(db, 'work_sessions'), where('date', '>=', unionStart), where('date', '<=', unionEnd), ...sessScope);
                const bsQ = query(collection(db, 'break_sessions'), where('date', '>=', unionStart), where('date', '<=', unionEnd), ...sessScope);
                const arcQ = query(collection(db, 'archived_tasks'), where('archivedAt', '>=', unionStart), ...taskScope);
                const actQ = taskScope.length ? query(collection(db, 'tasks'), ...taskScope) : query(collection(db, 'tasks'));
                const whQ = query(collection(db, 'work_hours'), where('userId', '==', userId));

                const [wsS, bsS, arcS, actS, whS] = await Promise.all([
                    getDocs(wsQ), getDocs(bsQ), getDocs(arcQ), getDocs(actQ), getDocs(whQ),
                ]);

                // Optional: worker-initiated calendar changes. Wrapped so a rules/index mismatch
                // only blanks the two reschedule rows (compute receives null) — never the panel.
                let calendarRequests = null;
                try {
                    const crS = await getDocs(query(collection(db, 'calendar_requests'), where('userId', '==', userId)));
                    calendarRequests = crS.docs.map((d) => d.data());
                } catch (e) {
                    logError(e, { source: 'useWorkerStats.calendarRequests', userId });
                }

                const pick = (docs, keyOf) =>
                    docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => keyOf(x) === userId);

                // Sessions are keyed through `resolveUserId` (not raw `x.userId`) so the oldest
                // go-live rows — which carry the legacy `workerId` field and no `userId` — are not
                // silently dropped from a viewer's whole-team totals. Mirrors Reports.jsx /
                // reportData.js, including the `isDeleted` (soft-delete) exclusion. Tasks stay on
                // `assignedUserId`.
                const workSessions = excludeDeleted(pick(wsS.docs, resolveUserId));
                const breakSessions = excludeDeleted(pick(bsS.docs, resolveUserId));
                const archivedTasks = pick(arcS.docs, (x) => x.assignedUserId);
                const activeCompleted = pick(actS.docs, (x) => x.assignedUserId).filter(
                    (t) => t.completed || t.status === 'completed' || t.status === 'confirmed'
                );
                const tasks = [...archivedTasks, ...activeCompleted];
                const plannedShifts = whS.docs.map((d) => d.data());

                const raw = { workSessions, breakSessions, tasks, plannedShifts, calendarRequests };
                const opts = { expectedWeeklyHours };
                const current = computeWorkerStats(raw, { startStr, endStr }, opts);
                const previous = computeWorkerStats(raw, prev, opts);

                if (!cancelled) setState({ loading: false, error: false, current, previous });
            } catch (e) {
                logError(e, { source: 'useWorkerStats', userId });
                if (!cancelled) setState({ loading: false, error: true, current: null, previous: null });
            }
        };

        run();
        return () => {
            cancelled = true;
        };
    }, [userId, viewerUid, viewerRole, expectedWeeklyHours, startStr, endStr, enabled, viewerData]);

    return state;
}
