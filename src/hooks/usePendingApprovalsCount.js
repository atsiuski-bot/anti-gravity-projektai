import { useMemo } from 'react';
import { useUsers } from '../context/UsersContext';
import { useAuth } from '../context/AuthContext';

/**
 * Live count of new sign-ups awaiting an admin's approval — a pending account is
 * `isDisabled && status === 'pending'` (the exact predicate User Management's `isPendingUser`
 * uses, so the nav badge and the roster's "Laukia" band can never disagree).
 *
 * This is the PERSISTENT companion to the transient bell notification (`account_approval`, fanned
 * out by the `notifyAdminsOnPendingSignup` Cloud Function): the bell alerts once when a sign-up
 * lands, while this badge keeps showing "N waiting" until the queue is actually cleared — closing
 * the "I didn't notice someone is waiting" gap that made approved-by-default logins feel broken.
 *
 * Returns 0 for non-admins: only an admin sees the Vartotojai tab and can act on the queue, so a
 * manager/worker must never carry a count they cannot resolve. Both admin role spellings are
 * honored (legacy 'Administratorius' alongside 'admin'), matching the Cloud Function.
 *
 * @returns {number} pending approvals visible to the current user (0 unless admin)
 */
export function usePendingApprovalsCount() {
    const { users } = useUsers();
    const { userRole } = useAuth();

    return useMemo(() => {
        if (userRole !== 'admin' && userRole !== 'Administratorius') return 0;
        return users.filter((u) => u.isDisabled && u.status === 'pending').length;
    }, [users, userRole]);
}
