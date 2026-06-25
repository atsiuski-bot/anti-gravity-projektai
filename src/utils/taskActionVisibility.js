import { CheckCircle2, RefreshCw, RotateCcw } from 'lucide-react';
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

/**
 * buildReviewActions — the ONE action set for the manager review/acceptance surfaces (Reports
 * "Pridavimas/Istorija" + DailyStatistics approval), so the mobile card and the desktop table show
 * the SAME buttons in the SAME order through TaskActionRow. The acceptance pipeline has two phases:
 *
 *  - AWAITING acceptance (status 'completed'): the manager can "Priimti" (accept → confirmed) and,
 *    when permitted, "Grąžinti" (send back to the active list). This is the "Priimti" sub-tab.
 *  - ACCEPTED (status 'confirmed'): the only action is "Atnaujinti" — re-open the acceptance (back
 *    to 'completed', i.e. the Priimti sub-tab). "Grąžinti" is intentionally NOT offered here; it
 *    lives only in the Priimti sub-tab. The icon is a refresh (distinct from the accept checkmark).
 *
 * Comment / edit are deliberately absent — they live in the task detail sheet (open on tap), not in
 * the row's action strip.
 *
 * @param {Object}   args
 * @param {Object}   args.task
 * @param {boolean}  args.isManager       manager/admin may accept / re-open
 * @param {boolean}  args.canRestore      may send an awaiting task back to the active list
 * @param {Function} args.onToggleConfirm (task) => void — toggles confirmed ⇄ completed
 * @param {Function} args.onRestore       (task) => void — restore to the active list
 * @returns {Array<{key,label,icon,variant,disabled?,onClick}>}
 */
export function buildReviewActions({ task, isManager, canRestore, onToggleConfirm, onRestore }) {
    const isConfirmed = task.status === 'confirmed';
    const acts = [];
    if (isConfirmed) {
        // Accepted → the checkmark becomes "Atnaujinti": re-open the acceptance (back to the
        // Priimti sub-tab). Refresh icon, never the accept checkmark.
        if (isManager) {
            acts.push({
                key: 'reopen', label: 'Atnaujinti', icon: RefreshCw, variant: 'secondary',
                disabled: !!task.archivedAt, onClick: () => onToggleConfirm(task),
            });
        }
        return acts;
    }
    // Awaiting acceptance → accept, and (only here) optionally send back to the active list.
    if (isManager) {
        acts.push({
            key: 'confirm', label: 'Priimti', icon: CheckCircle2, variant: 'success',
            disabled: !!task.archivedAt, onClick: () => onToggleConfirm(task),
        });
    }
    if (canRestore) {
        acts.push({ key: 'restore', label: 'Grąžinti', icon: RotateCcw, variant: 'secondary', onClick: () => onRestore(task) });
    }
    return acts;
}
