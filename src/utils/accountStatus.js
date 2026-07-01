// Account (users/{uid}) status helpers — the small, pure decisions behind the sign-in
// approval flow, extracted so they can be unit-tested without the Firebase auth machinery.
//
// Background: a new sign-up lands as { isDisabled:true, status:'pending' } and surfaces for an
// admin to approve — the nav badge (usePendingApprovalsCount) and the roster's "Laukia" band
// (UserManagement.isPendingUser) both key on exactly that pair. A DISABLED account that signs in
// again must re-enter that same queue, or a blocked person quietly hits a dead end with no signal
// to the admin that they are trying to get back in.

/**
 * Decide how a DISABLED account's sign-in attempt is handled.
 *
 * A brand-new sign-up that is still awaiting its FIRST approval already sits in the queue
 * (status:'pending'), so nothing is re-written — it just gets the pending message. Any OTHER
 * disabled account (a previously-blocked one, or a legacy doc with no status field) is RE-FLAGGED
 * back to 'pending' so it re-surfaces for the admin to re-approve, and is marked as a RETURNING
 * request so the copy/pill can say "awaiting re-approval" rather than "created, awaiting approval".
 *
 * @param {{status?: string}} data - the existing users/{uid} document data.
 * @returns {{reflagToPending: boolean, errorCode: 'app/pending-approval'|'app/reapproval-pending'}}
 *   reflagToPending — whether the caller should write { status:'pending', reapprovalRequestedAt }
 *   before signing out; errorCode — the coded reason Login maps to friendly Lithuanian copy.
 */
export function decideDisabledLogin(data) {
    const alreadyPending = data?.status === 'pending';
    return {
        reflagToPending: !alreadyPending,
        errorCode: alreadyPending ? 'app/pending-approval' : 'app/reapproval-pending',
    };
}

/**
 * True when a pending account is a RETURNING one (previously blocked, re-flagged on its next
 * sign-in), as opposed to a first-time sign-up. Used only to pick the roster pill's wording — both
 * kinds still count as pending everywhere else.
 *
 * @param {{isDisabled?: boolean, status?: string, reapprovalRequestedAt?: string}} user
 * @returns {boolean}
 */
export function isReapprovalPending(user) {
    return !!user?.isDisabled && user?.status === 'pending' && !!user?.reapprovalRequestedAt;
}
