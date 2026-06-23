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
export {
  areAgentsEnabled,
  setAgentsEnabled,
  AGENT_CONTROL_COLLECTION,
  AGENT_CONTROL_DOC_ID,
} from './agentControl';

// Commands
export { assignTask } from './commands/assignTask';
export { createTask } from './commands/createTask';
export { completeTask } from './commands/completeTask';
export { reopenTask } from './commands/reopenTask';
export { approveTask } from './commands/approveTask';
export { reprioritizeTask } from './commands/reprioritizeTask';
export { rescheduleTask } from './commands/rescheduleTask';
export { deleteTask } from './commands/deleteTask';
