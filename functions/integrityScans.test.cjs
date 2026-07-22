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
    classifyEngineAdoption,
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

console.log('integrityScans.test.cjs: all assertions passed');
