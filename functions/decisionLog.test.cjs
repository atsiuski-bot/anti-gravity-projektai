/**
 * Dependency-free assertions for the server-side SYSTEM-actor decision_log appender.
 * functions/ has no test runner (logic is mirrored from src/ and kept in lockstep by review), so
 * this runs standalone: `node functions/decisionLog.test.cjs`. It guards the two things that matter
 * — the record SCHEMA matches the client appender, and the write is idempotent + best-effort.
 */

const assert = require('assert');
const { buildSystemRecord, appendSystemDecision } = require('./decisionLog');

// 1. buildSystemRecord stamps a SYSTEM actor and mirrors src/domain/decisionLog.js's record shape.
const rec = buildSystemRecord({
    source: 'dailyIntegrityScan',
    command: 'integrity.autoStopTimer',
    targetType: 'task',
    targetId: 'task123',
    reason: 'Auto-stopped a timer left running 1200 min (>16h); phantom interval discarded',
    before: { timerStatus: 'running' },
    after: { timerStatus: 'paused' },
    idempotencyKey: 'autostop_task123_x',
});
assert.strictEqual(rec.actorType, 'system');
assert.strictEqual(rec.actorId, 'dailyIntegrityScan');
assert.strictEqual(rec.actorName, 'dailyIntegrityScan');
assert.strictEqual(rec.command, 'integrity.autoStopTimer');
assert.strictEqual(rec.targetType, 'task');
assert.strictEqual(rec.targetId, 'task123');
assert.strictEqual(rec.mode, 'commit');
assert.strictEqual(rec.correlationId, 'autostop_task123_x'); // defaults to idempotencyKey
assert.ok(typeof rec.ts === 'string' && rec.ts.includes('T'));
assert.deepStrictEqual(rec.before, { timerStatus: 'running' });
// The schema must be EXACTLY these keys (lockstep with the client appender).
assert.deepStrictEqual(
    Object.keys(rec).sort(),
    ['actorId', 'actorName', 'actorType', 'after', 'before', 'command', 'correlationId', 'mode', 'reason', 'targetId', 'targetType', 'ts'],
);

// 2. Absent optional fields default to null (matches the client `?? null` idiom).
const rec2 = buildSystemRecord({ source: 's', command: 'c', idempotencyKey: 'k' });
assert.strictEqual(rec2.targetType, null);
assert.strictEqual(rec2.targetId, null);
assert.strictEqual(rec2.reason, null);
assert.strictEqual(rec2.before, null);
assert.strictEqual(rec2.after, null);
// Missing source degrades to the generic 'system' identity (never throws, mirrors systemActor()).
assert.strictEqual(buildSystemRecord({ command: 'c', idempotencyKey: 'k' }).actorId, 'system');

(async () => {
    // 3. appendSystemDecision writes via create() and returns the record with its id.
    let createdWith = null;
    const okDb = { collection: () => ({ doc: () => ({ create: async (r) => { createdWith = r; } }) }) };
    const out = await appendSystemDecision(okDb, { idempotencyKey: 'k1', command: 'recurring.generate', source: 's', targetId: 't1' });
    assert.ok(out && out.id === 'k1');
    assert.strictEqual(createdWith.actorType, 'system');
    assert.strictEqual(createdWith.targetId, 't1');

    // 4. ALREADY_EXISTS (retry / re-fired trigger) is swallowed → null, no throw (audit dedup).
    const dupDb = { collection: () => ({ doc: () => ({ create: async () => { const e = new Error('exists'); e.code = 6; throw e; } }) }) };
    assert.strictEqual(await appendSystemDecision(dupDb, { idempotencyKey: 'k1', command: 'c', source: 's' }), null);

    // 5. Any other failure is best-effort: returns null, never throws (the effect already stands).
    const errDb = { collection: () => ({ doc: () => ({ create: async () => { throw new Error('network'); } }) }) };
    assert.strictEqual(await appendSystemDecision(errDb, { idempotencyKey: 'k2', command: 'c', source: 's' }), null);

    // 6. Missing required fields → null, no write attempted.
    let touched = false;
    const guardDb = { collection: () => { touched = true; return { doc: () => ({ create: async () => {} }) }; } };
    assert.strictEqual(await appendSystemDecision(guardDb, { command: 'c' }), null);
    assert.strictEqual(touched, false);

    console.log('decisionLog.test.cjs: all assertions passed');
})().catch((err) => {
    console.error('decisionLog.test.cjs FAILED:', err && err.message);
    process.exit(1);
});
