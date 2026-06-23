// Self-directed predicate lives in src/utils/selfDirectedTask.js; the canonical, exhaustive unit
// test is co-located there (selfDirectedTask.test.js). This file deliberately holds no duplicate
// assertions — it remains only as a pointer so a reader who greps TaskTable for "selfDirected"
// finds the test, and is kept valid (one trivial smoke check) so vitest does not flag an
// empty test file.
import { describe, it, expect } from 'vitest';
import { isSelfDirectedTask } from '../utils/selfDirectedTask';

describe('TaskTable self-directed affordance (predicate smoke check)', () => {
    it('flags a completed self-created+self-managed task as self-directed', () => {
        expect(
            isSelfDirectedTask({ assignedUserId: 'u1', createdBy: 'u1', status: 'completed' }),
        ).toBe(true);
    });
});
