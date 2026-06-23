import { appendDecision } from './decisionLog';
import { isAgent } from './actor';
import { areAgentsEnabled } from './agentControl';
import { logError } from '../utils/errorLog';

/**
 * Command kernel — the heart of the AI-native command layer (ADR 0015).
 *
 * `defineCommand()` wraps a domain operation with the cross-cutting concerns that EVERY
 * agent-capable command needs, so they are designed in ONCE instead of being retrofitted later
 * (the expensive mistake this layer exists to avoid):
 *
 *   • ACTOR       — who is acting (human / agent / system), recorded on every effect.
 *   • MODE        — 'propose' (compute + return the intended effect, write NOTHING) vs 'commit'
 *                   (apply the effect, then append the decision-log entry). Propose/commit is the
 *                   DEFAULT contract so an agent can be rolled out behind a human-approval gate and
 *                   have its autonomy raised gradually. The kernel DEFAULTS to propose — a command
 *                   never writes unless the caller explicitly asks to commit.
 *   • IDEMPOTENCY — every invocation carries a key; the decision-log entry is keyed by it so a
 *                   retried command does not duplicate the audit trail.
 *   • AUDIT       — the append-only decision-log entry (the event spine).
 *
 * The kernel guarantees propose and commit share the SAME `plan()`: what an agent proposes is
 * EXACTLY what gets committed — there is no second, divergent code path for the "real" write.
 *
 * A command is defined by:
 *   name        — stable command id (also the decision-log `command` field).
 *   targetType  — the kind of thing it acts on (e.g. 'task'), for the audit entry.
 *   authorize   — (input, {actor, mode}) => true | string. A POLICY guard: return `true` to allow,
 *                 or a string to REFUSE with that reason (a soft, expected refusal — NOT an error).
 *                 Firestore rules remain the real authority on the write; this guard expresses
 *                 actor/mode policy the rules cannot (e.g. "an agent may propose but not commit").
 *   plan        — (input, {actor, mode}) => { targetId, summary, before, after, effect, ... }.
 *                 PURE: describes the intended change and performs NO writes. Used by BOTH modes.
 *                 Throw from here for invalid INPUT (a programmer error), not for policy refusal.
 *   apply       — (plan, input, {actor, mode}) => Promise. Performs the actual writes (commit only).
 *                 MUST be idempotent for a given idempotencyKey: the kernel re-runs apply on every
 *                 retry, and the decision_log de-dups the AUDIT but NOT the effect — a non-idempotent
 *                 apply (an addDoc / arrayUnion / counter increment) would double-apply on a retry.
 */

export const MODES = Object.freeze({ PROPOSE: 'propose', COMMIT: 'commit' });

// A dependency-free, unique-enough operation key for client-side use. The server-side command
// surface (a later increment) will mint a real UUID; the shape is opaque to callers either way.
let counter = 0;
const newKey = () =>
  `op_${Date.now().toString(36)}_${(counter++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const defineCommand = ({ name, targetType, authorize, plan, apply }) => {
  if (!name || typeof plan !== 'function' || typeof apply !== 'function') {
    throw new Error('defineCommand: name, plan and apply are required');
  }

  /**
   * Run the command.
   * @param {Object} input - command-specific input (e.g. { task, worker }).
   * @param {Object} ctx   - { actor (required), mode, idempotencyKey, reason, correlationId }.
   * @returns {Promise<Object>} a result envelope:
   *   refused → { ok:false, refused:true, reason, command, mode }
   *   propose → { ok:true, mode:'propose', command, proposal, targetId, idempotencyKey }
   *   commit  → { ok:true, mode:'commit',  command, effect, targetId, idempotencyKey, decisionId }
   * (targetId is the plan's targetId — for createTask, the newly-minted task id.)
   */
  const run = async (input, ctx = {}) => {
    const { actor } = ctx;
    if (!actor) throw new Error(`${name}: ctx.actor is required`);
    // Safe default: anything other than an explicit COMMIT is treated as a dry-run PROPOSE.
    const mode = ctx.mode === MODES.COMMIT ? MODES.COMMIT : MODES.PROPOSE;
    const idempotencyKey = ctx.idempotencyKey || newKey();

    // 0. Agent kill-switch — a single global brake (ADR 0015). When an admin engages it, EVERY
    //    agent command is refused (propose AND commit), before authorize/plan/apply run: a killed
    //    agent does nothing. Human and system actors are never gated by it. This is the circuit
    //    breaker that must exist before an agent's autonomy can ever be raised.
    if (isAgent(actor) && !areAgentsEnabled()) {
      return { ok: false, refused: true, reason: 'AGENTS_DISABLED', command: name, mode };
    }

    // 1. Authorization — a policy refusal is a normal result, not an exception.
    if (typeof authorize === 'function') {
      const verdict = authorize(input, { actor, mode });
      if (verdict !== true) {
        return {
          ok: false,
          refused: true,
          reason: typeof verdict === 'string' ? verdict : 'not authorized',
          command: name,
          mode,
        };
      }
    }

    // 2. Plan — pure, no writes. The single source of "what this command would do".
    const planned = await plan(input, { actor, mode });

    // 3. Propose stops here: return the plan, write nothing.
    if (mode === MODES.PROPOSE) {
      return { ok: true, mode, command: name, proposal: planned, targetId: planned.targetId, idempotencyKey };
    }

    // 4. Commit — apply the effect FIRST, then append the audit entry. (Ordering matters: if the
    //    audit were written first and apply then failed, the log would claim an effect that never
    //    happened.) The audit append must NEVER abort an already-applied command — appendDecision is
    //    best-effort and does not throw, but the kernel OWNS that guarantee, so it also wraps the call
    //    defensively: a future change that reintroduces a throw still cannot roll back a done effect.
    await apply(planned, input, { actor, mode });
    let decision = null;
    try {
      decision = await appendDecision({
        idempotencyKey,
        command: name,
        actor,
        targetType,
        targetId: planned.targetId,
        reason: ctx.reason || null,
        before: planned.before,
        after: planned.after,
        correlationId: ctx.correlationId,
        mode,
      });
    } catch (auditErr) {
      logError(auditErr, { source: 'command.appendDecision' });
    }

    return {
      ok: true,
      mode,
      command: name,
      effect: planned,
      targetId: planned.targetId,
      idempotencyKey,
      decisionId: decision?.id || null,
    };
  };

  return Object.assign(run, { commandName: name, targetType });
};
