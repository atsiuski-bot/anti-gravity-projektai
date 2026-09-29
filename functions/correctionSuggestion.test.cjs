/**
 * Dependency-free assertions for the AI time-correction clamp (suggestTimeCorrection).
 * Runs standalone: `node functions/correctionSuggestion.test.cjs`.
 *
 * The model's answer is untrusted text. These cases pin the one property that makes it safe to show
 * a worker: every id and time in the result is one the CALLER supplied, and a proposal that lacks
 * what its kind needs degrades to 'other' (a plain comment) instead of a half-formed fix.
 */

const assert = require('assert');
const { sanitizeCorrectionSuggestion: s } = require('./correctionSuggestion');

const rows = [
    { id: 'w1', type: 'work', title: 'Stogas', start: '08:00', end: '18:30' },
    { id: 'b1', type: 'break', title: '', start: '12:00', end: '12:45' },
];
const tasks = [{ id: 't1', title: 'Stogas' }];

// missed_start keeps a listed task and the stated interval, and never carries a row.
assert.deepStrictEqual(
    s({ kind: 'missed_start', rowId: 'w1', taskId: 't1', start: '06:30', end: '08:00', summary: ' Pridėti\n 1,5 val. ' }, rows, tasks),
    { kind: 'missed_start', rowId: '', taskId: 't1', start: '06:30', end: '08:00', summary: 'Pridėti 1,5 val.' }
);
// …an invented task id is dropped, not trusted.
assert.strictEqual(s({ kind: 'missed_start', taskId: 'colleague-task', start: '06:30', end: '08:00' }, rows, tasks).taskId, '');
// …and without both times there is nothing to credit.
assert.strictEqual(s({ kind: 'missed_start', start: '06:30' }, rows, tasks).kind, 'other');

// missed_stop needs a WORK row the caller listed; the start falls back to the row's own.
assert.deepStrictEqual(
    s({ kind: 'missed_stop', rowId: 'w1', end: '16:00' }, rows, tasks),
    { kind: 'missed_stop', rowId: 'w1', taskId: '', start: '08:00', end: '16:00', summary: '' }
);
assert.strictEqual(s({ kind: 'missed_stop', rowId: 'someone-elses-row', end: '16:00' }, rows, tasks).kind, 'other');
assert.strictEqual(s({ kind: 'missed_stop', rowId: 'b1', end: '12:10' }, rows, tasks).kind, 'other');

// wrong_time needs a work row and a new end; an unstated start keeps the row's own.
assert.strictEqual(s({ kind: 'wrong_time', rowId: 'w1', start: '07:00', end: '18:30' }, rows, tasks).kind, 'wrong_time');
assert.strictEqual(s({ kind: 'wrong_time', rowId: 'w1', end: '19:00' }, rows, tasks).start, '08:00');
// Unparseable times are never turned into a fix.
assert.strictEqual(s({ kind: 'wrong_time', rowId: 'w1', start: '7 ryte', end: 'vakare' }, rows, tasks).kind, 'other');

// break_was_work must point at a BREAK row.
assert.strictEqual(s({ kind: 'break_was_work', rowId: 'b1', taskId: 't1' }, rows, tasks).kind, 'break_was_work');
assert.strictEqual(s({ kind: 'break_was_work', rowId: 'w1' }, rows, tasks).kind, 'other');

// Garbage in → a plain comment out.
assert.deepStrictEqual(s(null, rows, tasks), { kind: 'other', rowId: '', taskId: '', start: '', end: '', summary: '' });
assert.strictEqual(s({ kind: 'delete_everything' }, rows, tasks).kind, 'other');
assert.strictEqual(s({ kind: 'missed_start', start: '25:00', end: '08:00' }, rows, tasks).kind, 'other');

console.log('correctionSuggestion.test: OK');
