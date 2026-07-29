/**
 * Dependency-free assertions for the credit-integrity classifiers (audit R-04 / ADR 0021).
 * functions/ has no test runner, so this runs standalone: `node functions/integrityScans.test.cjs`.
 * It guards the two blind spots these checks close — orphaned task-credit rows (skipping genuine
 * system sessions) and moderate per-worker work-day inflation in the (16h, 24h] band.
 */

const assert = require('assert');
const {
    SUSPICIOUS_DAY_WORK_MINUTES,
    isReferentialTaskSession,
    collectReferentialTaskIds,
    findOrphanSessions,
    classifySuspiciousWorkDays,
    findImpossibleSpanSessions,
    SERVER_SPAN_GRACE_MINUTES,
    classifyEngineAdoption,
    claimedTaskRun,
    classifySessionDisagreements,
} = require('./integrityScans');

// 1. isReferentialTaskSession — only rows that SHOULD point at a real task are checked.
assert.strictEqual(isReferentialTaskSession({ taskId: 'realTask1' }), true);
assert.strictEqual(isReferentialTaskSession({ taskId: 'realTask1', isSystemTask: true }), false); // call
assert.strictEqual(isReferentialTaskSession({ taskId: 'realTask1', isQuickWork: true }), false);  // quick-work
assert.strictEqual(isReferentialTaskSession({ taskId: 'realTask1', isPartial: true }), false);    // interrupted partial
assert.strictEqual(isReferentialTaskSession({ taskId: 'call_1720000000000' }), false);            // synthetic prefix, flag-less legacy
assert.strictEqual(isReferentialTaskSession({ taskId: 'quick_1720000000000' }), false);
assert.strictEqual(isReferentialTaskSession({ taskId: 'quickWork_partial_1720000000000' }), false);
assert.strictEqual(isReferentialTaskSession({ taskId: 'call_partial_1720000000000' }), false);
assert.strictEqual(isReferentialTaskSession({ taskId: '' }), false);                              // no task claimed
assert.strictEqual(isReferentialTaskSession({}), false);
assert.strictEqual(isReferentialTaskSession(null), false);
// A manager's session correction (SessionEditModal → createWorkSession) mints a SYNTHETIC
// `manual_<ts>` taskId that matches no tasks doc by construction. Before it was added to the
// synthetic prefixes, every legitimate correction was reported as orphaned credit for LOOKBACK_DAYS
// and flipped the daily integrity report to 'warning' — the alarm fatigue that hides a real forgery.
assert.strictEqual(isReferentialTaskSession({ taskId: 'manual_1720000000000' }), false);
assert.strictEqual(isReferentialTaskSession({ taskId: 'manual_1720000000000', isManualSession: true }), false);
// The durable R-04 intents (manager-manual / backdate / gap-claim) reference a REAL task → checked.
// The isManualSession FLAG must never by itself exempt a row: only the synthetic id shape does, so a
// correction pinned to a real task stays orphan-checked and cannot smuggle in fabricated credit.
assert.strictEqual(isReferentialTaskSession({ taskId: 'realTask1', createdByAdmin: 'mgr1', isManualSession: true }), true);
assert.strictEqual(isReferentialTaskSession({ taskId: 'realTask1', isBackdated: true }), true);
assert.strictEqual(isReferentialTaskSession({ taskId: 'realTask1', isRecoveredGap: true }), true);

// 2. collectReferentialTaskIds — distinct real taskIds; system rows and no-task rows excluded.
const rows1 = [
    { id: 'w1', taskId: 'A' },
    { id: 'w2', taskId: 'A' },                          // dup taskId collapses
    { id: 'w3', taskId: 'B', isBackdated: true },
    { id: 'w4', taskId: 'call_1', isSystemTask: true }, // excluded (system)
    { id: 'w5', taskId: 'quick_1', isQuickWork: true }, // excluded (system)
    { id: 'w6' },                                       // excluded (no taskId)
];
assert.deepStrictEqual(collectReferentialTaskIds(rows1).sort(), ['A', 'B']);

