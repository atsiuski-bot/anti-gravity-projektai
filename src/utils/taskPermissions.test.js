import { describe, it, expect } from 'vitest';
import { canWorkerEditTask, canEditTask } from './taskPermissions';

const WORKER = { uid: 'w1' };
const OTHER = { uid: 'w2' };

describe('canWorkerEditTask', () => {
    it('allows the creator while their task is still unapproved', () => {
        expect(canWorkerEditTask({ createdBy: 'w1', status: 'unapproved' }, 'w1')).toBe(true);
    });

    it('locks once a manager has approved (any non-unapproved status)', () => {
        for (const status of ['pending', 'approved', 'in-progress', 'completed', 'confirmed']) {
            expect(canWorkerEditTask({ createdBy: 'w1', status }, 'w1')).toBe(false);
        }
    });

    it('never lets a worker edit a task they did not create', () => {
        expect(canWorkerEditTask({ createdBy: 'mgr', status: 'unapproved' }, 'w1')).toBe(false);
    });

    it('rejects deleted or completed tasks even when unapproved', () => {
        expect(canWorkerEditTask({ createdBy: 'w1', status: 'unapproved', isDeleted: true }, 'w1')).toBe(false);
        expect(canWorkerEditTask({ createdBy: 'w1', status: 'unapproved', completed: true }, 'w1')).toBe(false);
    });
});

describe('canEditTask', () => {
    const ownUnapproved = { createdBy: 'w1', status: 'unapproved' };
    const managerCreated = { createdBy: 'mgr', status: 'pending' };

    it('grants managers/admins edit in every state', () => {
        for (const role of ['manager', 'admin', 'seniorManager']) {
            expect(canEditTask({ task: managerCreated, currentUser: OTHER, role })).toBe(true);
        }
        // userRole alone (surface role 'worker') also grants it
        expect(canEditTask({ task: managerCreated, currentUser: OTHER, role: 'worker', userRole: 'admin' })).toBe(true);
    });

    it('grants a worker edit only on their own unapproved task', () => {
        expect(canEditTask({ task: ownUnapproved, currentUser: WORKER, role: 'worker' })).toBe(true);
        expect(canEditTask({ task: managerCreated, currentUser: WORKER, role: 'worker' })).toBe(false);
        expect(canEditTask({ task: { createdBy: 'w1', status: 'approved' }, currentUser: WORKER, role: 'worker' })).toBe(false);
    });

    it('returns false without a task or user', () => {
        expect(canEditTask({ task: null, currentUser: WORKER, role: 'worker' })).toBe(false);
        expect(canEditTask({ task: ownUnapproved, currentUser: null, role: 'worker' })).toBe(false);
        expect(canEditTask()).toBe(false);
    });
});
