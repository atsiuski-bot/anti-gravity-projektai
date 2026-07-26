import { describe, expect, it } from 'vitest';
import {
    MAX_SECONDARY_STACK_DEPTH,
    evaluateSecondaryStart,
    pausedSessionStack,
    pausedTaskInStack,
    secondaryStackDepth,
    sessionStack,
} from './sessionNesting';

const task = (pausedSession = null) => ({ type: 'task', taskId: 'task-a', pausedSession });
const secondary = (type, pausedSession = null) => ({ type, pausedSession });

describe('the nesting rule', () => {
    it('lets any secondary start from idle', () => {
        for (const type of ['break', 'call', 'quickWork']) {
            expect(evaluateSecondaryStart(null, type)).toEqual({ allowed: true, code: 'ok' });
        }
    });

    it('lets any secondary interrupt a running task', () => {
        for (const type of ['break', 'call', 'quickWork']) {
            expect(evaluateSecondaryStart(task(), type).allowed).toBe(true);
        }
    });

    // The regression this module exists for: the three buttons each hand-wrote their own exclusions,
    // so a call blocked everything while a quick work blocked only some things — and the canonical
    // engine disagreed with both.
    it.each([
        ['break', 'call'],
        ['break', 'quickWork'],
        ['call', 'break'],
        ['call', 'quickWork'],
        ['quickWork', 'break'],
        ['quickWork', 'call'],
    ])('allows %s → %s in both directions', (running, next) => {
        expect(evaluateSecondaryStart(secondary(running), next).allowed).toBe(true);
    });

    it('refuses a session of the SAME type — that is a stop, not a nest', () => {
        for (const type of ['break', 'call', 'quickWork']) {
            expect(evaluateSecondaryStart(secondary(type), type))
                .toEqual({ allowed: false, code: 'same-type' });
        }
    });

    it('refuses a third secondary layer', () => {
        const twoDeep = secondary('call', secondary('break', task()));
        expect(secondaryStackDepth(twoDeep)).toBe(MAX_SECONDARY_STACK_DEPTH);
        expect(evaluateSecondaryStart(twoDeep, 'quickWork'))
            .toEqual({ allowed: false, code: 'stack-full' });
    });

    it('does not count a parked TASK against the depth', () => {
        // A task is closed and credited the moment it is interrupted, so it is a return address, not
        // a session someone still has to finish — one secondary over it must still admit a second.
        const oneDeepOverTask = secondary('break', task());
        expect(secondaryStackDepth(oneDeepOverTask)).toBe(1);
        expect(evaluateSecondaryStart(oneDeepOverTask, 'call').allowed).toBe(true);
    });

    it('refuses a type that is not a secondary session', () => {
        expect(evaluateSecondaryStart(null, 'task')).toEqual({ allowed: false, code: 'unsupported' });
    });
});

describe('reading the stack', () => {
    const stack = secondary('call', secondary('break', task()));

    it('walks the whole chain, running session first', () => {
        expect(sessionStack(stack).map((n) => n.type)).toEqual(['call', 'break', 'task']);
    });

    it('reports what is PARKED underneath, excluding the running session', () => {
        expect(pausedSessionStack(stack).map((n) => n.type)).toEqual(['break', 'task']);
        expect(pausedSessionStack(null)).toEqual([]);
    });

    it('finds the task at the bottom however deep the stack is', () => {
        expect(pausedTaskInStack(stack)?.taskId).toBe('task-a');
        expect(pausedTaskInStack(secondary('call'))).toBeNull();
    });

    it('survives a corrupt self-referential chain instead of hanging the render', () => {
        const loop = { type: 'call' };
        loop.pausedSession = loop;
        expect(sessionStack(loop).length).toBeLessThanOrEqual(16);
    });
});
