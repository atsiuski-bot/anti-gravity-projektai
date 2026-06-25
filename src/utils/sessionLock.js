/**
 * Per-user serialization lock for the session / `activeSession` write path.
 *
 * THE PROBLEM IT SOLVES
 * `users/{uid}.activeSession` is ONE shared mutable field that holds the implicit paused-session
 * stack (a secondary session keeps the one it interrupted in `pausedSession`). Several independent,
 * NON-transactional read-modify-write callers mutate it — `startSession`, `endSession`, `startTask`,
 * `resumeTask` — with no lock between the read and the write. Two mutations issued inside ONE
 * synchronous tick (a double-tap on a janky phone, or two timer buttons fired together) both read
 * the SAME pre-write snapshot, so the second silently overwrites the first: a session the worker
 * started vanishes with no error and no log. This was reproduced live (see the session-engine race
 * audit). Normal-speed taps are safe — a re-render lands between them — so the bug is specifically
 * the same-tick / sub-round-trip window.
 *
 * THE FIX
 * Generalize the per-TASK `pauseInFlight` guard in taskActions.js into a per-USER mutex: every
 * entry point chains its critical section onto the previous one for that user, so exactly ONE
 * writer runs at a time and each read therefore sees the prior write's result. It is deliberately
 * lighter than wrapping each write in `runTransaction` (a transaction cannot span two separate user
 * actions and would still need this same serialization to avoid contention churn) while giving the
 * same protection against the lost-update race.
 *
 * INVARIANTS
 * - Different users never block each other — the queue is keyed by `userId`.
 * - A rejection in one critical section does NOT wedge the next one for that user; the chain
 *   advances on failure exactly as on success (so a failed `startSession` cannot freeze the queue).
 * - The caller still receives the real result OR rejection of its own `fn` (the swallow applies
 *   only to the internal tail that the next waiter chains onto).
 * - DEADLOCK-SAFETY: a locked function must never `await` another acquisition of the SAME user's
 *   lock inside its own critical section. The four wrapped entry points hold to this — the only
 *   lock-within-lock edge is `endSession` → `resumeTask`, which is fire-and-forget (it runs after
 *   `endSession` has resolved and released), so it queues rather than deadlocks. `pauseOtherTasks`
 *   / `pauseTask` are intentionally NOT wrapped (the latter is awaited inside `startSession`'s
 *   critical section and keeps its own per-task `pauseInFlight` guard).
 */

// userId -> a promise that settles when that user's currently-queued critical sections are done.
// The stored promise never rejects (see below), so chaining onto it can never throw.
const chains = new Map();

/**
 * Run `fn` as a critical section serialized against every other `withUserLock` call for the same
 * `userId`. Returns whatever `fn` returns (or rejects with whatever `fn` throws).
 *
 * @param {string} userId
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
export const withUserLock = (userId, fn) => {
    // No user to serialize on — run directly. Mirrors the callers' own missing-user no-ops; also
    // keeps the Map from accumulating an `undefined` key.
    if (!userId) return fn();

    const prev = chains.get(userId) || Promise.resolve();
    // Chain onto the prior critical section whether it RESOLVED or REJECTED (same handler for both),
    // so one failed writer cannot stall this user's queue forever.
    const run = prev.then(fn, fn);
    // The promise we STORE as the tail must never reject — a rejected stored promise would surface
    // as an unhandled rejection the moment the next waiter chains onto it. Swallow on this copy
    // only; `run` still carries the genuine outcome back to the caller.
    const tail = run.then(() => {}, () => {});
    chains.set(userId, tail);
    // Drop the Map entry once this tail is the last one queued, so the map doesn't grow per user
    // unboundedly. If a newer op chained on in the meantime, the Map holds that newer tail and we
    // leave it in place.
    tail.then(() => {
        if (chains.get(userId) === tail) chains.delete(userId);
    });
    return run;
};
