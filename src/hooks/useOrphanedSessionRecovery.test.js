import { describe, it, expect, vi, beforeEach } from 'vitest';

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
// The confirm step reads the user doc straight from the SERVER; mocked so the confirmation rule is
// drivable with a controlled fresh doc and a controlled failure.
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}` })),
    getDocFromServer: vi.fn(),
}));

import {
    getSecondarySession, isAbandonedSession, confirmSessionOrphanOnServer, resolvePreBootBeat,
} from './useOrphanedSessionRecovery';
import { getDocFromServer } from 'firebase/firestore';

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

// The server-confirmation gate: the userData snapshot that raises the "abandoned session" suspicion
// can be a stale cache emission (a device closed for days boots on the previous run's state).
// Finalizing from it is how such a device could wipe a LIVE session started meanwhile on another
// device — endSession writes activeSession:null blind. These lock the rule: no finalize without a
// server read proving the SAME session (type + startTime) is still live.
describe('confirmSessionOrphanOnServer — no finalize without server proof', () => {
    const suspect = { type: 'break', startTime: '2026-06-23T19:00:00Z' };
    const serverDoc = (data) => ({ exists: () => true, data: () => data });

    beforeEach(() => vi.clearAllMocks());

    it('returns the FRESH user doc when the same session is still live on the server', async () => {
        getDocFromServer.mockResolvedValue(serverDoc({
            activeSession: { type: 'break', startTime: '2026-06-23T19:00:00Z' },
            activeSessionLastHeartbeat: '2026-06-23T20:00:00Z',
        }));
        const fresh = await confirmSessionOrphanOnServer('u1', suspect);
        expect(fresh).toMatchObject({ activeSessionLastHeartbeat: '2026-06-23T20:00:00Z' });
    });

    it('returns null when the server shows the session already closed', async () => {
        getDocFromServer.mockResolvedValue(serverDoc({ activeSession: null }));
        expect(await confirmSessionOrphanOnServer('u1', suspect)).toBeNull();
    });

    it('returns null when a NEW live session replaced the suspected one — the wipe-a-live-session case', async () => {
        // The stale cache said "yesterday's break"; the server says a break started TODAY. Ending
        // "the break" now would kill the live one — the exact cross-device incident class.
        getDocFromServer.mockResolvedValue(serverDoc({
            activeSession: { type: 'break', startTime: '2026-06-24T06:05:00Z' },
        }));
        expect(await confirmSessionOrphanOnServer('u1', suspect)).toBeNull();
    });

    it('returns null when the live session is a different TYPE', async () => {
        getDocFromServer.mockResolvedValue(serverDoc({
            activeSession: { type: 'quickWork', startTime: '2026-06-23T19:00:00Z' },
        }));
        expect(await confirmSessionOrphanOnServer('u1', suspect)).toBeNull();
    });

    it('PROPAGATES a failed server read (offline) — the caller must retry, never trust the cache', async () => {
        getDocFromServer.mockRejectedValue(new Error('unavailable'));
        await expect(confirmSessionOrphanOnServer('u1', suspect)).rejects.toThrow('unavailable');
    });
});

describe('resolvePreBootBeat — only a PRE-BOOT heartbeat is proof of life', () => {
    const START = new Date('2026-06-23T19:00:00Z').getTime();
    const BOOT = new Date('2026-06-24T09:00:00Z').getTime();
    const iso = (ms) => new Date(ms).toISOString();

    it('picks the freshest beat between start and boot (cached vs server-fresh, freshest wins)', () => {
        const older = START + 30 * 60000;
        const newer = START + 90 * 60000;
        expect(resolvePreBootBeat(START, BOOT, iso(older), iso(newer))).toBe(newer);
        expect(resolvePreBootBeat(START, BOOT, iso(newer), iso(older))).toBe(newer);
    });

    it('rejects a POST-boot beat — this device\'s own boot-beat must not credit the dead gap', () => {
        // useSessionHeartbeat stamps a fresh beat immediately at boot, BEFORE recovery decides.
        // Using it as endAt would credit the entire offline stretch up to the reopen instant.
        expect(resolvePreBootBeat(START, BOOT, iso(BOOT + 1000))).toBeNull();
        // ...but a usable pre-boot candidate still wins even when a post-boot one is present.
        const preBoot = START + 60 * 60000;
        expect(resolvePreBootBeat(START, BOOT, iso(preBoot), iso(BOOT + 1000))).toBe(preBoot);
    });

    it('rejects a beat that predates the session start (stale stamp from an earlier session)', () => {
        expect(resolvePreBootBeat(START, BOOT, iso(START - 60000))).toBeNull();
    });

    it('returns null with no usable candidates (missing / unparseable) → caller falls back to end-at-now', () => {
        expect(resolvePreBootBeat(START, BOOT)).toBeNull();
        expect(resolvePreBootBeat(START, BOOT, undefined, 'not-a-date')).toBeNull();
    });
});
