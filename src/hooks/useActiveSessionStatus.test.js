import { describe, it, expect, vi } from 'vitest';

// Only the pure derivation is exercised here; the hook's React wiring (useMemo over useAuth) is a
// thin wrapper. AuthContext is mocked so the module loads in the node environment.
vi.mock('../context/AuthContext', () => ({ useAuth: vi.fn(() => ({ userData: null })) }));

import { deriveSessionStatus } from './useActiveSessionStatus';

describe('deriveSessionStatus — what blocks the task timer', () => {
    it('reports no active session for empty / null user data', () => {
        expect(deriveSessionStatus(null)).toEqual({
            isSecondarySessionActive: false, isTaskActive: false, activeSessionType: null,
        });
        expect(deriveSessionStatus({})).toEqual({
            isSecondarySessionActive: false, isTaskActive: false, activeSessionType: null,
        });
    });

    it('blocks on a canonical activeSession of each secondary type', () => {
        for (const type of ['break', 'call', 'quickWork']) {
            const s = deriveSessionStatus({ activeSession: { type, startTime: 'T' } });
            expect(s.isSecondarySessionActive).toBe(true);
            expect(s.activeSessionType).toBe(type);
        }
    });

    // The regression this fixes: a worker stuck unable to start/finish a task because a stale
    // legacy break/call/quick-work flag lingered with NO activeSession. Such a remnant must NOT
    // block the timer (it is invisible — the loud session colour is activeSession-driven).
    it('does NOT block on a stale legacy secondary flag when there is no activeSession', () => {
        expect(deriveSessionStatus({ breakState: { isTakingBreak: true, lastStartedAt: 'B' } })
            .isSecondarySessionActive).toBe(false);
        expect(deriveSessionStatus({ callState: { isCalling: true, lastStartedAt: 'C' } })
            .isSecondarySessionActive).toBe(false);
        expect(deriveSessionStatus({ quickWorkState: { isQuickWorking: true, lastStartedAt: 'Q' } })
            .isSecondarySessionActive).toBe(false);
    });

    it('a task activeSession is task-active, never a secondary block', () => {
        const s = deriveSessionStatus({ activeSession: { type: 'task', taskId: 'x', startTime: 'T' } });
        expect(s.isSecondarySessionActive).toBe(false);
        expect(s.isTaskActive).toBe(true);
        expect(s.activeSessionType).toBe('task');
    });

    it('still reflects a legacy running task via workStatus (separate signal)', () => {
        const s = deriveSessionStatus({ workStatus: { status: 'running', activeTaskId: 't' } });
        expect(s.isTaskActive).toBe(true);
        expect(s.isSecondarySessionActive).toBe(false);
        expect(s.activeSessionType).toBe('task');
    });

    it('a live secondary activeSession wins over a stale legacy task flag', () => {
        const s = deriveSessionStatus({
            activeSession: { type: 'break', startTime: 'NEW' },
            workStatus: { status: 'running', activeTaskId: 'old' },
        });
        expect(s.isSecondarySessionActive).toBe(true);
        expect(s.activeSessionType).toBe('break');
    });
});
