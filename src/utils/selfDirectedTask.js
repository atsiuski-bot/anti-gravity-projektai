// Self-directed work — a task the assignee created FOR THEMSELVES with no distinct overseer.
//
// Such a task bypasses the normal completion hand-off: when the worker finishes it, the
// completion notification's resolved recipient equals the actor, so the notify guard
// (`recipientId === actorUid`) DROPS it — the bell never lights up and the work would otherwise
// close silently. The overseeing manager must still get a glance at self-directed work, so the
// team board surfaces these completed jobs inline with a visually distinct affordance, separate
// from the normal hand-off confirm.
//
// Predicate (robust to legacy docs): the creator IS the assignee AND there is no separate human
// manager — either `managerId` is absent, or it points back at the assignee themselves (the
// "keep the visible manager as the user" case from task creation). `createdBy` is the canonical
// creator field (createTask stamps `actor.id`); older docs may lack it, so an absent creator is
// treated as "not self-directed" rather than guessed.
//
// Lives in its own module (not in TaskTable.jsx) so it can be exported without tripping
// react-refresh's "components-only export" rule for the component file.
export const isSelfDirectedTask = (task) => {
    if (!task) return false;
    const assignee = task.assignedUserId;
    if (!assignee || task.createdBy !== assignee) return false;
    return !task.managerId || task.managerId === assignee;
};
