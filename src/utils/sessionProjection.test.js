import { describe, expect, it } from 'vitest';
import { applyPendingSessionProjection } from './sessionProjection';

describe('applyPendingSessionProjection', () => {
    const confirmed = {
        displayName: 'Server Name',
        role: 'worker',
        themePreference: 'dark',
        activeSession: null,
        workStatus: { isWorking: false, status: 'idle', activeTaskId: null },
        breakState: { isTakingBreak: false, dailyAccumulatedMinutes: 12 },
    };

    it('projects only session fields and cannot hide newer profile data', () => {
        const projected = applyPendingSessionProjection(confirmed, {
            displayName: 'Stale Name',
            role: 'admin',
            activeSession: {
                type: 'task',
                taskId: 'task-a',
                startTime: '2026-07-09T08:00:00.000Z',
            },
            workStatus: { isWorking: true, status: 'running', activeTaskId: 'task-a' },
        });

        expect(projected.displayName).toBe('Server Name');
        expect(projected.role).toBe('worker');
        expect(projected.activeSession.taskId).toBe('task-a');
        expect(projected.workStatus).toMatchObject({
            isWorking: true,
            status: 'running',
            activeTaskId: 'task-a',
        });
    });

    it('merges a narrow nested projection without dropping confirmed sibling fields', () => {
        const projected = applyPendingSessionProjection(confirmed, {
            breakState: { isTakingBreak: true },
        });

        expect(projected.breakState).toEqual({
            isTakingBreak: true,
            dailyAccumulatedMinutes: 12,
        });
    });

    it('supports an explicit idle projection and no-op clearing', () => {
        expect(applyPendingSessionProjection(confirmed, {
            activeSession: null,
        }).activeSession).toBeNull();
        expect(applyPendingSessionProjection(confirmed, null)).toBe(confirmed);
    });
});
