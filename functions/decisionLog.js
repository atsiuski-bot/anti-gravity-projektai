/**
 * Server-side DECISION LOG appender for SYSTEM-actor automation (ADR 0015).
 *
 * The client command kernel (src/domain/) already appends a decision_log entry for every human (and
 * later agent) command. But the scheduled Cloud Functions — the recurring-task generator and the
 * integrity scan's forgotten-timer auto-stop — MUTATE domain state with NO audit line, so the event
 * spine has no record that "the system changed this, and why". This appender closes that gap: it is
 * the admin-SDK mirror of src/domain/decisionLog.js, stamping an explicit `system` actor.
 *
 * WHY admin-SDK-only: the decision_log firestore.rules pin a CLIENT create to actorType:'human'
 * acting as itself (a human cannot launder a decision as a system job). The admin SDK bypasses the
 * rules, so a `system` (or future `agent`) entry can ONLY be written here, server-side. The write
 * therefore does NOT depend on the client rules being deployed — it succeeds regardless; the rules
 * gate only client writes and manager reads.
 *
 * SCHEMA LOCKSTEP: the record shape is identical to the client appender's (actorType/actorId/
 * actorName + command/targetType/targetId/reason/before/after/correlationId/mode/ts), so human,
 * agent and system entries form ONE homogeneous, queryable audit surface. Keep both in sync.
 *
 * IDEMPOTENCY + IMMUTABILITY: the doc id IS the idempotency key and the write uses create() (not
 * set). A re-fired trigger / function retry that recomputes the same key hits ALREADY_EXISTS, which
 * is swallowed — the original entry stands instead of duplicating. create() also means a system job
 * can never OVERWRITE an existing entry even though the admin SDK bypasses the immutable-update rule.
 *
 * BEST-EFFORT: NEVER throws, never aborts the job. By the time we append, the effect (the created
 * task / the stopped timer) has already been applied; losing an audit line is strictly less bad than
 * failing an already-done mutation. Every failure path returns null and is logged (warn).
 */

const DECISION_LOG_COLLECTION = 'decision_log';

// Lazy, fail-soft logger: keeps this module require-able in a bare unit context (no
// firebase-functions installed) while using the real logger in the deployed runtime.
function warn(message, meta) {
    try {
        require('firebase-functions/logger').warn(message, meta);
    } catch (_) {
        // logger unavailable (unit/test context) — degrade silently; this is best-effort audit anyway.
    }
}

/**
 * Build the immutable decision_log record for a SYSTEM actor. PURE — no writes, no I/O — so the
 * schema can be asserted in isolation against the client appender's shape.
 * @param {Object} args - { source, command, targetType, targetId, reason, before, after,
 *                          correlationId, idempotencyKey }
 *   source — the job name, e.g. 'dailyIntegrityScan' (becomes actorId + actorName, mirroring
 *            src/domain/actor.js systemActor()).
 */
function buildSystemRecord(args) {
    const {
        source,
        command,
        targetType,
        targetId,
        reason,
        before,
        after,
        correlationId,
        idempotencyKey,
    } = args || {};
    return {
        actorType: 'system',
        actorId: source || 'system',
        actorName: source || 'System',
        command,
        targetType: targetType || null,
        targetId: targetId || null,
        reason: reason || null,
        before: before ?? null,
        after: after ?? null,
        correlationId: correlationId || idempotencyKey,
        mode: 'commit',
        ts: new Date().toISOString(),
    };
}

/**
 * Append ONE system-actor decision. Best-effort, idempotent, never throws.
 * @param {FirebaseFirestore.Firestore} db - the admin Firestore instance.
 * @param {Object} args - see buildSystemRecord; MUST include idempotencyKey + command.
 * @returns {Promise<Object|null>} the written record (with `id`), or null on any failure / dedup.
 */
async function appendSystemDecision(db, args) {
    try {
        const { idempotencyKey, command } = args || {};
        if (!idempotencyKey || !command) {
            warn('appendSystemDecision: missing idempotencyKey/command', { command: command || null });
            return null;
        }
        const record = buildSystemRecord(args);
        try {
            await db.collection(DECISION_LOG_COLLECTION).doc(idempotencyKey).create(record);
            return { ...record, id: idempotencyKey };
        } catch (err) {
            // ALREADY_EXISTS (gRPC code 6) is the EXPECTED retry / re-fired-trigger class — the
            // original entry stands; not an error.
            if (err && (err.code === 6 || err.code === 'already-exists')) return null;
            throw err;
        }
    } catch (err) {
        warn('appendSystemDecision failed (audit lost, effect stands)', { err: err && err.message });
        return null;
    }
}

module.exports = { DECISION_LOG_COLLECTION, buildSystemRecord, appendSystemDecision };
