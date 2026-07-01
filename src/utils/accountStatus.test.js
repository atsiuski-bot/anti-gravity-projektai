import { describe, it, expect } from 'vitest';
import { decideDisabledLogin, isReapprovalPending } from './accountStatus';

describe('decideDisabledLogin', () => {
    it('leaves a first-time pending sign-up in the queue (no re-flag, pending message)', () => {
        // Already awaiting first approval — re-writing status would be a redundant no-op.
        expect(decideDisabledLogin({ status: 'pending' })).toEqual({
            reflagToPending: false,
            errorCode: 'app/pending-approval',
        });
    });

    it('re-flags a previously-blocked account so it re-enters the approval queue', () => {
        // The bell block path writes status:'blocked' → this must resurface as re-approval.
        expect(decideDisabledLogin({ status: 'blocked' })).toEqual({
            reflagToPending: true,
            errorCode: 'app/reapproval-pending',
        });
    });

    it('re-flags an account left status:active by the roster block toggle', () => {
        // UserManagement.confirmBlock flips only isDisabled and leaves status:'active'.
        expect(decideDisabledLogin({ status: 'active' })).toEqual({
            reflagToPending: true,
            errorCode: 'app/reapproval-pending',
        });
    });

    it('re-flags a legacy disabled doc that carries no status field', () => {
        expect(decideDisabledLogin({})).toEqual({
            reflagToPending: true,
            errorCode: 'app/reapproval-pending',
        });
        expect(decideDisabledLogin(undefined)).toEqual({
            reflagToPending: true,
            errorCode: 'app/reapproval-pending',
        });
    });
});

describe('isReapprovalPending', () => {
    it('is true only for a disabled+pending account carrying a reapproval stamp', () => {
        expect(isReapprovalPending({ isDisabled: true, status: 'pending', reapprovalRequestedAt: '2026-07-01T10:00:00Z' })).toBe(true);
    });

    it('is false for a first-time pending sign-up (no reapproval stamp)', () => {
        expect(isReapprovalPending({ isDisabled: true, status: 'pending' })).toBe(false);
    });

    it('is false for a blocked (non-pending) account even if it once requested re-approval', () => {
        // A leftover stamp must never show the re-approval pill unless the account is actually pending.
        expect(isReapprovalPending({ isDisabled: true, status: 'blocked', reapprovalRequestedAt: '2026-07-01T10:00:00Z' })).toBe(false);
    });

    it('is false for an active (enabled) account', () => {
        expect(isReapprovalPending({ isDisabled: false, status: 'active', reapprovalRequestedAt: '2026-07-01T10:00:00Z' })).toBe(false);
    });
});
