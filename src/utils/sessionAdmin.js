import { doc, updateDoc, getDoc, getDocFromServer } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask } from './taskActions';
import { logError } from './errorLog';
import { notify } from './notify';
import { getLithuanianDateString } from './timeUtils';
import { SESSION_COLORS } from './sessionColors';
import { pausedSessionStack } from './sessionNesting';
import { applyTimerTransitionPlan } from './timerTransitionExecutor';
import { planManagerForceEnd } from './timerTransitionPlan';

/**
 * Human summary of what a force-end DROPPED, for the worker's notification.
 *
 * A force-end settles the whole stack, not one layer of it (see planManagerForceEnd). No time is
 * lost — everything below the top run was banked when it was interrupted — but the worker's return
 * path is: their break and their task disappear from the screen with no explanation. Naming them is
 * what turns a silent clear into something the worker can act on themselves.
 *
 * Session types are named from the ONE presentation map so this copy cannot drift from the labels
 * the timers use; a task is named by its own title.
 */
const summarizeDiscardedStack = (stack) => (stack || [])
    .map((node) => (node.type === 'task'
        ? (node.taskTitle || 'Užduotis')
        : (SESSION_COLORS[node.type]?.label || null)))
    .filter(Boolean)
    .join(' · ');

/**
 * Tell the worker that a coordinator ended their session, and what was parked underneath it.
 *
 * Best-effort and never awaited into the caller's result: a failed notification must not make a
 * SETTLED session report as failed and invite the manager to force-end again. `notify` drops a
 * self-addressed write on its own, so a manager settling their own session is silently skipped.
 */
const notifyForceEnd = (targetUserId, actorId, discardedStack, issuedAt) => {
    const parkedSummary = summarizeDiscardedStack(discardedStack);
    notify({
        recipientId: targetUserId,
        type: 'session_force_ended',
        actorUid: actorId,
        day: getLithuanianDateString(new Date(issuedAt)),
        ...(parkedSummary ? { parkedSummary } : {}),
    }).catch((e) => logError(e, { source: 'endSessionForUser.notify', userId: targetUserId }));
};

/**
 * Manager-side session teardown — settle a worker who is stuck "live" without disabling them.
 *
 * Mirror of UserManagement's private `closeActiveSessionForUser`, lifted here so the live-oversight
 * panel (ActiveWorkSessions) can end a stuck session WITHOUT importing from a component another
 * branch owns. The two copies are intentionally duplicated for now; a later cleanup can dedupe by
 * having UserManagement import this util.
 *
 * Why this exists: a worker whose phone died / app was killed mid-session never ends their own
 * timer, so they show "working" forever and (for a task) keep crediting ghost time. A running TASK
 * is settled through `pauseTask`, which logs the open segment to `work_sessions` (a write managers/
 * admins are allowed to make) and clears the owner's `activeSession`/`workStatus`. Non-task break/
 * call/quick-work tails CANNOT be server-logged by a manager — those collections are owner-only — so
 * we can only clear the ghost flags, which matches the existing disable path's block behaviour.
 *
 * Unlike the disable flow, this NEVER touches `isDisabled`: it only settles the session. Failures
 * are logged and swallowed so a transient write error never leaves the caller in a broken state.
 *
 * @param {Object} user - the target user doc ({ id, activeSession?, workStatus?, ... }).
 * @param {Object} [opts]
 * @param {string} [opts.actorId] - the signed-in caller; required for a canonical force-end.
 * @param {boolean} [opts.notifyWorker=true] - tell the worker their session was ended. Set false
 *        ONLY when the caller sends its own, strictly more informative notice for the same event
 *        (deleteTask does — see its call site), so the worker is not pinged twice about one action.
 * @returns {Promise<Object>} { status, creditedMinutes?, discardedStack? }
 */
