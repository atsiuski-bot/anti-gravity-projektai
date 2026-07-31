import { describe, it, expect } from 'vitest';
import { canApproveTask, canConfirmTask, canRevertTask, canSignOffTask, canFinishForAssignee, buildReviewActions } from './taskActionVisibility';

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

    describe('buildReviewActions — the manager review/acceptance action set', () => {
        const noop = () => {};

        it('awaiting acceptance (completed): manager gets Priimti + Grąžinti', () => {
            const acts = buildReviewActions({
                task: { status: 'completed' }, isManager: true, canRestore: true,
                onToggleConfirm: noop, onRestore: noop,
            });
            expect(acts.map(a => a.key)).toEqual(['confirm', 'restore']);
            expect(acts.find(a => a.key === 'confirm').label).toBe('Priimti');
            expect(acts.find(a => a.key === 'restore').label).toBe('Grąžinti');
        });

        it('awaiting acceptance: restore is withheld when not permitted', () => {
            const acts = buildReviewActions({
                task: { status: 'completed' }, isManager: true, canRestore: false,
                onToggleConfirm: noop, onRestore: noop,
            });
            expect(acts.map(a => a.key)).toEqual(['confirm']);
        });

        it('accepted (confirmed): the only action is Atnaujinti — never Grąžinti', () => {
            const acts = buildReviewActions({
                task: { status: 'confirmed' }, isManager: true, canRestore: true,
                onToggleConfirm: noop, onRestore: noop,
            });
            expect(acts.map(a => a.key)).toEqual(['reopen']);
            expect(acts[0].label).toBe('Atnaujinti');
        });

        it('a non-manager sees no accept/re-open action', () => {
            expect(buildReviewActions({ task: { status: 'confirmed' }, isManager: false, canRestore: false, onToggleConfirm: noop, onRestore: noop })).toEqual([]);
            // ...but a permitted non-manager may still restore an awaiting task.
            const acts = buildReviewActions({ task: { status: 'completed' }, isManager: false, canRestore: true, onToggleConfirm: noop, onRestore: noop });
            expect(acts.map(a => a.key)).toEqual(['restore']);
        });

        it('an archived awaiting task disables (but still shows) the accept action', () => {
            const acts = buildReviewActions({
                task: { status: 'completed', archivedAt: '2026-01-01T00:00:00Z' }, isManager: true, canRestore: false,
                onToggleConfirm: noop, onRestore: noop,
            });
            expect(acts[0].key).toBe('confirm');
            expect(acts[0].disabled).toBe(true);
        });
    });

    // The koordinatorius's closing door for a Meistras's still-open task. The timer's own "Užbaigti"
    // is assignment-only, so this predicate decides whether the task can leave the active list
    // without the worker — and it must never offer a button the rules would deny.
    describe('canFinishForAssignee', () => {
        const mgr = { uid: 'mgr' };
        const scoped = { role: 'manager', scopedManager: true };
        const open = { id: 't1', assignedUserId: 'w1', status: 'approved' };

        it('offers the door to the task overseer on someone else\'s open task', () => {
            expect(canFinishForAssignee({
                task: { ...open, teamManagerIds: ['mgr'] }, currentUser: mgr, userData: scoped, userRole: 'manager',
            })).toBe(true);
            // ...and to the named vadovas even outside the team closure.
            expect(canFinishForAssignee({
                task: { ...open, managerId: 'mgr' }, currentUser: mgr, userData: scoped, userRole: 'manager',
            })).toBe(true);
        });

        it('is withheld from a manager who does not oversee THIS task (the rules would deny it)', () => {
            expect(canFinishForAssignee({
                task: open, currentUser: mgr, userData: scoped, userRole: 'manager',
            })).toBe(false);
        });

        it('is withheld from a worker, and from the assignee themselves', () => {
            expect(canFinishForAssignee({
                task: { ...open, teamManagerIds: ['mgr'] }, currentUser: mgr, userData: scoped, userRole: 'worker',
            })).toBe(false);
            // The assignee has their own timer door; this one is only for closing SOMEONE ELSE's work.
            expect(canFinishForAssignee({
                task: { ...open, assignedUserId: 'mgr', teamManagerIds: ['mgr'] }, currentUser: mgr,
                userData: { role: 'admin' }, userRole: 'manager',
            })).toBe(false);
        });

        it('is withheld once there is nothing left to close, or the pending decision is approval', () => {
            const admin = { currentUser: mgr, userData: { role: 'admin' }, userRole: 'admin' };
            expect(canFinishForAssignee({ task: { ...open, completed: true }, ...admin })).toBe(false);
            expect(canFinishForAssignee({ task: { ...open, isDeleted: true }, ...admin })).toBe(false);
            expect(canFinishForAssignee({ task: { ...open, isArchived: true }, ...admin })).toBe(false);
            expect(canFinishForAssignee({ task: { ...open, status: 'unapproved' }, ...admin })).toBe(false);
        });
    });

    describe('canSignOffTask', () => {
        it('recognises every branch the rules grant, and nothing else', () => {
            const me = { uid: 'm' };
            const scoped = { role: 'manager', scopedManager: true };
            expect(canSignOffTask({ task: { managerId: 'm' }, currentUser: me, userData: scoped })).toBe(true);
            expect(canSignOffTask({ task: { taskAuditor: 'm' }, currentUser: me, userData: scoped })).toBe(true);
            expect(canSignOffTask({ task: { teamManagerIds: ['m'] }, currentUser: me, userData: scoped })).toBe(true);
            expect(canSignOffTask({ task: {}, currentUser: me, userData: { role: 'admin' } })).toBe(true);
            expect(canSignOffTask({ task: {}, currentUser: me, userData: scoped })).toBe(false);
        });
    });
});
