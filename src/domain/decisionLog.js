import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { logError } from '../utils/errorLog';
import { actorStamp } from './actor';

/**
 * Append-only DECISION LOG — the audit / event spine of the command layer (ADR 0015).
 *
 * Mutable current state (the task doc) answers "what is true now". This log answers "how it got
 * there, and who decided". Every consequential command appends ONE immutable record: the actor
 * stamp (who), the command + target (what), the reason (why), and a compact before/after summary.
 * That is what makes an action — human OR agent — attributable, reversible, and learnable, and
 * what a future analysis agent reads to reconstruct events without re-deriving them from scattered
 * mutable fields.
 *
 * IDEMPOTENCY: the document id IS the command's idempotency key. The first write is a `create`;
 * a retried command (agents retry) re-issues `setDoc` against the same id, which the rules treat
 * as an `update` and DENY (the log is immutable) — that denial is swallowed here (best-effort, see
 * below), so a retry simply leaves the original entry standing instead of duplicating it. Note this
 * de-dups the AUDIT, not the EFFECT: each command's `apply()` is REQUIRED to be idempotent (see
 * defineCommand), so a re-applied effect is harmless — the kernel re-runs apply on every retry.
 *
 * BEST-EFFORT: this function NEVER throws and never aborts a command — by the time we append, the
 * effect has already been applied, and losing the audit line is strictly less bad than rolling back
 * a completed action. EVERY failure path (invalid entry, a throwing actor stamp, a denied/failed
 * setDoc) returns null and is surfaced to the durable crash log. The crash-log `source` distinguishes
 * the failure CLASS so a real audit gap is greppable, not lost in routine retry denials:
 *   - `.denied`     — a `permission-denied` write. EXPECTED for a retry hitting the immutable doc;
 *                     ALSO what a not-yet-deployed rule or a non-human client commit produces, so a
 *                     SUSTAINED stream of `.denied` during rollout means the rules are not deployed.
 *   - `.AUDIT_LOST` — any other failure (network/quota, a malformed actor): a genuine, unexpected
 *                     loss of the original audit entry — the case worth alerting on.
 *   - `.invalidEntry` — a programmer error (the kernel always supplies a key + command); loud so the
 *                     misuse is greppable rather than silently dropped.
 * A consequence of best-effort: until the decision_log firestore.rules clause is deployed, appends
 * are denied and silently skipped (the command still succeeds, no audit) — deploy the rule before
 * routing real traffic through a command.
 */

export const DECISION_LOG_COLLECTION = 'decision_log';

/**
 * Append one decision record. Keyed by `idempotencyKey` so retries do not duplicate the audit.
 * @returns {Promise<Object|null>} the written record (with `id`), or null if the write failed.
 */
export const appendDecision = async (entry) => {
  const {
    idempotencyKey,
    command,
    actor,
    targetType,
    targetId,
    reason,
    before,
    after,
    correlationId,
    mode,
  } = entry || {};

  try {
    // The kernel always supplies a key + command; a miss here is a programmer error, surfaced
    // loudly but NOT thrown (the contract is "never throws, never aborts the command").
    if (!idempotencyKey || !command) {
      logError(new Error(`appendDecision: missing ${!idempotencyKey ? 'idempotencyKey' : 'command'}`),
        { source: 'decisionLog.appendDecision.invalidEntry' });
      return null;
    }

    // actorStamp() throws on a malformed actor — kept INSIDE the try so that, too, degrades to a
    // logged null rather than aborting an already-applied command.
    const record = {
      ...actorStamp(actor),
      command,
      targetType: targetType || null,
      targetId: targetId || null,
      reason: reason || null,
      before: before ?? null,
      after: after ?? null,
      correlationId: correlationId || idempotencyKey,
      mode: mode || 'commit',
      ts: new Date().toISOString(),
    };

    await setDoc(doc(db, DECISION_LOG_COLLECTION, idempotencyKey), record);
    return { ...record, id: idempotencyKey };
  } catch (err) {
    // A permission-denied is the EXPECTED retry/rollout class; anything else is a genuine audit loss.
    const denied = err && err.code === 'permission-denied';
    logError(err, { source: denied ? 'decisionLog.appendDecision.denied' : 'decisionLog.appendDecision.AUDIT_LOST' });
    return null;
  }
};
