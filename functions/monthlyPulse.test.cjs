/**
 * Dependency-free assertions for the monthly pulse aggregate (monthlyPulse.js, ADR 0034).
 * functions/ has no test runner, so this runs standalone: `node functions/monthlyPulse.test.cjs`.
 *
 * The expected numbers are worked out by hand from the fixtures below. They pin the rules the old
 * off-repo collector used, so a refactor that drifts from them shows up here before the live
 * side-by-side comparison does.
 */

const assert = require('assert');
const {
    MAX_USERS,
    pulseWindow,
    checkBearer,
    parsePulseRequest,
    localHour,
    summariseSessions,
    summariseTasks,
    buildPulse,
} = require('./monthlyPulse');

// --- window -----------------------------------------------------------------
const win = pulseWindow('2026-10');
assert.deepStrictEqual(win, {
    target: '2026-10',
    months: ['2026-07', '2026-08', '2026-09', '2026-10'],
    from: '2026-07-01',
    to: '2026-10-31',
    archivedFrom: '2026-06-15',
    staleCut: '2026-10-01',
});
// Year rollover.
assert.deepStrictEqual(pulseWindow('2026-01').months, ['2025-10', '2025-11', '2025-12', '2026-01']);
assert.strictEqual(pulseWindow('2026-01').archivedFrom, '2025-09-15');
// Leap February.
assert.strictEqual(pulseWindow('2028-02').to, '2028-02-29');
assert.strictEqual(pulseWindow('2027-02').to, '2027-02-28');
for (const bad of ['2026-13', '2026-00', '2026-1', '202610', 202610, null, undefined, '']) {
    assert.strictEqual(pulseWindow(bad), null, `pulseWindow(${JSON.stringify(bad)}) should be null`);
}

// --- bearer token -----------------------------------------------------------
const TOKEN = 'x'.repeat(40);
assert.strictEqual(checkBearer(`Bearer ${TOKEN}`, TOKEN), true);
assert.strictEqual(checkBearer(`Bearer ${TOKEN}y`, TOKEN), false);
assert.strictEqual(checkBearer(TOKEN, TOKEN), false, 'missing Bearer prefix');
assert.strictEqual(checkBearer(undefined, TOKEN), false);
// A configured token that is too short (or unset) refuses everyone — fail closed.
assert.strictEqual(checkBearer('Bearer short', 'short'), false);
assert.strictEqual(checkBearer('Bearer ', ''), false);
assert.strictEqual(checkBearer('Bearer undefined', undefined), false);

// --- request body -----------------------------------------------------------
const UID_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const UID_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBB2';
assert.deepStrictEqual(parsePulseRequest({ month: '2026-10', userIds: [UID_A, UID_B, UID_A] }),
    { ok: true, month: '2026-10', userIds: [UID_A, UID_B] });
assert.deepStrictEqual(parsePulseRequest(null), { ok: false, error: 'bad_body' });
assert.deepStrictEqual(parsePulseRequest({ month: '2026-13', userIds: [UID_A] }), { ok: false, error: 'bad_month' });
assert.deepStrictEqual(parsePulseRequest({ month: '2026-10', userIds: [] }), { ok: false, error: 'bad_user_ids' });
assert.deepStrictEqual(parsePulseRequest({ month: '2026-10', userIds: UID_A }), { ok: false, error: 'bad_user_ids' });
assert.deepStrictEqual(parsePulseRequest({ month: '2026-10', userIds: ['../users'] }), { ok: false, error: 'bad_user_ids' });
assert.deepStrictEqual(parsePulseRequest({ month: '2026-10', userIds: Array.from({ length: MAX_USERS + 1 }, (_, i) => `${UID_A.slice(0, 20)}${String(i).padStart(8, '0')}`) }),
    { ok: false, error: 'bad_user_ids' });

// --- Vilnius hour (fixed offset by month, as the collector did) --------------
assert.strictEqual(localHour('2026-10-05T05:30:00Z', '2026-10-05'), 8.5); // EEST, UTC+3
assert.strictEqual(localHour('2026-01-05T05:30:00Z', '2026-01-05'), 7.5); // EET, UTC+2
assert.strictEqual(localHour('not a date', '2026-10-05'), null);
assert.strictEqual(localHour(undefined, '2026-10-05'), null);

