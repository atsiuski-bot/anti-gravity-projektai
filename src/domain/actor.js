/**
 * Actor model — WHO performs a command.
 *
 * Every state-changing command in the AI-native command layer (see ADR 0015) is performed by an
 * explicit ACTOR, and that actor is stamped onto the decision-log entry the command appends.
 * Today the only actor that exists is a signed-in human; the model exists so that an AI agent —
 * or a scheduled, non-AI system job — can later act as ITSELF: attributable, scoped, revocable,
 * and NEVER by impersonating a human. This is the [ai-author] commit convention pushed down to
 * the data layer: an action carries its author.
 *
 * An actor is a small, frozen, serializable value. It is NOT a credential — Firestore rules
 * remain the real authority on the underlying write. The actor answers "who decided", which the
 * authorization predicate and the audit trail both need.
 */

export const ACTOR_TYPES = Object.freeze({
  HUMAN: 'human',
  AGENT: 'agent',
  SYSTEM: 'system',
});

/**
 * Build a HUMAN actor from the signed-in Firebase user (the AuthContext `user`).
 * @param {{uid:string, displayName?:string, email?:string, role?:string}} user
 */
export const humanActor = (user) => {
  if (!user || !user.uid) throw new Error('humanActor: a signed-in user (with uid) is required');
  return Object.freeze({
    type: ACTOR_TYPES.HUMAN,
    id: user.uid,
    name: user.displayName || user.email || 'User',
    role: user.role || null,
  });
};

/**
 * Build an AGENT actor — a non-human principal with its own identity and bounded authority.
 * @param {{id:string, kind?:string, name?:string}} opts
 *   id   — the agent's stable principal id (its own identity, not a human's uid)
 *   kind — what the agent is (e.g. 'assignment-planner'), used for policy + audit grouping
 */
export const agentActor = ({ id, kind, name } = {}) => {
  if (!id) throw new Error('agentActor: an agent principal id is required');
  return Object.freeze({
    type: ACTOR_TYPES.AGENT,
    id,
    kind: kind || 'agent',
    name: name || kind || 'AI agent',
  });
};

/**
 * Build a SYSTEM actor — an automated, NON-AI job (scheduled functions, integrity scans).
 * @param {string} source - the job name, e.g. 'dailyIntegrityScan'
 */
export const systemActor = (source) =>
  Object.freeze({
    type: ACTOR_TYPES.SYSTEM,
    id: source || 'system',
    name: source || 'System',
  });

export const isHuman = (actor) => actor?.type === ACTOR_TYPES.HUMAN;
export const isAgent = (actor) => actor?.type === ACTOR_TYPES.AGENT;
export const isSystem = (actor) => actor?.type === ACTOR_TYPES.SYSTEM;

/**
 * Normalize any actor into the compact, serializable stamp written onto the decision-log entry.
 * The flat `actorType`/`actorId`/`actorName` shape is what the firestore.rules provenance check
 * binds against (a human must write the log as themselves: actorId == auth.uid).
 */
export const actorStamp = (actor) => {
  if (!actor || !actor.type || !actor.id) throw new Error('actorStamp: invalid actor');
  const stamp = { actorType: actor.type, actorId: actor.id, actorName: actor.name || null };
  if (actor.type === ACTOR_TYPES.AGENT && actor.kind) stamp.actorKind = actor.kind;
  return stamp;
};
