import { useEffect, useRef } from 'react';
import { doc, getDocFromServer } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { endSession } from '../utils/sessionActions';
import { addRecoveryNotice } from '../utils/recoveryNotice';
import { logError } from '../utils/errorLog';
import { getLithuanianDateString, MAX_SESSION_MINUTES } from '../utils/timeUtils';

// Captured once when the app/tab boots. A secondary session (break / call / quick-work) whose
// startTime predates this moment survived an app restart, reload, or crash (the OS discarded the
// backgrounded PWA and the worker reopened it). That alone does NOT make it an orphan: the time is
// server-anchored (elapsed = now − persisted startTime), so a same-day, sub-16h session is a
// legitimately-running timer the worker means to KEEP — a field worker pockets the phone (screen
// off) and keeps working. We therefore RESUME those (leave activeSession untouched; the live timer
// recomputes elapsed from the persisted startTime). Only a genuinely ABANDONED pre-boot session —
// one that crossed a Vilnius calendar day or already exceeds the 16h single-session ceiling — is
// finalized here. (A session started during THIS app session has startTime >= APP_LOAD_TIME and is
// always left running.) The "never reopens" case is bounded server-side by autoCloseForgottenSessions.
const APP_LOAD_TIME = Date.now();

// Decide whether a pre-boot secondary session is ABANDONED (finalize it) vs. still legitimately
// running (resume it). Pure + exported so the policy is unit-testable without a React renderer.
//
// Abandoned when EITHER:
//   - it crossed a Vilnius calendar day (a break/call/quick-work spanning midnight is forgotten,
//     not a 6-minute break taken across the date boundary), OR
//   - its elapsed already exceeds the 16h single-session ceiling (MAX_SESSION_MINUTES) — the same
//     bound clampSessionMinutes enforces on credited time, so the resume window and the write clamp
//     agree on where "real session" ends and "ghost time" begins.
// Otherwise (same Vilnius day AND under 16h) it is resumed: the worker kept the timer running on
// purpose, and nothing is lost — the elapsed is recomputed from the server-persisted startTime.
//
// @param {string} startTimeIso - the session's persisted ISO start time.
// @param {Date}   [now=new Date()] - reference instant (injectable for tests).
export const isAbandonedSession = (startTimeIso, now = new Date()) => {
    const start = new Date(startTimeIso);
    const startMs = start.getTime();
    if (!Number.isFinite(startMs)) return false; // unparseable is filtered upstream; never finalize blindly
    if (getLithuanianDateString(start) !== getLithuanianDateString(now)) return true; // crossed a Vilnius day
    if ((now.getTime() - startMs) / (1000 * 60) > MAX_SESSION_MINUTES) return true;   // beyond the 16h ceiling
    return false;
};

// Resolve an active secondary session's (type, startTime) from either the canonical
// activeSession or the legacy per-type flags. Tasks are deliberately ignored here — they have
// their own recovery (useOrphanedTaskRecovery) and a different end path (pauseTask).
// Exported (pure, no side effects) so the "what gets recovered" decision is unit-testable
// without a React renderer — see useOrphanedSessionRecovery.test.js.
export const getSecondarySession = (userData) => {
    const as = userData?.activeSession;
    if (as && (as.type === 'break' || as.type === 'call' || as.type === 'quickWork') && as.startTime) {
        return { type: as.type, startTime: as.startTime };
    }
    if (userData?.breakState?.isTakingBreak && userData.breakState.lastStartedAt) {
        return { type: 'break', startTime: userData.breakState.lastStartedAt };
    }
    if (userData?.callState?.isCalling && userData.callState.lastStartedAt) {
        return { type: 'call', startTime: userData.callState.lastStartedAt };
    }
    if (userData?.quickWorkState?.isQuickWorking && userData.quickWorkState.lastStartedAt) {
        return { type: 'quickWork', startTime: userData.quickWorkState.lastStartedAt };
    }
    return null;
};

// Confirm a suspected abandoned secondary session against the SERVER (never the cache) before
// finalizing it. The userData snapshot that raised the suspicion can be arbitrarily stale — with
// the persistent cache, the first emission after boot is the previous run's state — and finalizing
// from it is how a long-closed device could wipe a LIVE session started meanwhile on another
// device (endSession writes activeSession:null blind) or re-derive an already-corrected history
// row. Returns the FRESH user doc when the exact same session (same type + startTime) is still
// live on the server, or null when another closer already ended it / a NEW session replaced it.
// Throws on a failed read (offline) — the caller must treat the orphan as unproven and retry.
export async function confirmSessionOrphanOnServer(uid, session) {
    const snap = await getDocFromServer(doc(db, 'users', uid));
    if (!snap.exists()) return null;
    const fresh = snap.data();
    const live = getSecondarySession(fresh);
    if (!live || live.type !== session.type || live.startTime !== session.startTime) return null;
    return fresh;
}

// Pick the freshest PRE-BOOT proof of life from the candidate heartbeat stamps (the cached and the
// server-fresh activeSessionLastHeartbeat). Post-boot beats are excluded on purpose: this device's
// own useSessionHeartbeat beats the session immediately at boot — BEFORE recovery decides — so a
// post-boot stamp proves nothing about whether the worker was there during the offline stretch,
// and using it as endAt would credit the whole dead gap. Pre-start stamps (stale, from an earlier
// session) are equally unusable. Returns the max usable beat in epoch ms, or null (→ the caller
// falls back to end-at-now, the prior clamped behaviour). Pure + exported for tests.
export function resolvePreBootBeat(startMs, appLoadTime, ...beatIsos) {
    const usable = beatIsos
        .map((iso) => (iso ? new Date(iso).getTime() : NaN))
        .filter((ms) => Number.isFinite(ms) && ms >= startMs && ms <= appLoadTime);
    return usable.length ? Math.max(...usable) : null;
}

