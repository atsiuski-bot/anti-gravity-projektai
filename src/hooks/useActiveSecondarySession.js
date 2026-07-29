import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useActiveSessionStatus } from './useActiveSessionStatus';
import { getLithuanianNow, clampSessionMinutes } from '../utils/timeUtils';
import { SESSION_COLORS } from '../utils/sessionColors';
import { pausedSessionStack } from '../utils/sessionNesting';

// The legacy per-state field on the user doc, used only as the START-TIME fallback when no
// activeSession object exists. A data concern, not a presentation one, so it does not live in
// SESSION_COLORS.
const STATE_KEYS = {
    quickWork: 'quickWorkState',
    call: 'callState',
    break: 'breakState',
};

/**
 * The running SECONDARY session (quick work / call / break) and its live elapsed time.
 *
 * Exists so "what secondary session is running, since when, and for how long" has exactly ONE
 * answer. It is read by the header pill and by the card that pill opens; computing the elapsed
 * time twice would let the two surfaces disagree about the same session on the same screen —
 * the same class of split-brain that made the break day counter drift.
 *
 * A running TASK is deliberately not covered here: a task's authority is its own document (see
 * useActiveTaskElapsedMinutes), not the session projection.
 *
 * @returns {{active: boolean, type: string|null, cfg: Object|null, startISO: string|null,
 *            minutes: number, parkedNodes: Array}} `parkedNodes` are the raw stack entries the
 *          session was started on top of, outermost first, so each caller can render as much of
 *          them as it has room for (the pill shows labels; the card can name the parked task).
 */
export function useActiveSecondarySession() {
    const { userData } = useAuth();
    const { activeSessionType } = useActiveSessionStatus();
    const stateKey = STATE_KEYS[activeSessionType];
    const cfg = stateKey ? SESSION_COLORS[activeSessionType] : null;

    // activeSession is the authoritative start time; fall back to the legacy per-state
    // lastStartedAt only when no activeSession object exists (mirrors useTimerState).
    const activeSession = userData?.activeSession;
    let startISO = null;
    if (cfg) {
        if (activeSession?.type === activeSessionType && activeSession.startTime) {
            startISO = activeSession.startTime;
        } else if (!activeSession) {
            startISO = userData?.[stateKey]?.lastStartedAt || null;
        }
    }

    const [minutes, setMinutes] = useState(0);
    useEffect(() => {
        if (!startISO) {
            setMinutes(0);
            return undefined;
        }
        const start = new Date(startISO);
        // Sanitize the live delta through the shared clamp so a backward device clock can't
        // render a negative time (same guard the in-card timers use).
        const tick = () => setMinutes(clampSessionMinutes((getLithuanianNow() - start) / (1000 * 60)));
        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [startISO]);

    return {
        active: Boolean(cfg && startISO),
        type: cfg ? activeSessionType : null,
        cfg,
        startISO,
        minutes,
        parkedNodes: pausedSessionStack(activeSession),
    };
}
