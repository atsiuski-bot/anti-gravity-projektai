import { isManagerRole } from './formatters';

/**
 * Shared manager sign-off visibility predicates — the single source of truth for WHICH sign-off
 * actions a task offers, so the mobile card, the desktop table and the detail modal can no longer
 * drift apart on this logic (they each used to inline their own copy).
 *
 * A "manager" here is anyone whose effective role OR the surface role is a manager/admin — matching
 * how the card has always decided (a manager viewing a worker list is still a manager). Callers that
 * only want the system-role check pass role===undefined.
 */
function isManager({ role, userRole }) {
    return isManagerRole(role) || isManagerRole(userRole);
}

// An unapproved task can be approved (clears the creation gate → "Patvirtintas").
export function canApproveTask({ task, role, userRole }) {
    return isManager({ role, userRole }) && (task.status || 'pending') === 'unapproved';
}

// Finished work ("Laukia priėmimo") can be accepted (completed → confirmed).
export function canConfirmTask({ task, role, userRole }) {
    return isManager({ role, userRole }) && (task.status || 'pending') === 'completed';
}

// Any finished or deleted task can be sent back to the active list.
export function canRevertTask({ task, role, userRole }) {
    return isManager({ role, userRole }) && (task.completed || task.isDeleted);
}