/**
 * Crash/reload recovery for an ABANDONED break / call / quick-work session.
 *
 * useOrphanedTaskRecovery covers only TASK timers; secondary sessions had no equivalent, which is
 * the root cause of the catastrophic "190-day break" in the early data — a break timer was left
 * running, the app closed, and the eventual end credited the entire offline gap.
 *
 * The earlier fix finalized EVERY pre-boot session, which over-fired: on mobile the OS discards a
 * backgrounded PWA within minutes, so a worker who locked the phone and reopened mid-session had
 * their live quick-work/call/break "ended" on the reload — the exact complaint this revision fixes.
 * The time is server-anchored (elapsed = now − persisted startTime), so a reopened same-day session
 * loses nothing by simply continuing. We therefore RESUME a pre-boot session that is still within
 * the legitimate single-session window (same Vilnius day AND under 16h) — leaving activeSession
 * untouched so the live timer keeps counting — and finalize ONLY a genuinely abandoned one
 * (isAbandonedSession), via endSession, which clamps the credited elapsed to MAX_SESSION_MINUTES
 * (so even an undetected multi-day gap is bounded) and leaves the user idle (skipResume — there is
 * no live worker to resume a queued task on boot). A worker who never reopens at all is bounded
 * server-side by autoCloseForgottenSessions (functions/index.js), the logging counterpart to this.
 *
 * @param {Object} currentUser - the authenticated user (needs uid).
 */
export function useOrphanedSessionRecovery(currentUser) {
    const { userData } = useAuth();
    const handledRef = useRef(false);

    useEffect(() => {
        if (handledRef.current) return;
        if (!currentUser?.uid || !userData) return;

        const session = getSecondarySession(userData);
        if (!session) return;

        const startedAt = new Date(session.startTime).getTime();
        if (!Number.isFinite(startedAt)) return;

        // A session started during THIS app session is unambiguously live — leave it running.
        // (Not latched: a this-session timer can never become a pre-boot orphan, and a pre-boot
        // session, if any, is already in the first snapshot — we only latch once we actually
        // make the pre-boot decision below.)
        if (startedAt >= APP_LOAD_TIME) return;

        // This is the ONE pre-boot decision this boot-recovery hook makes. Latch it BEFORE the
        // resume/finalize split so a later snapshot cannot RE-decide: the effect re-runs on every
        // userData change, and without this latch a session correctly RESUMED at boot would be
        // re-evaluated when the wall clock later crosses a Vilnius midnight (or the 16h ceiling)
        // while the app stays open — and finalized under a worker who is actively running it.
        // After this latch, an abandoned-while-open session is closed by the server net / an
        // explicit stop, never re-finalized here.
        handledRef.current = true;

        // RESUME a pre-boot session still within the legitimate window (return without finalizing);
        // finalize ONLY a genuinely abandoned one — crossed a Vilnius day or exceeded the 16h ceiling.
        if (!isAbandonedSession(session.startTime)) return;

        const uid = currentUser.uid;
        const cachedBeatIso = userData.activeSessionLastHeartbeat;
        (async () => {
            // Confirm against the SERVER before touching anything: the userData above may be a
            // stale cache emission, and the session may already be closed — or replaced by a LIVE
            // one — on the server. Finalizing from the cache is how a long-closed device could
            // wipe a session another device is actively running.
            let freshData;
            try {
                freshData = await confirmSessionOrphanOnServer(uid, session);
            } catch (e) {
                // Unproven (offline boot / transient network) and nothing written — unlatch so a
                // later userData emission (e.g. on reconnect) retries.
                handledRef.current = false;
                logError(e, { source: 'orphanRecovery:confirmSession', userId: uid, sessionType: session.type });
                return;
            }
            if (!freshData) return; // already closed / replaced by another closer — nothing to do

            // Credit the abandoned session only up to its last PRE-BOOT proof of life (the
            // per-minute heartbeat, see useSessionHeartbeat), not up to the arbitrary reopen
            // instant — so a session whose app was closed for hours/days does not credit that
            // dead gap as break/work. Both the cached and the server-fresh stamp are candidates
            // (the freshest wins); no usable beat → fall back to end-at-now, the prior clamped
            // behaviour. endSession receives the SERVER-fresh user doc, so its caller-supplied-
            // snapshot fast path no longer bypasses the staleness defense.
            const beatMs = resolvePreBootBeat(
                startedAt, APP_LOAD_TIME, cachedBeatIso, freshData.activeSessionLastHeartbeat
            );
            const overrides = beatMs != null ? { endAt: beatMs } : {};
            try {
                const result = await endSession(uid, freshData, overrides, true);
                // Stamp a one-time notice so the worker is told their forgotten timer was
                // auto-closed and HOW MUCH was credited — recovery was previously silent, which
                // is exactly why a capped/recovered session later read as "unexplained hours".
                // Only worth surfacing if real time was actually credited; a sub-minute or
                // backward-clock orphan (creditedMinutes ~ 0) closes invisibly, as before.
                if (result && result.creditedMinutes > 0) {
                    addRecoveryNotice(uid, {
                        kind: 'session',
                        sessionType: session.type,
                        minutes: result.creditedMinutes,
                        wasCapped: !!result.wasCapped,
                    });
                }
            } catch (e) {
                logError(e, { source: 'orphanRecovery:endSession', userId: uid, sessionType: session.type });
            }
        })();
    }, [currentUser, userData]);
}
