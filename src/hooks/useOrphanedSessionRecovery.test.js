import { describe, it, expect, vi } from 'vitest';

// The hook's React wiring (the APP_LOAD_TIME orphan gate + useEffect that calls endSession)
// is not rendered: the project has no React test harness, and the recovery TIME ACCOUNTING —
// "an orphaned session is ended with CLAMPED credit and no task resume" — is already proven at
// the action layer (sessionActions.test.js, the orphan-recovery describe). What is unique to
// this hook and purely testable is getSecondarySession: the decision of WHICH live session the
// hook will hand to endSession for recovery. The hook's firebase/context-touching imports are
// mocked so the module loads in the node environment.
vi.mock('../context/AuthContext', () => ({ useAuth: vi.fn(() => ({ userData: null })) }));
vi.mock('../utils/sessionActions', () => ({ endSession: vi.fn() }));
vi.mock('../utils/errorLog', () => ({ logError: vi.fn() }));

import { getSecondarySession, isAbandonedSession } from './useOrphanedSessionRecovery';

describe('getSecondarySession — which session the orphan-recovery hook will end', () => {
    it('resolves a canonical activeSession of each secondary type', () => {
        expect(getSecondarySession({ activeSession: { type: 'break', startTime: 'T' } }))
            .toEqual({ type: 'break', startTime: 'T' });
        expect(getSecondarySession({ activeSession: { type: 'call', startTime: 'T' } }))
            .toEqual({ type: 'call', startTime: 'T' });
        expect(getSecondarySession({ activeSession: { type: 'quickWork', startTime: 'T' } }))
            .toEqual({ type: 'quickWork', startTime: 'T' });
    });

    it('ignores a task activeSession — tasks have their own recovery path', () => {
        expect(getSecondarySession({ activeSession: { type: 'task', taskId: 'x', startTime: 'T' } })).toBeNull();
    });

    it('falls back to the legacy per-type flags when there is no activeSession', () => {
        expect(getSecondarySession({ breakState: { isTakingBreak: true, lastStartedAt: 'B' } }))
            .toEqual({ type: 'break', startTime: 'B' });
        expect(getSecondarySession({ callState: { isCalling: true, lastStartedAt: 'C' } }))
            .toEqual({ type: 'call', startTime: 'C' });
        expect(getSecondarySession({ quickWorkState: { isQuickWorking: true, lastStartedAt: 'Q' } }))
            .toEqual({ type: 'quickWork', startTime: 'Q' });
    });

    it('returns null when nothing recoverable is active', () => {
        expect(getSecondarySession(null)).toBeNull();
        expect(getSecondarySession({})).toBeNull();
        // A running TASK is not a secondary session.
        expect(getSecondarySession({ workStatus: { status: 'running', activeTaskId: 't' } })).toBeNull();
        // A legacy flag set but with no start timestamp is not actionable.
        expect(getSecondarySession({ breakState: { isTakingBreak: true } })).toBeNull();
    });

    it('prefers the canonical activeSession over a stale legacy flag', () => {
        expect(getSecondarySession({
            activeSession: { type: 'call', startTime: 'NEW' },
            breakState: { isTakingBreak: true, lastStartedAt: 'OLD' },
        })).toEqual({ type: 'call', startTime: 'NEW' });
    });
});

describe('isAbandonedSession — resume a live pre-boot session vs. finalize an abandoned one', () => {
    // All instants are UTC ISO; Vilnius is UTC+3 in June (summer), so the Vilnius calendar day is
    // the UTC day shifted +3h. The reference "now" is fixed so the assertions are deterministic.
    const NOW = new Date('2026-06-24T12:00:00Z'); // 15:00 Vilnius, 2026-06-24

    it('RESUMES a same-Vilnius-day session well under 16h (not abandoned)', () => {
        // 09:00 Vilnius start, 6h elapsed, same day → keep running.
        expect(isAbandonedSession('2026-06-24T06:00:00Z', NOW)).toBe(false);
    });

    it('RESUMES a session that just started this app session', () => {
        expect(isAbandonedSession('2026-06-24T11:59:00Z', NOW)).toBe(false);
    });

    it('FINALIZES a session that crossed a Vilnius calendar day even if under 16h elapsed', () => {
        // 22:00 Vilnius on the 23rd → 11:00 Vilnius on the 24th is ~13h, but it is a DIFFERENT
        // Vilnius day, so it is abandoned by the day-boundary clause alone.
        const now = new Date('2026-06-24T08:00:00Z'); // 11:00 Vilnius, 2026-06-24
        expect(isAbandonedSession('2026-06-23T19:00:00Z', now)).toBe(true); // 22:00 Vilnius, 2026-06-23
    });

    it('FINALIZES a same-day session whose elapsed exceeds the 16h ceiling', () => {
        // 04:00 Vilnius start, 18h elapsed, still the same Vilnius day → abandoned by the 16h clause.
        const now = new Date('2026-06-24T19:00:00Z'); // 22:00 Vilnius, 2026-06-24
        expect(isAbandonedSession('2026-06-24T01:00:00Z', now)).toBe(true); // 04:00 Vilnius, 2026-06-24
    });

    it('does NOT finalize on an unparseable start time (filtered upstream; never finalize blindly)', () => {
        expect(isAbandonedSession('not-a-date', NOW)).toBe(false);
        expect(isAbandonedSession(undefined, NOW)).toBe(false);
    });
});