export const endSessionForUser = async (user, { actorId = null, notifyWorker = true } = {}) => {
    if (!user?.id) return { status: 'skipped' };
    try {
        // Re-read the target SERVER-FIRST and settle THAT copy, never the caller's snapshot. The
        // oversight panel captures the user doc when the manager taps the icon and calls this an
        // arbitrary time later, from behind a confirm dialog — long enough for the worker to reopen
        // the app, end the stuck session and start a new task. Acting on the frozen copy resolved
        // the OLD (already paused) task, skipped pauseTask, and then blind-cleared the user doc:
        // the new task kept timerStatus:'running' with nobody's session pointing at it, so the next
        // pause credited the whole stretch. Fall back to the passed-in copy only when the read
        // fails, so a flaky manager connection still settles a genuinely stuck worker.
        const freshSnap = await getDocFromServer(doc(db, 'users', user.id)).catch(() => null);
        const target = freshSnap?.exists?.() ? { id: user.id, ...freshSnap.data() } : user;

        const activeSessionSnap = await getDoc(doc(db, 'active_sessions', user.id));
        const activeRecord = activeSessionSnap.exists() ? activeSessionSnap.data() : null;
        if (activeRecord?.status === 'active') {
            if (!actorId) throw new Error('Manager force-end requires an actor id');
            let activeTask = null;
            if (activeRecord.run?.type === 'task' && activeRecord.run?.taskId) {
                const taskSnap = await getDoc(doc(db, 'tasks', activeRecord.run.taskId));
                // A MISSING task is no longer fatal. It is the exact state this control exists to
                // repair: the task was hard-deleted while its timer ran, so the canonical run now
                // points at nothing and every other path (recovery, next start) refuses it. Throwing
                // here made the one remaining escape hatch refuse it too. planManagerForceEnd closes
                // an orphaned run from the run's own data and still writes the credited ledger row.
                activeTask = taskSnap.exists() ? { id: taskSnap.id, ...taskSnap.data() } : null;
            }
            const issuedAt = new Date().toISOString();
            const plan = planManagerForceEnd({
                targetUser: target,
                actorId,
                activeRecord,
                activeTask,
                commandId: `manager_force_end_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                issuedAt,
            });
            await applyTimerTransitionPlan(db, plan);
            // AFTER the settle is committed: the worker is told only about something that actually
            // happened, and a notification failure can never roll back a settled session.
            if (notifyWorker) notifyForceEnd(user.id, actorId, plan.discardedStack, issuedAt);
            return {
                status: 'canonical-ended',
                creditedMinutes: plan.creditedMinutes,
                discardedStack: plan.discardedStack,
            };
        }

        const activeTaskId = target.activeSession?.taskId || target.workStatus?.activeTaskId;
        if (activeTaskId) {
            const taskSnap = await getDoc(doc(db, 'tasks', activeTaskId));
            if (taskSnap.exists()) {
                const t = { id: taskSnap.id, ...taskSnap.data() };
                if (t.timerStatus === 'running') {
                    // Logs the open segment + clears the owner's activeSession/workStatus.
                    await pauseTask(t);
                }
            }
        }
        // The legacy engine stacks sessions in the SAME shape (activeSession.pausedSession), so this
        // branch drops a stack just as the canonical one does — read it before the clear below wipes
        // it. Guarded on actorId: without a caller uid the notification carries no provenance and
        // firestore.rules would reject it, so a call made without one stays a silent clear (its
        // previous behaviour) rather than logging a failed write on every settle.
        const legacyDiscarded = pausedSessionStack(target.activeSession).map((node) => ({
            type: node.type,
            ...(node.taskId ? { taskId: node.taskId } : {}),
            ...(node.taskTitle ? { taskTitle: node.taskTitle } : {}),
        }));

        // Clear every live-session flag on the user doc. Idempotent with pauseTask's own clear:
        // it also removes the legacy break/call/quick-work ghosts pauseTask does not touch.
        await updateDoc(doc(db, 'users', user.id), {
            activeSession: null,
            'workStatus.isWorking': false,
            'workStatus.status': 'idle',
            'workStatus.activeTaskId': null,
            'breakState.isTakingBreak': false,
            'callState.isCalling': false,
            'quickWorkState.isQuickWorking': false,
        });
        if (actorId && notifyWorker) {
            notifyForceEnd(user.id, actorId, legacyDiscarded, new Date().toISOString());
        }
        return { status: 'legacy-cleared', discardedStack: legacyDiscarded };
    } catch (e) {
        logError(e, { source: 'endSessionForUser', userId: user.id });
        return { status: 'failed', error: e };
    }
};

/**
 * True when the user is mid-session by any live signal (task timer, legacy break/call/quick-work).
 * Mirrors UserManagement's private `hasOpenSession` so the oversight panel can decide whether there
 * is anything to settle without reaching into that component.
 *
 * @param {Object} user
 * @returns {boolean}
 */
export const hasOpenSession = (user) =>
    !!(
        user?.activeSession ||
        user?.workStatus?.status === 'running' ||
        user?.breakState?.isTakingBreak ||
        user?.callState?.isCalling ||
        user?.quickWorkState?.isQuickWorking
    );
