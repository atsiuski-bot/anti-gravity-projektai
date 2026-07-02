import { where } from 'firebase/firestore';

/**
 * Scoped overseer hierarchy (ADR 0005 + ADR 0007).
 *
 * Four ranks: admin > seniorManager (Vyr. vadovas) > manager (Vadovas) > worker (Vykdytojas).
 *
 * Who sees every private row, and who is confined to a subtree:
 *  • admin                     — whole company, always.
 *  • manager, UNSCOPED         — whole company (the default; `scopedManager` absent/false).
 *  • manager, SCOPED           — only their assigned workers' rows.
 *  • seniorManager             — only their subtree: the managers assigned to them PLUS those
 *                                managers' workers. A senior is ALWAYS scoped (no whole-company
 *                                toggle); account management stays admin-only.
 *
 * Confidentiality is enforced server-side: each private row (`tasks`, `archived_tasks`,
 * `work_sessions`, `break_sessions`, `deleted_tasks`) carries a denormalized `teamManagerIds`
 * array — its owner's OVERSEER CLOSURE (every manager/senior uid who may see it), maintained by a
 * Cloud Function. A scoped overseer's queries must constrain themselves with `array-contains` so
 * they only ever request rows the rules will allow. `array-contains` matches a single value, so
 * there is no 30-id `in`-query cap.
 *
 * Membership is set by an admin on the user doc with two editable fields:
 *  • `teamManagerIds`   — a worker's managers (one level up).
 *  • `seniorManagerIds` — a manager's seniors (one level up).
 * The Cloud Function folds these into `overseerIds` (the transitive closure) on each user doc and
 * stamps the same closure onto every owned row's `teamManagerIds`.
 */

// The signed-in user is a manager restricted to their assigned people.
export const isScopedManager = (userData) =>
    !!userData && userData.role === 'manager' && userData.scopedManager === true;

// The signed-in user is a senior manager (Vyr. vadovas) — always scoped to their subtree.
export const isSeniorManager = (userData) =>
    !!userData && userData.role === 'seniorManager';

// The signed-in user's visibility is confined to a denormalized subtree stamp (the row's
// teamManagerIds closure): a scoped manager OR any senior manager. Both query with `array-contains`.
export const isScopedOverseer = (userData) =>
    isScopedManager(userData) || isSeniorManager(userData);

// The signed-in user may see EVERY private row (no team filter): admins and unscoped managers.
// A senior manager does NOT qualify — they are scoped to their subtree.
export const canSeeWholeTeam = (userData) =>
    !!userData && (
        userData.role === 'admin' ||
        (userData.role === 'manager' && userData.scopedManager !== true)
    );

// Is the viewer in the target user's overseer set? Prefers the denormalized closure (`overseerIds`,
// maintained by the Cloud Function) — that is what the security rules effectively grant. Falls back
// to the union of the direct membership fields (`teamManagerIds` ∪ `seniorManagerIds`) for the
// pre-backfill window before the closure has been computed.
export const isOverseenBy = (targetUser, viewerUid) => {
    if (!targetUser || !viewerUid) return false;
    const closure = targetUser.overseerIds;
    if (Array.isArray(closure) && closure.length) return closure.includes(viewerUid);
    const direct = []
        .concat(Array.isArray(targetUser.teamManagerIds) ? targetUser.teamManagerIds : [])
        .concat(Array.isArray(targetUser.seniorManagerIds) ? targetUser.seniorManagerIds : []);
    return direct.includes(viewerUid);
};

// Query constraints that limit a private collection to the rows the viewer may READ, so a query
// never requests a document the rules would deny (which fails the whole query). `effectiveRole`
// is the viewer's resolved role for this surface ('worker' forces an own-only personal view,
// e.g. a manager opening their own reports). `ownerField` is the collection's owner field
// (`userId` for sessions, `assignedUserId` for tasks). Returns an array of constraints to spread
// into query(): [] = no constraint (whole-company), own-only, or the subtree array-contains.
export const privateScopeConstraints = ({ userData, uid, effectiveRole, ownerField }) => {
    if (effectiveRole === 'worker') return uid ? [where(ownerField, '==', uid)] : [];
    if (canSeeWholeTeam(userData)) return [];
    if (isScopedOverseer(userData) && uid) return [where('teamManagerIds', 'array-contains', uid)];
    return uid ? [where(ownerField, '==', uid)] : [];
};

// Narrow a roster to what the viewer may see: everyone for whole-team viewers; for a scoped
// overseer (scoped manager or senior manager), their subtree members plus themselves. (These
// surfaces are not shown to plain workers, but fall back to self to be safe.)
export const scopeRoster = (users, userData, uid) => {
    if (canSeeWholeTeam(userData)) return users;
    if (isScopedOverseer(userData)) {
        return users.filter((u) => u.id === uid || isOverseenBy(u, uid));
    }
    return users.filter((u) => u.id === uid);
};
