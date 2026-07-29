/**
 * Dependency-free assertions for the server-side work-day boundary and the archive rule.
 * functions/ has no test runner, so this runs standalone: `node functions/workDay.test.cjs`.
 *
 * These four boundary cases came over from src/utils/automationUtils.test.js when archiving moved
 * from the browser to a scheduled Cloud Function. They are kept verbatim in intent — each one is a
 * bug that was actually shipped once — and they now guard the server helper instead of the deleted
 * client one.
 */

const assert = require('assert');
const {
    WORK_DAY_START_HOUR,
    lithuanianDay,
    workDayCutoffUtc,
    addDaysToDay,
    currentWorkDay,
    taskArchivable,
} = require('./workDay');

assert.strictEqual(WORK_DAY_START_HOUR, 5);

// --- day bucketing ---------------------------------------------------------
// 22:30 UTC on 21 June is 01:30 Vilnius on the 22nd (summer, UTC+3).
assert.strictEqual(lithuanianDay(new Date('2026-06-21T22:30:00Z')), '2026-06-22');
// Winter (UTC+2): 22:30 UTC on 10 January is 00:30 on the 11th.
assert.strictEqual(lithuanianDay(new Date('2026-01-10T22:30:00Z')), '2026-01-11');

assert.strictEqual(addDaysToDay('2026-06-21', -1), '2026-06-20');
assert.strictEqual(addDaysToDay('2026-01-01', -1), '2025-12-31'); // year boundary
assert.strictEqual(addDaysToDay('2026-03-01', -1), '2026-02-28');

// --- DST: the boundary's UTC hour moves with the offset ---------------------
// Summer (UTC+3): 05:00 Vilnius == 02:00 UTC. Winter (UTC+2): 05:00 Vilnius == 03:00 UTC.
assert.strictEqual(workDayCutoffUtc('2026-06-21').toISOString(), '2026-06-21T02:00:00.000Z');
assert.strictEqual(workDayCutoffUtc('2026-01-10').toISOString(), '2026-01-10T03:00:00.000Z');
// The spring-forward day itself — noon reference means no oscillation, no off-by-one hour.
assert.strictEqual(workDayCutoffUtc('2026-03-29').toISOString(), '2026-03-29T02:00:00.000Z');

// --- currentWorkDay ---------------------------------------------------------
// 15:00 Vilnius: comfortably past the boundary, so the work day is today.
assert.strictEqual(currentWorkDay(new Date('2026-06-21T12:00:00Z')), '2026-06-21');
// 02:00 Vilnius on the 21st: before the boundary, so the work day is still the 20th.
assert.strictEqual(currentWorkDay(new Date('2026-06-20T23:00:00Z')), '2026-06-20');
// 04:00 Vilnius: after the OLD 03:00 boundary but before the current 05:00 one. This is the band the
// boundary move was made for — a night shift ending before dawn belongs to the day it began on.
assert.strictEqual(currentWorkDay(new Date('2026-06-21T01:00:00Z')), '2026-06-20');

// --- taskArchivable: the four cases carried over from the client test -------
// (1) After the boundary: work finished on an earlier day goes, today's stays.
assert.strictEqual(taskArchivable({ confirmedAt: '2026-06-19T10:00:00Z' }, '2026-06-21'), true);
assert.strictEqual(taskArchivable({ confirmedAt: '2026-06-21T10:00:00Z' }, '2026-06-21'), false);

// (2) Before the boundary the work day has rolled back, so YESTERDAY's work is still current.
{
    const day = currentWorkDay(new Date('2026-06-20T23:00:00Z')); // '2026-06-20'
    assert.strictEqual(taskArchivable({ confirmedAt: '2026-06-19T10:00:00Z' }, day), true);
    assert.strictEqual(taskArchivable({ confirmedAt: '2026-06-20T10:00:00Z' }, day), false);
}

// (3) THE NIGHT-SHIFT CASE. At 04:00 Vilnius the work day is still the 20th, so work accepted at
// 23:00 Vilnius that evening must NOT be archived out from under a worker who is still on shift.
// (20:00 UTC is chosen deliberately: 22:00 UTC would already bucket to the 21st and would pass under
// either boundary, proving nothing.)
{
    const day = currentWorkDay(new Date('2026-06-21T01:00:00Z')); // '2026-06-20'
    assert.strictEqual(taskArchivable({ confirmedAt: '2026-06-20T20:00:00Z' }, day), false);
    assert.strictEqual(taskArchivable({ confirmedAt: '2026-06-19T10:00:00Z' }, day), true);
}

// (4) THE LATE-EVENING BUG. 22:30 UTC on the 21st is 01:30 Vilnius on the 22nd, so its work day is
// TODAY and it stays. Comparing the ISO string's date prefix would read '2026-06-21' < '2026-06-22'
// and archive it a full cycle early — the bug this bucketing exists to prevent.
assert.strictEqual(taskArchivable({ confirmedAt: '2026-06-21T22:30:00Z' }, '2026-06-22'), false);

// --- which timestamp wins, and refusing to guess -----------------------------
// deletedAt outranks confirmedAt outranks updatedAt.
assert.strictEqual(
    taskArchivable({ deletedAt: '2026-06-19T10:00:00Z', confirmedAt: '2026-06-22T10:00:00Z' }, '2026-06-21'),
    true,
);
assert.strictEqual(
    taskArchivable({ confirmedAt: '2026-06-19T10:00:00Z', updatedAt: '2026-06-22T10:00:00Z' }, '2026-06-21'),
    true,
);
// No usable timestamp → left alone. Archiving is a MOVE, and nothing here is urgent enough to move a
// document on a guess.
assert.strictEqual(taskArchivable({}, '2026-06-21'), false);
assert.strictEqual(taskArchivable({ confirmedAt: 'not-a-date' }, '2026-06-21'), false);
assert.strictEqual(taskArchivable(null, '2026-06-21'), false);

console.log('workDay.test.cjs: all assertions passed');