// 3. findOrphanSessions — referential rows whose task is absent are orphans; system rows never are.
const orphanRes = findOrphanSessions(rows1, new Set(['A'])); // B does not exist
assert.strictEqual(orphanRes.orphans, 1);
assert.strictEqual(orphanRes.samples.length, 1);
assert.strictEqual(orphanRes.samples[0].taskId, 'B');
assert.strictEqual(orphanRes.samples[0].id, 'w3');
// System rows (call_1 / quick_1) are absent from `existing` yet must NOT be flagged.
assert.strictEqual(findOrphanSessions(rows1, new Set(['A', 'B'])).orphans, 0);
// sampleLimit honored while the full count is still returned.
const many = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, taskId: `ghost${i}` }));
const manyRes = findOrphanSessions(many, new Set());
assert.strictEqual(manyRes.orphans, 30);
assert.strictEqual(manyRes.samples.length, 20);

// 4. classifySuspiciousWorkDays — work-only per-day totals in (16h, 24h] are flagged.
const dayOf = (iso) => String(iso).slice(0, 10); // 'YYYY-MM-DD...' -> day; deterministic, tz-free
const rows2 = [
    // U1 on 2026-07-11: 10h + 8h = 18h WORK → suspicious (both rows individually valid, sum < 24h,
    // so neither the per-row anomaly scan nor the combined-overdraft scan would see it).
    { userId: 'U1', durationMinutes: 600, startTime: '2026-07-11T06:00:00Z' },
    { userId: 'U1', durationMinutes: 480, startTime: '2026-07-11T18:00:00Z' },
    { userId: 'U2', durationMinutes: 480, startTime: '2026-07-11T08:00:00Z' }, // 8h → fine
    { userId: 'U3', durationMinutes: 1500, startTime: '2026-07-11T00:00:00Z' }, // 25h → impossible tier, not here
    { userId: 'U1', durationMinutes: -5, startTime: '2026-07-11T09:00:00Z' },   // ignored (<= 0)
    { userId: '', durationMinutes: 600, startTime: '2026-07-11T09:00:00Z' },    // ignored (no user)
    { userId: 'U4', durationMinutes: 600 },                                     // ignored (no anchor)
];
const susp = classifySuspiciousWorkDays(rows2, dayOf);
assert.strictEqual(susp.count, 1);
assert.strictEqual(susp.samples[0].userId, 'U1');
assert.strictEqual(susp.samples[0].minutes, 1080);
assert.strictEqual(susp.samples[0].date, '2026-07-11');
// Boundary: exactly 16h is NOT flagged (strictly greater); one minute over IS.
assert.strictEqual(
    classifySuspiciousWorkDays([{ userId: 'B1', durationMinutes: SUSPICIOUS_DAY_WORK_MINUTES, startTime: '2026-07-11T06:00:00Z' }], dayOf).count,
    0,
);
assert.strictEqual(
    classifySuspiciousWorkDays([{ userId: 'B2', durationMinutes: SUSPICIOUS_DAY_WORK_MINUTES + 1, startTime: '2026-07-11T06:00:00Z' }], dayOf).count,
    1,
);
// Anchors on createdAt when startTime is absent.
assert.strictEqual(
    classifySuspiciousWorkDays([{ userId: 'C1', durationMinutes: 1000, createdAt: '2026-07-11T06:00:00Z' }], dayOf).count,
    1,
);

// 5. classifyEngineAdoption — the ADR-0020 step-6 migration gate signal (engineVersion==2 share).
const adopt = classifyEngineAdoption([
    { engineVersion: 2 },              // engine
    { engineVersion: 2 },              // engine
    { engineVersion: 1 },              // legacy-ish (not 2)
    {},                                // no engineVersion → legacy
    { engineVersion: '2' },            // string, NOT === 2 → legacy (strict)
]);
assert.strictEqual(adopt.total, 5);
assert.strictEqual(adopt.engineV2, 2);
assert.strictEqual(adopt.legacy, 3);
assert.strictEqual(adopt.legacyPct, 60);
// Empty input never divides by zero.
const adoptEmpty = classifyEngineAdoption([]);
assert.strictEqual(adoptEmpty.total, 0);
assert.strictEqual(adoptEmpty.legacyPct, 0);
// The dormant-engine baseline: 100% legacy when nothing carries engineVersion==2.
const adoptDormant = classifyEngineAdoption([{}, { engineVersion: 1 }, { isSystemTask: true }]);
assert.strictEqual(adoptDormant.legacyPct, 100);
assert.strictEqual(adoptDormant.engineV2, 0);

