import { describe, it, expect } from 'vitest';
import { canApproveTask, canConfirmTask, canRevertTask } from './taskActionVisibility';

// These predicates are the single source of truth for WHICH manager sign-off actions a task
// offers, shared by the mobile card, the desktop table and the detail modal. The contract:
// a manager (effective role OR surface role is manager/admin/seniorManager) gated by task state.

describe('taskActionVisibility', () => {
    describe('canApproveTask — only an unapproved task, manager only', () => {
        it('true for a manager on an unapproved task', () => {
            expect(canApproveTask({ task: { status: 'unapproved' }, role: 'manager' })).toBe(true);
        });
        it('manager identity may come from userRole alone (no surface role)', () => {
            expect(canApproveTask({ task: { status: 'unapproved' }, userRole: 'admin' })).toBe(true);
        });
        it('seniorManager counts as a manager', () => {
            expect(canApproveTask({ task: { status: 'unapproved' }, role: 'seniorManager' })).toBe(true);
        });
        it('false for a worker', () => {
            expect(canApproveTask({ task: { status: 'unapproved' }, role: 'worker', userRole: 'worker' })).toBe(false);
        });
        it('false once the task is approved/other status', () => {
            expect(canApproveTask({ task: { status: 'approved' }, role: 'manager' })).toBe(false);
            expect(canApproveTask({ task: { status: 'completed' }, role: 'manager' })).toBe(false);
        });
        it('false when status is absent (defaults to pending)', () => {
            expect(canApproveTask({ task: {}, role: 'manager' })).toBe(false);
        });
    });

    describe('canConfirmTask — only finished (completed) work, manager only', () => {
        it('true for a manager on a completed task', () => {
            expect(canConfirmTask({ task: { status: 'completed' }, role: 'manager' })).toBe(true);
        });
        it('false for a worker on a completed task', () => {
            expect(canConfirmTask({ task: { status: 'completed' }, role: 'worker', userRole: 'worker' })).toBe(false);
        });
        it('false once confirmed, or while pending', () => {
            expect(canConfirmTask({ task: { status: 'confirmed' }, role: 'manager' })).toBe(false);
            expect(canConfirmTask({ task: { status: 'pending' }, role: 'manager' })).toBe(false);
        });
    });

    describe('canRevertTask — any finished or deleted task, manager only', () => {
        it('true for a manager on a completed task', () => {
            expect(canRevertTask({ task: { completed: true }, role: 'manager' })).toBe(true);
        });
        it('true for a manager on a deleted task', () => {
            expect(canRevertTask({ task: { isDeleted: true }, role: 'manager' })).toBe(true);
        });
        it('false for a manager on an active, not-finished task', () => {
            expect(canRevertTask({ task: { completed: false, isDeleted: false }, role: 'manager' })).toBe(false);
        });
        it('false for a worker even on a completed task', () => {
            expect(canRevertTask({ task: { completed: true }, role: 'worker', userRole: 'worker' })).toBe(false);
        });
    });
});
