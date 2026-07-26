import { describe, it, expect } from 'vitest';
import { resolveInitialTaskStatus, isTimeExtensionEdit } from './taskStatus';

describe('resolveInitialTaskStatus — status a newly created task carries', () => {
    it("a non-manager's task must clear the approval gate -> 'unapproved'", () => {
        expect(resolveInitialTaskStatus({ isManagerOrAdmin: false, isSelfAssigned: false })).toBe('unapproved');
        // role wins over self-assignment: a worker self-assigning still needs approval.
        expect(resolveInitialTaskStatus({ isManagerOrAdmin: false, isSelfAssigned: true })).toBe('unapproved');
    });

    it("a manager creating for someone else -> 'pending' (approval gate moot)", () => {
        expect(resolveInitialTaskStatus({ isManagerOrAdmin: true, isSelfAssigned: false })).toBe('pending');
    });

    it("a manager self-assigning -> 'approved' (no self-approval needed)", () => {
        expect(resolveInitialTaskStatus({ isManagerOrAdmin: true, isSelfAssigned: true })).toBe('approved');
    });

    it('defaults defensively to unapproved when context is missing', () => {
        expect(resolveInitialTaskStatus()).toBe('unapproved');
        expect(resolveInitialTaskStatus({})).toBe('unapproved');
    });
});

describe('isTimeExtensionEdit — which story a manager\'s estimate edit tells the worker', () => {
    const overLimit = { completed: false, timeLimitReached: true, estimatedTime: '30min' };

    it('an estimate raised on a running over-limit task IS a time extension', () => {
        expect(isTimeExtensionEdit(overLimit, '45min')).toBe(true);
    });

    // The regression this guard exists for: the limit latch deliberately OUTLIVES the finish
    // (planTaskEnd leaves it set so the on_estimate badge trigger can read it on the completion
    // edge). Without the completed check, correcting a FINISHED task's estimate told the worker
    // "Numatomas laikas pratęstas" — a promise of more time to work on work that is already done.
    it('the same edit on a COMPLETED task is not — there is no work left to extend', () => {
        expect(isTimeExtensionEdit({ ...overLimit, completed: true }, '45min')).toBe(false);
    });

    it('no extension when the limit was never hit, or when the estimate did not move', () => {
        expect(isTimeExtensionEdit({ ...overLimit, timeLimitReached: false }, '45min')).toBe(false);
        expect(isTimeExtensionEdit(overLimit, '30min')).toBe(false);
    });

    it('defaults defensively to "not an extension" on a missing task', () => {
        expect(isTimeExtensionEdit(null, '45min')).toBe(false);
        expect(isTimeExtensionEdit(undefined, '45min')).toBe(false);
        expect(isTimeExtensionEdit({}, '45min')).toBe(false);
    });
});
