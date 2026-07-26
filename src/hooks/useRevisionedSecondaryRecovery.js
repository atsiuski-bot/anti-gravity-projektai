import { useEffect, useRef } from 'react';
import { useRevisionedTimerSession } from './useRevisionedTimerSession';
import {
    canonicalSessionState,
    planBreakEnd,
    planSecondaryEnd,
} from '../utils/timerTransitionPlan';
import { issueTimerCommand } from '../utils/timerCommandEngine';
import { addRecoveryNotice } from '../utils/recoveryNotice';
import { logError } from '../utils/errorLog';
import { isAbandonedSession, resolvePreBootBeat } from './useOrphanedSessionRecovery';
import { APP_LOAD_TIME } from './useOrphanedTaskRecovery';

const SECONDARY_TYPES = ['break', 'call', 'quickWork'];

const idFor = (prefix) => {
    const random = globalThis.crypto?.randomUUID?.()
        || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${random}`;
};

/**
 * Crash/reload recovery for an abandoned break / call / quick-work run owned by the REVISIONED
 * engine — the canonical counterpart of useOrphanedSessionRecovery.
 *
 * Why this must exist before the ADR-0020 cutover: the legacy hook closes a secondary session by
 * clearing the user doc's projection flags only. It never touches `active_sessions`. Left running
 * under the revisioned engine it would report success while the canonical run stayed ACTIVE — the
 * screen shows idle, the engine still sees a live run, and the worker's next start is rejected with
 * no way to recover from the UI. So the legacy hook is now gated OFF whenever the engine owns the
 * session, and this hook takes over, ending the run through a real revisioned transition so
 * canonical state, projection and ledger move together.
 *
 * Policy is deliberately SHARED with the legacy hook (isAbandonedSession / resolvePreBootBeat), so
 * both engines make the same resume-vs-finalize decision and credit to the same boundary:
 *   • a run started during THIS app session, or still inside the legitimate window (same Vilnius day
 *     AND under 16h), is LEFT RUNNING — a field worker who pocketed the phone keeps their timer;
 *   • a genuinely abandoned one is closed, credited only up to its last PRE-BOOT heartbeat so the
 *     dead offline stretch is never credited, and never resumes whatever it had paused.
 */
export function useRevisionedSecondaryRecovery(currentUser, userData, enabled) {
    const session = useRevisionedTimerSession(currentUser?.uid, enabled);
    const handledRuns = useRef(new Set());

    useEffect(() => {
        if (!enabled || !currentUser?.uid || !session.loaded || session.error) return;

        const base = canonicalSessionState(session.record, {
            ...userData,
            id: currentUser.uid,
        });
        if (base.status !== 'active' || !SECONDARY_TYPES.includes(base.run?.type)) return;

        const startedAt = new Date(base.run.startedAt).getTime();
        if (!Number.isFinite(startedAt) || startedAt >= APP_LOAD_TIME) return;
        if (handledRuns.current.has(base.run.runId)) return;
        if (!isAbandonedSession(base.run.startedAt)) return;

        handledRuns.current.add(base.run.runId);

        // Credit only to the last proof of life recorded BEFORE this boot; no usable beat falls back
        // to now, which the 16h clamp still bounds.
        const beatMs = resolvePreBootBeat(
            startedAt, APP_LOAD_TIME, userData?.activeSessionLastHeartbeat
        );
        const issuedAt = new Date().toISOString();
        const creditUntil = beatMs != null ? new Date(beatMs).toISOString() : issuedAt;
        const type = base.run.type;

        let plan;
        try {
            plan = type === 'break'
                ? planBreakEnd({
                    userId: currentUser.uid,
                    userData,
                    activeRecord: session.record,
                    restoreTask: null,
                    commandId: idFor('timer_recover'),
                    issuedAt,
                    creditUntil,
                    // Explicit, not implied by `restoreTask: null`: a break can nest a task AND now a
                    // call/quick work underneath, and there is no live worker at boot to hand a
                    // resumed session back to. Without the flag this call threw on any break that had
                    // paused a task (so the abandoned break was never closed at all), and would now
                    // silently resume a paused call instead.
                    skipRestore: true,
                })
                : planSecondaryEnd({
                    type,
                    userId: currentUser.uid,
                    userData,
                    activeRecord: session.record,
                    commandId: idFor('timer_recover'),
                    issuedAt,
                    creditUntil,
                    skipRestore: true,
                });
        } catch (error) {
            handledRuns.current.delete(base.run.runId);
            logError(error, {
                source: 'revisionedSecondaryRecovery.plan',
                sessionType: type,
                runId: base.run.runId,
            });
            return;
        }

        issueTimerCommand(plan).then((issued) => {
            issued.settlement.then((outcome) => {
                // Only a CONFIRMED close may be announced as recovered time. A rejected/conflicted
                // one clears the dedupe marker so a later snapshot can retry rather than leaving the
                // run silently stuck active for the rest of the process.
                if (outcome.status !== 'confirmed') {
                    if (outcome.status !== 'queued') handledRuns.current.delete(base.run.runId);
                    return;
                }
                if (!(plan.creditedMinutes > 0)) return;
                addRecoveryNotice(currentUser.uid, {
                    kind: 'session',
                    sessionType: type,
                    minutes: Math.round(plan.creditedMinutes),
                    wasCapped: false,
                });
            });
        }).catch((error) => {
            handledRuns.current.delete(base.run.runId);
            logError(error, {
                source: 'revisionedSecondaryRecovery.issue',
                sessionType: type,
                runId: base.run.runId,
            });
        });
    }, [
        currentUser,
        enabled,
        session.error,
        session.loaded,
        session.record,
        userData,
    ]);
}
