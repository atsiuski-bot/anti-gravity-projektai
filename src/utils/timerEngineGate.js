// Who gets the canonical (revisioned) timer engine, and on which client build.
//
// WHY THIS EXISTS
// ---------------
// The original gate was one boolean in system_config/timerEngine: `enabled: true` switched EVERY
// signed-in worker on EVERY device within seconds of the write. That is unusable as a rollout
// control for a timekeeping app, for two reasons that no amount of bug-fixing removes:
//
//   1. It cannot target a person. There is no way to try the engine on one worker for a week
//      before betting the whole crew's pay on it.
//   2. It cannot target a BUILD. A worker's installed PWA can run a bundle from last week
//      (registerType 'prompt' + an hourly update check), and that bundle knows nothing about
//      active_sessions. Flipping the flag hands the canonical state model to code that cannot
//      maintain it.
//
// THE KEY CONSTRAINT: already-deployed code cannot be taught to respect a new field. An old bundle
// reads `enabled` and switches, whatever else the document says. So the fix is not to add
// conditions next to `enabled` — it is to STOP USING `enabled` and gate on a field only new
// bundles read.
//
//   *** system_config/timerEngine.enabled MUST NEVER BE SET TO true AGAIN. ***
//
// It is now a legacy field that ONLY pre-rollout bundles honour; setting it would switch exactly
// the stale clients this gate exists to protect. New bundles ignore it entirely and read `rollout`.
//
// Document shape this module expects:
//   system_config/timerEngine = {
//     enabled: false,                 // legacy kill-switch — leave false/absent forever
//     rollout: {
//       enabled: true,                // the real switch, invisible to old bundles
//       minClientContract: 3,         // bundles below this stay on legacy (see below)
//       allowUserIds: ['uid-a'],      // when non-empty, ONLY these workers get the engine
//     },
//   }

// The canonical-engine behaviour contract THIS bundle implements. Bump it whenever the client's
// canonical state handling changes in a way a rollout must be able to require — then raise
// `rollout.minClientContract` to match, and every older bundle falls back to legacy on its own.
//
// Deliberately NOT the same number as TIMER_ENGINE_VERSION (timerTransitionPlan.js): that one is the
// on-disk DATA format stamped onto rows and pinned by firestore.rules (engineVersion == 2), so it
// cannot move for rollout reasons. This one is about client capability.
//
// 3 = the first build with a targeted rollout gate; earlier bundles have no contract at all and are
// treated as 0 by the comparison below, so any minClientContract >= 1 excludes them.
export const TIMER_ENGINE_CLIENT_CONTRACT = 3;

/**
 * Decide whether the canonical timer engine applies to this worker on this build.
 *
 * Pure and exported so the rollout policy is unit-testable without React or Firestore — the same
 * discipline decideOrphanTaskRecovery / isBeatableRun follow. Fails CLOSED at every step: a missing
 * document, a missing rollout block, an unparseable field or an allowlist that does not name this
 * worker all resolve to the legacy path, which is today's proven production behaviour.
 *
 * @param {Object|null} config - the raw system_config/timerEngine data, or null when absent.
 * @param {string|null} uid    - the signed-in worker's uid.
 * @param {number} [contract]  - this bundle's contract level (injectable for tests).
 * @returns {boolean} true when this worker, on this build, should use the canonical engine.
 */
export function isTimerEngineEnabledFor(config, uid, contract = TIMER_ENGINE_CLIENT_CONTRACT) {
    const rollout = config?.rollout;
    if (!rollout || rollout.enabled !== true) return false;

    // Build floor. A bundle older than the rollout requires must not touch canonical state, even
    // for an allowlisted worker — that is the whole point of the field.
    const min = Number(rollout.minClientContract);
    if (Number.isFinite(min) && contract < min) return false;

    // Allowlist. Absent or empty means "everyone who passes the build floor" (the end state of a
    // rollout); a non-empty list is the pilot phase and admits nobody else.
    const allow = rollout.allowUserIds;
    if (Array.isArray(allow) && allow.length > 0) return !!uid && allow.includes(uid);

    return true;
}
