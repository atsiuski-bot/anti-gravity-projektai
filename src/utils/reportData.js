// Report fetch + scope layer — gathers the raw Firestore docs a report needs and slices them
// per selected worker, ready for buildReport (reportAggregate.js). This is the IMPURE half: it is
// a deliberately separate implementation from the worker-stats hook because the fetch+scope step
// genuinely differs by surface (here: many workers at once, on-demand at export time, no live
// subscription). The pure compute/serialize core is shared via reportAggregate.
//
// Scope safety: every private query is constrained by privateScopeConstraints so it only ever
// requests rows the rules already allow this viewer to read — a scoped manager never pulls a row
// outside their subtree, even if a stray userId is passed in workerIds.

import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { privateScopeConstraints } from './teamScope';
import { addDaysToDateString } from './timeUtils';
import { formatDisplayName, resolveUserId } from './formatters';

const dayCount = (startStr, endStr) =>
    Math.round((Date.parse(`${endStr}T00:00:00Z`) - Date.parse(`${startStr}T00:00:00Z`)) / 86400000) + 1;

// The immediately-preceding equal-length window — what every metric's delta compares against.
export function previousWindow(startStr, endStr) {
    const span = Math.max(1, dayCount(startStr, endStr));
    const prevEnd = addDaysToDateString(startStr, -1);
    const prevStart = addDaysToDateString(prevEnd, -(span - 1));
    return { startStr: prevStart, endStr: prevEnd };
}

const firstOfMonthStr = (dateStr) => `${dateStr.slice(0, 7)}-01`;
const minStr = (a, b) => (a <= b ? a : b);

// Fetch everything the report needs and return { window, prevWindow, workers[] } where each worker
// carries the raw arrays buildReport expects. `workerIds` is the selected subset; the queries are
// still scoped to the viewer, so selection narrows but can never widen what is read.
export async function gatherReportData({
    db,
    userData,
    uid,
    effectiveRole,
    users,
    window,
    workerIds,
    includeRecognition = true,
}) {
    const { startStr, endStr } = window;
    const prev = previousWindow(startStr, endStr);
    // Fetch range covers the previous window (for deltas) AND back to the start month's 1st
    // (so earnings has the prior-in-month cumulative hours its marginal tiers need).
    const fetchStart = minStr(prev.startStr, firstOfMonthStr(startStr));

    const sessScope = privateScopeConstraints({ userData, uid, effectiveRole, ownerField: 'userId' });
    const taskScope = privateScopeConstraints({ userData, uid, effectiveRole, ownerField: 'assignedUserId' });

    const wsQ = query(
        collection(db, 'work_sessions'),
        where('date', '>=', fetchStart),
        where('date', '<=', endStr),
        ...sessScope
    );
    const bsQ = query(
        collection(db, 'break_sessions'),
        where('date', '>=', prev.startStr),
        where('date', '<=', endStr),
        ...sessScope
    );
    const arcQ = query(collection(db, 'archived_tasks'), where('archivedAt', '>=', prev.startStr), ...taskScope);
    const actQ = taskScope.length ? query(collection(db, 'tasks'), ...taskScope) : query(collection(db, 'tasks'));
    // work_hours is world-readable and has no 'date' field; read it and bucket client-side by userId.
    const whQ = query(collection(db, 'work_hours'));

    const [wsS, bsS, arcS, actS, whS] = await Promise.all([
        getDocs(wsQ),
        getDocs(bsQ),
        getDocs(arcQ),
        getDocs(actQ),
        getDocs(whQ),
    ]);

    // calendar_requests powers the reschedule-discipline metrics. Optional: a missing index or rule
    // only blanks those metrics, never fails the whole export.
    let crDocs = [];
    try {
        const crS = await getDocs(query(collection(db, 'calendar_requests'), where('createdAt', '>=', fetchStart)));
        crDocs = crS.docs.map((d) => d.data());
    } catch {
        crDocs = [];
    }

    const wanted = new Set(workerIds);
    const buckets = {};
    const ensure = (id) => {
        if (!buckets[id]) {
            buckets[id] = { workSessions: [], breakSessions: [], plannedShifts: [], tasks: [], calendarRequests: [] };
        }
        return buckets[id];
    };

    // Bucket via resolveUserId (not a raw x.userId), because early go-live (Jan 2026) sessions and
    // tasks carry the legacy `workerId` field and no `userId`. A raw-userId key silently drops them
    // from any whole-team export that reaches back into that era (undercounting hours AND earnings).
    // resolveUserId normalizes assignedUserId/assignedTo/workerId/userId, matching Reports.fetchWorkHours.
    wsS.docs.forEach((d) => {
        const x = { id: d.id, ...d.data() };
        const owner = resolveUserId(x);
        if (!x.isDeleted && wanted.has(owner)) ensure(owner).workSessions.push(x);
    });
    bsS.docs.forEach((d) => {
        const x = { id: d.id, ...d.data() };
        const owner = resolveUserId(x);
        if (wanted.has(owner)) ensure(owner).breakSessions.push(x);
    });
    whS.docs.forEach((d) => {
        const x = d.data();
        if (x.userId && wanted.has(x.userId)) ensure(x.userId).plannedShifts.push(x);
    });
    arcS.docs.forEach((d) => {
        const x = { id: d.id, ...d.data() };
        const owner = resolveUserId(x);
        if (wanted.has(owner)) ensure(owner).tasks.push(x);
    });
    actS.docs.forEach((d) => {
        const x = { id: d.id, ...d.data() };
        const done = x.completed || x.status === 'completed' || x.status === 'confirmed';
        const owner = resolveUserId(x);
        if (done && wanted.has(owner)) ensure(owner).tasks.push(x);
    });
    crDocs.forEach((x) => {
        if (x.userId && wanted.has(x.userId)) ensure(x.userId).calendarRequests.push(x);
    });

    // Lifetime recognition rollup — one extra read per selected worker. Best-effort: a missing or
    // unreadable _stats doc just omits the recognition block for that worker.
    const recognition = {};
    if (includeRecognition) {
        await Promise.all(
            workerIds.map(async (id) => {
                try {
                    const snap = await getDoc(doc(db, 'users', id, 'achievements', '_stats'));
                    if (snap.exists()) recognition[id] = snap.data();
                } catch {
                    // ignore — recognition is optional
                }
            })
        );
    }

    const workers = workerIds.map((id) => {
        const u = users.find((x) => x.id === id);
        const bucket = buckets[id] || {
            workSessions: [],
            breakSessions: [],
            plannedShifts: [],
            tasks: [],
            calendarRequests: [],
        };
        return {
            userId: id,
            name: formatDisplayName(u?.displayName) || u?.email || id,
            expectedWeeklyHours: u?.weeklyExpectedHours,
            payRate: u?.payRate,
            recognition: recognition[id] || null,
            ...bucket,
            // calendar_requests stays null (not []) when truly absent so workerStats can distinguish
            // "no reschedules" from "reschedule data unavailable".
            calendarRequests: bucket.calendarRequests.length ? bucket.calendarRequests : null,
        };
    });

    return { window, prevWindow: prev, workers };
}

// Default suggested filename for a downloaded report.
export function reportFilename(format, window) {
    const ext = format === 'md' ? 'md' : format === 'json' ? 'json' : 'csv';
    const stamp = `${window.startStr}_${window.endStr}`;
    const base = format === 'csv' ? 'darbo_ataskaita' : 'darbo_ataskaita_ai';
    return `${base}_${stamp}.${ext}`;
}
