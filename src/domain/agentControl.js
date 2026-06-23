/**
 * Agent kill-switch (ADR 0015) — a single global brake the command kernel consults to refuse EVERY
 * agent command the instant it is engaged. The circuit breaker the EU-AI-Act human-oversight pathway
 * requires, and the precondition for ever raising an agent's autonomy: before any agent can commit
 * (even a reversible action later), there must be one switch that stops it immediately.
 *
 * This module holds ONLY the in-memory cached state + pure getters/setters — deliberately NO
 * Firestore import — so the kernel (and its unit tests) can consult it synchronously without pulling
 * the Firebase module graph. The LIVE value is pushed in from a Firestore listener wired in
 * AuthContext (subscribing to `system_config/agents`), and an admin flips it from the Audit
 * dashboard. State changes are observable in the decision_log only once an agent actually runs
 * server-side; here the switch is the inert, ready seam.
 *
 * DEFAULT: ENABLED — the brake is OFF until explicitly engaged. On the CLIENT a missing/unreadable
 * flag is treated as enabled (agents don't commit client-side yet, so this is future-proofing the
 * seam). The future SERVER agent surface, where real agent commits will run, MUST instead fail
 * CLOSED: a brake it cannot read is assumed ENGAGED. Keep that asymmetry when the server surface lands.
 *
 * LATENCY (TOCTOU): the kernel reads this cache SYNCHRONOUSLY, but the listener updates it
 * ASYNCHRONOUSLY — so after an admin engages the brake there is a propagation window (network +
 * snapshot delivery) during which a client read still sees the old value, and at session start the
 * cache holds the ENABLED default until the first snapshot lands. This is acceptable ONLY because no
 * client path commits as an agent today (a propose writes nothing). The moment an agent can COMMIT,
 * the authoritative check must move server-side, where the kill-switch is read transactionally with
 * the write and defaults CLOSED — never trust this client cache for a real agent commit.
 */

let agentsEnabled = true;

/** Are AI agent commands currently allowed? Consulted synchronously by the command kernel. */
export const areAgentsEnabled = () => agentsEnabled;

/** Push the live kill-switch state in (from the Firestore listener, or a test). Coerces to boolean. */
export const setAgentsEnabled = (value) => {
  agentsEnabled = value !== false;
};

// The Firestore location of the kill-switch flag: system_config/agents = { enabled: boolean, ... }.
export const AGENT_CONTROL_COLLECTION = 'system_config';
export const AGENT_CONTROL_DOC_ID = 'agents';