// 6. findImpossibleSpanSessions — the clock-independent check. A timer cannot credit more work than
// the SERVER has seen its task exist, measured between two Firestore-assigned timestamps.
const MIN = 60 * 1000;
const T0 = 1_760_000_000_000;                 // task created (server)
const spanTasks = new Map([['taskOld', T0], ['taskNew', T0]]);

// Honest: 8h of work, row last written 9h after the task appeared — comfortably inside the span.
const honest = findImpossibleSpanSessions(
    [{ id: 's1', taskId: 'taskOld', userId: 'u1', durationMinutes: 480, serverAnchorMs: T0 + 540 * MIN }],
    spanTasks,
);
assert.strictEqual(honest.checked, 1);
assert.strictEqual(honest.count, 0);

// Impossible: 9h claimed against a task the server first saw 20 minutes before the row was written.
const impossible = findImpossibleSpanSessions(
    [{ id: 's2', taskId: 'taskNew', userId: 'u2', durationMinutes: 540, serverAnchorMs: T0 + 20 * MIN }],
    spanTasks,
);
assert.strictEqual(impossible.count, 1);
assert.strictEqual(impossible.samples[0].id, 's2');
assert.strictEqual(impossible.samples[0].serverSpanMinutes, 20);

// The grace is real: a claim exactly at span+grace passes, one minute beyond it does not.
const atGrace = findImpossibleSpanSessions(
    [{ id: 's3', taskId: 'taskNew', durationMinutes: 60 + SERVER_SPAN_GRACE_MINUTES, serverAnchorMs: T0 + 60 * MIN }],
    spanTasks,
);
assert.strictEqual(atGrace.count, 0);
const pastGrace = findImpossibleSpanSessions(
    [{ id: 's4', taskId: 'taskNew', durationMinutes: 61 + SERVER_SPAN_GRACE_MINUTES, serverAnchorMs: T0 + 60 * MIN }],
    spanTasks,
);
assert.strictEqual(pastGrace.count, 1);

// HAND-AUTHORED intents describe work that predates the row, so the span says nothing — never judged.
const handAuthored = findImpossibleSpanSessions(
    [
        { id: 'b1', taskId: 'taskNew', durationMinutes: 540, serverAnchorMs: T0 + MIN, isBackdated: true },
        { id: 'g1', taskId: 'taskNew', durationMinutes: 540, serverAnchorMs: T0 + MIN, isRecoveredGap: true },
        { id: 'm1', taskId: 'taskNew', durationMinutes: 540, serverAnchorMs: T0 + MIN, isManualSession: true },
    ],
    spanTasks,
);
assert.strictEqual(handAuthored.checked, 0);
assert.strictEqual(handAuthored.count, 0);

// System sessions (call / quick-work) carry a synthetic taskId and are out of scope entirely.
const systemRows = findImpossibleSpanSessions(
    [{ id: 'q1', taskId: 'quick_1720000000000', durationMinutes: 540, serverAnchorMs: T0 + MIN }],
    spanTasks,
);
assert.strictEqual(systemRows.checked, 0);

// FAIL-SAFE: a missing anchor on either side is unmeasurable, never an accusation.
const unmeasurable = findImpossibleSpanSessions(
    [
        { id: 'n1', taskId: 'taskNew', durationMinutes: 540, serverAnchorMs: null },
        { id: 'n2', taskId: 'unknownTask', durationMinutes: 540, serverAnchorMs: T0 + MIN },
    ],
    spanTasks,
);
assert.strictEqual(unmeasurable.checked, 0);
assert.strictEqual(unmeasurable.count, 0);

// ARCHIVED-TASK REGRESSION (observed in production on this check's first day: 26 of 97 rows flagged,
// every sample a NEGATIVE span). Archiving writes a new document under the same id in another
// collection, so the copy's createTime is the archive moment — LATER than the run it is meant to
// bound. Supplying that as the anchor turns every honest session on an archived task into an
// accusation, so scanCreditIntegrity harvests createTime from `tasks` only and an archived task
// arrives here anchor-less.
//
// First: prove the damage is real, i.e. that an archive-copy anchor really does flag honest work —
// otherwise the caller-side restriction below would look like a precaution against nothing.
const archivedAnchor = new Map([['archivedTask', T0 + 21 * 60 * MIN]]); // archived ~21h AFTER the run
const wouldAccuse = findImpossibleSpanSessions(
    [{ id: 'a1', taskId: 'archivedTask', durationMinutes: 45, serverAnchorMs: T0 + 46 * MIN }],
    archivedAnchor,
);
assert.strictEqual(wouldAccuse.count, 1);
assert.ok(wouldAccuse.samples[0].serverSpanMinutes < 0, 'archive-copy anchor yields a negative span');
// Then: with the caller supplying no anchor for it (the fix), the same honest row is skipped.
const archivedSkipped = findImpossibleSpanSessions(
    [{ id: 'a1', taskId: 'archivedTask', durationMinutes: 45, serverAnchorMs: T0 + 46 * MIN }],
    new Map(),
);
assert.strictEqual(archivedSkipped.checked, 0);
assert.strictEqual(archivedSkipped.count, 0);

