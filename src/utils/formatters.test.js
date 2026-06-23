import { describe, it, expect } from 'vitest';
import { formatDisplayName, resolveCompletionStatus } from './formatters';

// Regression coverage for the surname-initial guard added 2026-06-23: a placeholder
// surname (a lone "-"/"--"/"." from an SSO profile with no real last name) must not
// render as a meaningless "Name -." across the ~20 name surfaces that route through here.
describe('formatDisplayName', () => {
    it('abbreviates a normal two-part name to "First L."', () => {
        expect(formatDisplayName('Jonas Kazlauskas')).toBe('Jonas K.');
    });

    it('uses the LAST token for the initial in a 3+-part name', () => {
        expect(formatDisplayName('First Middle Last')).toBe('First L.');
    });

    it('returns a single-token name unchanged', () => {
        expect(formatDisplayName('Petras')).toBe('Petras');
    });

    it('drops a placeholder dash surname instead of rendering "Name -."', () => {
        expect(formatDisplayName('Jogile -')).toBe('Jogile');
        expect(formatDisplayName('Kęstutis --')).toBe('Kęstutis');
    });

    it('drops other non-letter placeholder surname tokens', () => {
        expect(formatDisplayName('Ona .')).toBe('Ona');
        expect(formatDisplayName('Ona _')).toBe('Ona');
        expect(formatDisplayName('Ona 123')).toBe('Ona');
    });

    it('keeps a Lithuanian-diacritic surname initial', () => {
        expect(formatDisplayName('Jonas Šimkus')).toBe('Jonas Š.');
        expect(formatDisplayName('Eglė Ąžuolaitė')).toBe('Eglė Ą.');
    });

    it('returns an empty string for falsy input', () => {
        expect(formatDisplayName('')).toBe('');
        expect(formatDisplayName(null)).toBe('');
        expect(formatDisplayName(undefined)).toBe('');
    });
});

// The single source of the task-completion acceptance-gate decision, shared by BOTH completion
// entry points (the timer "Užbaigti" button via TaskTimerControls and the audited completeTask
// command via the checkbox/table path). The bug it guards: a self-managed worker (role 'worker',
// uid == task.managerId) used to be treated as a manager and write status 'confirmed', which
// firestore.rules rejects on the ownsAssignedUser path (changesApprovalFields) → permission-denied,
// task stuck in-progress. The decision must hinge ONLY on role, never on owning managerId — and
// `role` is the only argument, so no caller can re-open the rejected path.
describe('resolveCompletionStatus', () => {
    it('a worker takes the normal acceptance gate (completed, no self-acceptance)', () => {
        expect(resolveCompletionStatus('worker')).toEqual({ status: 'completed', isAcceptance: false });
    });

    it('a self-managed worker is still a worker — role is the ONLY input', () => {
        // There is no managerId/uid argument; a self-managed worker (uid == managerId) reaches
        // this with role 'worker' and MUST land as 'completed', never 'confirmed'.
        expect(resolveCompletionStatus('worker').status).not.toBe('confirmed');
    });

    it('every manager-by-role auto-confirms (confirmed), in lock-step with isManagerRole', () => {
        for (const role of ['manager', 'admin', 'seniorManager']) {
            expect(resolveCompletionStatus(role)).toEqual({ status: 'confirmed', isAcceptance: true });
        }
    });

    it('an unknown / missing role is treated as a non-manager', () => {
        expect(resolveCompletionStatus(undefined).status).toBe('completed');
        expect(resolveCompletionStatus('viewer').status).toBe('completed');
    });
});
