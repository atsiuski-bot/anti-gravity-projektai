import { where } from 'firebase/firestore';

/**
 * Scoped-manager hierarchy (ADR 0005).
 *
 * A manager is "scoped" when an admin has restricted them to their assigned people
 * (`users/{uid}.scopedManager === true`). Everyone else with manager-or-above reach — admins,
 * and managers left unscoped (the default) — sees the whole company, exactly as before.
 *
 * Confidentiality is enforced server-side: each private row (`tasks`, `archived_tasks`,
 * `work_sessions`, `break_sessions`, `deleted_tasks`) carries a denormalized `teamManagerIds`
 * array, and a scoped manager's queries must constrain themselves with `array-contains` so they
 * only ever request rows the rules will allow. `array-contains` matches a single value, so there
 * is no 30-id `in`-query cap.
 */

// The signed-in user is a manager restricted to their assigned people.
export const isScopedManager = (userData) =>
    !!userData && userData.role === 'manager' && userData.scopedManager === true;

// The signed-in user may see EVERY private row (no team filter): admins, senior managers
// (Vyr. vadovas — whole-company oversight rank, never scoped), and unscoped managers.
export const canSeeWholeTeam = (userData) =>
    !!userData && (
        userData.role === 'admin' ||
        userData.role === 'seniorManager' ||
        (userData.role === 'manager' && userData.scopedManager !== true)
    );

// The Firestore constraint that limits a private collection to the viewer's team, or `null` when
// the viewer sees everything (admin / unscoped manager). Workers use their own owner-scoped
// queries elsewhere; this is for the manager/admin surfaces. `uid` is the viewer's auth uid
// (the user-doc data carries no id of its own).
export const teamScopeConstraint = (userData, uid) =>
    (isScopedManager(userData) && uid) ? where('teamManagerIds', 'array-contains', uid) : null;

// Does a target user belong to the given manager's team (their managers include this manager)?
export const isOnManagerTeam = (targetUser, managerUid) =>
    !!targetUser &&
    Array.isArray(targetUser.teamManagerIds) &&
    targetUser.teamManagerIds.includes(managerUid);

// Query constraints that limit a private collection to the rows the viewer may READ, so a query
// never requests a document the rules would deny (which fails the whole query). `effectiveRole`
// is the viewer's resolved role for this surface ('worker' forces an own-only personal view,
// e.g. a manager opening their own reports). `ownerField` is the collection's owner field
// (`userId` for sessions, `assignedUserId` for tasks). Returns an array of constraints to spread
// into query(): [] = no constraint (whole-company), own-only, or the team array-contains.
export const privateScopeConstraints = ({ userData, uid, effectiveRole, ownerField }) => {
    if (effectiveRole === 'worker') return uid ? [where(ownerField, '==', uid)] : [];
    if (canSeeWholeTeam(userData)) return [];
    if (isScopedManager(userData) && uid) return [where('teamManagerIds', 'array-contains', uid)];
    return uid ? [where(ownerField, '==', uid)] : [];
};

// Narrow a roster to what the viewer may see: everyone for whole-team viewers; for a scoped
// manager, their team members plus themselves. (These surfaces are not shown to plain workers,
// but fall back to self to be safe.)
export const scopeRoster = (users, userData, uid) => {
    if (canSeeWholeTeam(userData)) return users;
    if (isScopedManager(userData)) {
        return users.filter((u) => u.id === uid || isOnManagerTeam(u, uid));
    }
    return users.filter((u) => u.id === uid);
};
