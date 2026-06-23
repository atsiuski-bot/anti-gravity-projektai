/**
 * AI-native command layer (ADR 0015) — public surface.
 *
 * The one place UI and (later) agents import from to issue a state-changing command. Everything
 * here is transport-agnostic: the same command contract that runs client-side today can be exposed
 * via a callable Cloud Function later without changing a caller.
 */

export {
  ACTOR_TYPES,
  humanActor,
  agentActor,
  systemActor,
  isHuman,
  isAgent,
  isSystem,
  actorStamp,
} from './actor';

export { MODES, defineCommand } from './command';
export { DECISION_LOG_COLLECTION, appendDecision } from './decisionLog';

// Commands
export { assignTask } from './commands/assignTask';
export { createTask } from './commands/createTask';