// ---------------------------------------------------------------------------
// 7. classifySessionDisagreements — do users/, tasks/ and active_sessions/ agree about who is
//    working right now? Report-only cross-store reconciliation.
// ---------------------------------------------------------------------------
const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const agoIso = (min) => new Date(NOW - min * 60000).toISOString();
const SETTLED = agoIso(120);   // comfortably past the settle window
const JUST_NOW = agoIso(2);    // still mid-handshake
const running = (id, userId, startedMin = 120) => ({ id, assignedUserId: userId, timerStartedAt: agoIso(startedMin) });
const disagree = (input) => classifySessionDisagreements({ nowMs: NOW, ...input });

// claimedTaskRun — activeSession wins, and a SECONDARY session claims no task even when the legacy
// workStatus still reads 'running' from before the break started. Reading both would report every
// break in the company as a conflict; this ordering is the whole reason the check stays quiet.
assert.deepStrictEqual(
    claimedTaskRun({ activeSession: { type: 'task', taskId: 'T1', startTime: SETTLED } }),
    { taskId: 'T1', startIso: SETTLED, source: 'activeSession' },
);
assert.strictEqual(
    claimedTaskRun({ activeSession: { type: 'break', startTime: SETTLED }, workStatus: { status: 'running', activeTaskId: 'T1' } }),
    null,
);
assert.deepStrictEqual(
    claimedTaskRun({ workStatus: { status: 'running', activeTaskId: 'T1', lastUpdated: SETTLED } }),
    { taskId: 'T1', startIso: SETTLED, source: 'workStatus' },
);
assert.strictEqual(claimedTaskRun({ workStatus: { status: 'paused', activeTaskId: 'T1' } }), null);
assert.strictEqual(claimedTaskRun({}), null);

// THE HEALTHY DAY. Verified against production on 2026-07-29: two workers, two running tasks, the
// user documents naming exactly those tasks. A check that cannot stay silent here is a check nobody
// will read, so this case is pinned first.
const healthy = disagree({
    users: [
        { id: 'U1', activeSession: { type: 'task', taskId: 'T1', startTime: SETTLED }, workStatus: { status: 'running', activeTaskId: 'T1' } },
        { id: 'U2', activeSession: { type: 'task', taskId: 'T2', startTime: SETTLED } },
    ],
    runningTasks: [running('T1', 'U1'), running('T2', 'U2')],
    taskStates: new Map([['T1', { exists: true, timerStatus: 'running' }], ['T2', { exists: true, timerStatus: 'running' }]]),
});
assert.strictEqual(healthy.count, 0);
assert.strictEqual(healthy.checked, 2);

// staleUserRun — the leftover the 16h auto-stop knowingly creates: it settles the task but leaves
// the worker's own document advertising the run until they reopen the app.
const stale = disagree({
    users: [{ id: 'U1', activeSession: { type: 'task', taskId: 'T1', startTime: SETTLED } }],
    runningTasks: [],
    taskStates: new Map([['T1', { exists: true, timerStatus: 'paused' }]]),
});
assert.strictEqual(stale.count, 1);
assert.strictEqual(stale.byKind.staleUserRun, 1);
assert.strictEqual(stale.samples[0].taskId, 'T1');
assert.strictEqual(stale.samples[0].taskTimerStatus, 'paused');

// A deleted task is reported as 'missing' rather than skipped — the claim is still wrong.
const claimsDeleted = disagree({
    users: [{ id: 'U1', activeSession: { type: 'task', taskId: 'GONE', startTime: SETTLED } }],
    taskStates: new Map([['GONE', { exists: false, timerStatus: null }]]),
});
assert.strictEqual(claimsDeleted.byKind.staleUserRun, 1);
assert.strictEqual(claimsDeleted.samples[0].taskTimerStatus, 'missing');

