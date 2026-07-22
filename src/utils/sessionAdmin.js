import { doc, updateDoc, getDoc, getDocFromServer } from 'firebase/firestore';
import { db } from '../firebase';
import { pauseTask } from './taskActions';
import { logError } from './errorLog';
import { applyTimerTransitionPlan } from './timerTransitionExecutor';
import { planManagerForceEnd } from './timerTransitionPlan';

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
 * @returns {Promise<void>}
 */
export const endSessionForUser = async (user, { actorId = null } = {}) => {
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
            if (activeRecord.run?.type === 'task') {
                const taskSnap = await getDoc(doc(db, 'tasks', activeRecord.run.taskId));
                if (!taskSnap.exists()) {
                    throw new Error('Cannot force-end a canonical task without the task document');
                }
                activeTask = { id: taskSnap.id, ...taskSnap.data() };
            }
            const plan = planManagerForceEnd({
                targetUser: target,
                actorId,
                activeRecord,
                activeTask,
                commandId: `manager_force_end_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                issuedAt: new Date().toISOString(),
            });
            await applyTimerTransitionPlan(db, plan);
            return {
                status: 'canonical-ended',
                creditedMinutes: plan.creditedMinutes,
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
        return { status: 'legacy-cleared' };
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
