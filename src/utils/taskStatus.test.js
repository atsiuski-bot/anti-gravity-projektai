import { describe, it, expect } from 'vitest';
import { resolveInitialTaskStatus } from './taskStatus';

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