// --- sessions ---------------------------------------------------------------
const sessions = [
    { date: '2026-10-05', durationMinutes: 120, startTime: '2026-10-05T05:30:00Z', taskId: 'abc' },
    { date: '2026-10-05', durationMinutes: 60, startTime: '2026-10-05T04:00:00Z', isQuickWork: true },
    { date: '2026-10-06', durationMinutes: 30, startTime: '2026-10-06T06:00:00Z', taskId: 'call_x' },
    { date: '2026-10-06', durationMinutes: 45, isSystemTask: true },
    { date: '2026-10-07', durationMinutes: 800, startTime: '2026-10-07T03:00:00Z', taskId: 'manual_y', isManualSession: true },
    { date: '2026-10-07', durationMinutes: 100, taskId: 'abc', isDeleted: true },
    { date: '2026-06-30', durationMinutes: 300, taskId: 'abc' }, // before the window
    { date: '2026-07-01', durationMinutes: 90, taskId: 't' },
];
const breaks = [
    { date: '2026-10-05', durationMinutes: 15 },
    { date: '2026-10-06', durationMinutes: 20, isDeleted: true },
    { date: '2026-10-06', durationMinutes: 10 },
];
const months = summariseSessions(sessions, breaks, win);
assert.deepStrictEqual(months['2026-10'], {
    totalH: 17.6, taskH: 2, quickH: 1, callH: 0.5, systemH: 0.8, otherH: 13.3,
    sessions: 5, workDays: 3,
    avgDayH: 5.9, medianDayH: 3, maxDayH: 13.3,
    medianStart: 7,
    manualH: 13.3,
    bigDays: ['2026-10-07:13.3h'],
    breakH: 0.4, breakCount: 2,
});
assert.deepStrictEqual(months['2026-07'], {
    totalH: 1.5, taskH: 1.5, quickH: 0, callH: 0, systemH: 0, otherH: 0,
    sessions: 1, workDays: 1,
    avgDayH: 1.5, medianDayH: 1.5, maxDayH: 1.5,
    medianStart: null,
    manualH: 0,
    bigDays: [],
    breakH: 0, breakCount: 0,
});
assert.deepStrictEqual(months['2026-08'], {
    totalH: 0, taskH: 0, quickH: 0, callH: 0, systemH: 0, otherH: 0,
    sessions: 0, workDays: 0,
    avgDayH: null, medianDayH: null, maxDayH: null,
    medianStart: null,
    manualH: 0,
    bigDays: [],
    breakH: 0, breakCount: 0,
});

// --- tasks ------------------------------------------------------------------
const LONG = 'A'.repeat(50);
const tasks = [
    { title: LONG, completedAt: '2026-10-10T10:00:00Z', estimatedTimeMinutes: 60, timerMinutes: 50, manualMinutes: 30, createdBy: 'mgr1', timeExtensions: [{}] },
    { title: 'B', completedAt: '2026-10-12T10:00:00Z', estimatedTimeMinutes: 100, timerMinutes: 40, createdBy: 'system_automation' },
    { title: 'C', completedAt: '2026-10-15T10:00:00Z', timerMinutes: 30 },
    // A Firestore Timestamp still buckets by month.
    { title: 'D', completedAt: { toDate: () => new Date('2026-09-03T08:00:00Z') }, estimatedTimeMinutes: 30, timerMinutes: 30, createdBy: 'mgr1' },
    { title: 'Old task', status: 'pending', createdAt: '2026-09-20T08:00:00Z', deadline: '2026-10-01' },
    { title: 'Fresh task', status: 'in_progress', createdAt: '2026-10-05T08:00:00Z' },
    { title: 'Awaiting', status: 'completed', completedAt: '2026-10-20T08:00:00Z', createdBy: 'mgr2' },
    { title: 'Archived undone', status: 'pending', archivedAt: '2026-10-21T08:00:00Z', createdAt: '2026-08-01T08:00:00Z' },
    { title: 'Long ago', status: 'confirmed', confirmedAt: '2026-05-02T08:00:00Z', completedAt: '2026-05-01T08:00:00Z' },
];
const t = summariseTasks(tasks, win);
assert.deepStrictEqual(t.byMonth['2026-10'], {
    done: 4, withEst: 2,
    medianAccuracy: 0.9,
    overruns25: 1, wayUnder: 1, extended: 1,
    worst: [`${'A'.repeat(40)} (60m→80m)`, 'B (100m→40m)'],
});
assert.deepStrictEqual(t.byMonth['2026-09'], {
    done: 1, withEst: 1, medianAccuracy: 1, overruns25: 0, wayUnder: 0, extended: 0, worst: ['D (30m→30m)'],
});
assert.strictEqual(t.byMonth['2026-07'].done, 0);
assert.strictEqual(t.openNow, 2);
assert.strictEqual(t.waitingAccept, 1);
assert.deepStrictEqual(t.staleOpen, [{ title: 'Old task', created: '2026-09-20', deadline: '2026-10-01' }]);
assert.deepStrictEqual(t.creators, {
    '2026-10': { mgr1: 1, system_automation: 1, '?': 1, mgr2: 1 },
    '2026-09': { mgr1: 1 },
});

// --- response body ----------------------------------------------------------
const pulse = buildPulse(win, {
    [UID_A]: { sessions, breaks, tasks },
    [UID_B]: { sessions: [], breaks: [], tasks: [{ title: 'E', completedAt: '2026-10-01T08:00:00Z', createdBy: 'mgr1' }] },
}, '2026-11-01T06:00:00.000Z');
assert.deepStrictEqual(pulse.window, { months: win.months, from: '2026-07-01', to: '2026-10-31', generatedAt: '2026-11-01T06:00:00.000Z' });
assert.deepStrictEqual(Object.keys(pulse.users), [UID_A, UID_B]);
assert.deepStrictEqual(Object.keys(pulse.users[UID_A]), ['months', 'tasks']);
assert.deepStrictEqual(Object.keys(pulse.users[UID_A].tasks), ['byMonth', 'openNow', 'waitingAccept', 'staleOpen']);
assert.deepStrictEqual(pulse.users[UID_A].months, months);
assert.strictEqual(pulse.tasksByCreator['2026-10'].mgr1, 2, 'creator counts merge across people');
assert.strictEqual(pulse.tasksByCreator['2026-09'].mgr1, 1);

console.log('monthlyPulse.test: OK');
