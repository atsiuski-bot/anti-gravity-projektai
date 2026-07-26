/**
 * sessionNesting — the ONE answer to "may this session start on top of that one?".
 *
 * WHY THIS EXISTS
 * ---------------
 * The question used to be answered in three independent places that disagreed:
 *   • each timer button's own `isDisabled` expression (three hand-written type exclusions);
 *   • the canonical planner's whitelist of interruptable base runs (timerTransitionPlan);
 *   • the legacy writer, which imposed no rule at all (sessionActions).
 * The disagreement WAS the bug: a button offered a switch the engine then rejected with an error
 * blaming another device. Three copies of a rule are three rules. This module is the rule.
 *
 * THE MODEL: a stack, not parallel timers
 * ---------------------------------------
 * Starting a session on top of another does NOT run two timers at once. The interrupted session is
 * banked — its elapsed minutes are written as a complete ledger record keyed to its own start — and
 * nested underneath as a bookmark; when the top session ends it resumes as a FRESH run starting at
 * that moment. So exactly one session is ever accruing, and the day stays what every report, pay
 * calculation and gap detector assumes it is: a sum of NON-OVERLAPPING intervals. Genuinely
 * concurrent timers would credit one real hour twice; that is not a nesting depth this module can
 * ever return true for.
 *
 * WHY THE DEPTH IS CAPPED
 * -----------------------
 * Not for implementation cost — the structure recurses fine. Every layer is a session somebody must
 * eventually come back and end, and a stack deeper than the worker can hold in their head is
 * invisible state: a forgotten layer is unlogged time. Two secondary sessions (the running one plus
 * one parked underneath), over an optional paused task at the bottom, is the depth a person can
 * still narrate — "I'm on a call, my break is waiting, my task is waiting".
 *
 * Shape contract: every function here takes a SESSION NODE — anything with `.type` and an optional
 * `.pausedSession` pointing at the next node down. Both engines' state satisfies it unchanged (the
 * canonical `run` and the legacy `users/{uid}.activeSession`), which is what lets one rule govern
 * both.
 */

export const SECONDARY_SESSION_TYPES = ['break', 'call', 'quickWork'];

/**
 * How many SECONDARY sessions may be alive in one stack at once. A paused task at the bottom does
 * not count against it: a task is closed and credited the moment it is interrupted, so it is a
 * return address rather than a session waiting to be finished.
 */
export const MAX_SECONDARY_STACK_DEPTH = 2;

export const isSecondarySessionType = (type) => SECONDARY_SESSION_TYPES.includes(type);

/** Every node of the stack, top first, INCLUDING the running one. */
export function sessionStack(session) {
    const stack = [];
    let node = session;
    // Defensive bound: a corrupt self-referential chain must not hang the render loop that calls
    // this on every user-doc snapshot.
    while (node?.type && stack.length < 16) {
        stack.push(node);
        node = node.pausedSession || null;
    }
    return stack;
}

/** The nodes PARKED underneath the running one, top first — what the worker must come back to. */
export function pausedSessionStack(session) {
    return sessionStack(session).slice(1);
}

/** How many secondary sessions the stack currently holds, counting the running one. */
export function secondaryStackDepth(session) {
    return sessionStack(session).filter((node) => isSecondarySessionType(node.type)).length;
}

/** The task at the BOTTOM of the stack, if any — the work the whole stack eventually returns to. */
export function pausedTaskInStack(session) {
    return sessionStack(session).find((node) => node.type === 'task') || null;
}

/**
 * May `nextType` be started while `session` is running?
 *
 * @param {Object|null} session  - the running session node, or null/undefined when idle.
 * @param {string} nextType      - 'break' | 'call' | 'quickWork'.
 * @returns {{allowed: boolean, code: string}} code is 'ok' | 'same-type' | 'stack-full' |
 *          'unsupported'. The code (not a message) is what callers branch on, so the Lithuanian
 *          copy lives in the UI layer and the rule stays language-free.
 */
export function evaluateSecondaryStart(session, nextType) {
    if (!isSecondarySessionType(nextType)) return { allowed: false, code: 'unsupported' };

    const activeType = session?.type;
    if (!activeType) return { allowed: true, code: 'ok' };

    // Same type is a STOP, never a nest. Two undescribed quick works stacked would fire their finish
    // prompts out of order, and nothing in the model distinguishes them for the worker.
    if (activeType === nextType) return { allowed: false, code: 'same-type' };

    // A task is always interruptable: it is closed and credited on the way down.
    if (activeType === 'task') return { allowed: true, code: 'ok' };

    if (!isSecondarySessionType(activeType)) return { allowed: false, code: 'unsupported' };

    if (secondaryStackDepth(session) >= MAX_SECONDARY_STACK_DEPTH) {
        return { allowed: false, code: 'stack-full' };
    }

    return { allowed: true, code: 'ok' };
}