// SETTLE WINDOW — a claim younger than the window is a handshake in flight, not a disagreement.
// Starting a run writes the user doc, the task doc and the canonical record separately, and an
// offline client replays its queue whenever it reconnects.
const inFlight = disagree({
    users: [{ id: 'U1', activeSession: { type: 'task', taskId: 'T1', startTime: JUST_NOW } }],
    taskStates: new Map([['T1', { exists: true, timerStatus: 'paused' }]]),
});
assert.strictEqual(inFlight.count, 0);
assert.strictEqual(inFlight.checked, 1); // looked at it, declined to judge it

// FAIL-SAFE — a task that could not be read is absent from taskStates, and absence of evidence must
// never become a finding.
const unreadable = disagree({
    users: [{ id: 'U1', activeSession: { type: 'task', taskId: 'T1', startTime: SETTLED } }],
    taskStates: new Map(),
});
assert.strictEqual(unreadable.count, 0);
// ...as is an unparseable start instant.
assert.strictEqual(disagree({
    users: [{ id: 'U1', activeSession: { type: 'task', taskId: 'T1', startTime: 'not-a-date' } }],
    taskStates: new Map([['T1', { exists: true, timerStatus: 'paused' }]]),
}).count, 0);

// multipleRunningTasks — a pauseOtherTasks that did not take. BOTH intervals accrue, which is the
// shape that silently inflates credit. One finding per WORKER, not per extra task.
const doubleRun = disagree({
    users: [{ id: 'U1', activeSession: { type: 'task', taskId: 'T2', startTime: SETTLED } }],
    runningTasks: [running('T1', 'U1', 300), running('T2', 'U1', 120), running('T3', 'U1', 90)],
    taskStates: new Map([
        ['T1', { exists: true, timerStatus: 'running' }],
        ['T2', { exists: true, timerStatus: 'running' }],
        ['T3', { exists: true, timerStatus: 'running' }],
    ]),
});
assert.strictEqual(doubleRun.byKind.multipleRunningTasks, 1);
assert.deepStrictEqual(doubleRun.samples[0].taskIds.sort(), ['T1', 'T2', 'T3']);
// Two runs seconds apart is a pause still in flight — judged by the OLDEST run, so this is silent.
assert.strictEqual(disagree({
    runningTasks: [running('T1', 'U1', 2), running('T2', 'U1', 1)],
}).byKind.multipleRunningTasks, 0);
// Two workers with one run each is the normal healthy shape, not a conflict.
assert.strictEqual(disagree({
    runningTasks: [running('T1', 'U1'), running('T2', 'U2')],
}).byKind.multipleRunningTasks, 0);

// canonicalOrphanRun — the revisioned engine's record still holds a task run whose task stopped.
const canonicalOrphan = disagree({
    canonicalRecords: [{ uid: 'U1', status: 'active', run: { type: 'task', taskId: 'T1', runId: 'r1', startedAt: SETTLED } }],
    taskStates: new Map([['T1', { exists: true, timerStatus: 'paused' }]]),
});
assert.strictEqual(canonicalOrphan.byKind.canonicalOrphanRun, 1);
assert.strictEqual(canonicalOrphan.samples[0].runId, 'r1');
// An idle record, or one whose task really is running, says nothing.
assert.strictEqual(disagree({
    canonicalRecords: [{ uid: 'U1', status: 'idle', run: null }],
}).count, 0);
assert.strictEqual(disagree({
    canonicalRecords: [{ uid: 'U1', status: 'active', run: { type: 'task', taskId: 'T1', startedAt: SETTLED } }],
    taskStates: new Map([['T1', { exists: true, timerStatus: 'running' }]]),
}).count, 0);
// A canonical SECONDARY run (break/call/quick-work) has no task projection to disagree with.
assert.strictEqual(disagree({
    canonicalRecords: [{ uid: 'U1', status: 'active', run: { type: 'break', startedAt: SETTLED } }],
}).count, 0);

// Empty input must not throw — the collections are legitimately empty on a quiet night.
assert.strictEqual(classifySessionDisagreements({ nowMs: NOW }).count, 0);

console.log('integrityScans.test.cjs: all assertions passed');
