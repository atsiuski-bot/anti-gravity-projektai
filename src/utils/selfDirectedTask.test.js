import { describe, it, expect } from 'vitest';
import { isSelfDirectedTask } from './selfDirectedTask';

describe('isSelfDirectedTask', () => {
    const SELF = 'user-self';
    const MANAGER = 'user-manager';

    it('is true when the assignee created the task and there is no manager', () => {
        expect(isSelfDirectedTask({ assignedUserId: SELF, createdBy: SELF })).toBe(true);
    });

    it('is true when the assignee created the task and is also the listed manager', () => {
        expect(
            isSelfDirectedTask({ assignedUserId: SELF, createdBy: SELF, managerId: SELF }),
        ).toBe(true);
    });

    it('is true when managerId is an empty string (treated as no manager)', () => {
        expect(
            isSelfDirectedTask({ assignedUserId: SELF, createdBy: SELF, managerId: '' }),
        ).toBe(true);
    });

    it('is false when a distinct manager oversees the task', () => {
        expect(
            isSelfDirectedTask({ assignedUserId: SELF, createdBy: SELF, managerId: MANAGER }),
        ).toBe(false);
    });

    it('is false when the creator differs from the assignee (a manager assigned it)', () => {
        expect(
            isSelfDirectedTask({ assignedUserId: SELF, createdBy: MANAGER }),
        ).toBe(false);
    });

    it('is false when the creator is unknown (legacy doc without createdBy)', () => {
        expect(isSelfDirectedTask({ assignedUserId: SELF })).toBe(false);
    });

    it('is false when there is no assignee', () => {
        expect(isSelfDirectedTask({ createdBy: SELF })).toBe(false);
        expect(isSelfDirectedTask({ assignedUserId: '', createdBy: '' })).toBe(false);
    });

    it('is false for nullish input', () => {
        expect(isSelfDirectedTask(null)).toBe(false);
        expect(isSelfDirectedTask(undefined)).toBe(false);
    });
});
