import { describe, it, expect } from 'vitest';
import {
    getActiveTaskFlags,
    getTaskFlagTint,
    getTaskFlagRowBg,
    TASK_FLAGS,
} from './taskFlags';

describe('getActiveTaskFlags', () => {
    it('returns nothing for a bare or null task', () => {
        expect(getActiveTaskFlags({})).toEqual([]);
        expect(getActiveTaskFlags(null)).toEqual([]);
    });

    it('returns only the raised flags', () => {
        expect(getActiveTaskFlags({ waiting: true }).map((f) => f.key)).toEqual(['waiting']);
        expect(getActiveTaskFlags({ needsManager: true }).map((f) => f.key)).toEqual(['needsManager']);
    });

    it('orders needsManager before waiting (precedence) when both are raised', () => {
        expect(getActiveTaskFlags({ needsManager: true, waiting: true }).map((f) => f.key))
            .toEqual(['needsManager', 'waiting']);
    });

    it('drops raised flags once a task is finished, accepted, or deleted (no stale glow)', () => {
        expect(getActiveTaskFlags({ needsManager: true, completed: true })).toEqual([]);
        expect(getActiveTaskFlags({ waiting: true, status: 'completed' })).toEqual([]);
        expect(getActiveTaskFlags({ needsManager: true, status: 'confirmed' })).toEqual([]);
        expect(getActiveTaskFlags({ waiting: true, isDeleted: true })).toEqual([]);
        expect(getActiveTaskFlags({ waiting: true, status: 'deleted' })).toEqual([]);
    });

    it('still shows flags on an active (approved / in-progress) task', () => {
        expect(getActiveTaskFlags({ needsManager: true, status: 'approved' }).map((f) => f.key))
            .toEqual(['needsManager']);
        expect(getActiveTaskFlags({ waiting: true, status: 'in-progress' }).map((f) => f.key))
            .toEqual(['waiting']);
    });
});

describe('getTaskFlagTint / getTaskFlagRowBg', () => {
    it('is null when no flag is raised', () => {
        expect(getTaskFlagTint({})).toBeNull();
        expect(getTaskFlagRowBg({})).toBeNull();
    });

    it('needsManager (red) wins over waiting (blue) for the single whole-surface tint', () => {
        const tint = getTaskFlagTint({ needsManager: true, waiting: true });
        expect(tint).toContain(TASK_FLAGS.needsManager.bgClass);
        expect(tint).toContain(TASK_FLAGS.needsManager.borderClass);
        expect(tint).not.toContain(TASK_FLAGS.waiting.bgClass);
    });

    it('waiting alone tints with the info colour', () => {
        expect(getTaskFlagRowBg({ waiting: true })).toBe(TASK_FLAGS.waiting.bgClass);
        expect(getTaskFlagTint({ waiting: true })).toContain(TASK_FLAGS.waiting.borderClass);
    });

    it('the row helper drops the border (table rows use divider lines)', () => {
        expect(getTaskFlagRowBg({ needsManager: true })).toBe(TASK_FLAGS.needsManager.bgClass);
        expect(getTaskFlagRowBg({ needsManager: true })).not.toContain('border');
    });
});
