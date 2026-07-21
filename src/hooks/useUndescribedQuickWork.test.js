import { describe, it, expect } from 'vitest';
import { isUndescribedQuickWork } from './useUndescribedQuickWork';

// Shape of the placeholder task the quick-work closers create when the worker never got to name
// the session (utils/sessionActions.js and the autoCloseForgottenSessions half of functions/index.js).
const quickWorkTask = (over = {}) => ({
    title: 'Greitas darbas',
    assignedUserId: 'w1',
    isQuickWork: true,
    autoStopped: true,
    completed: true,
    status: 'completed',
    ...over,
});

// Shape of an ordinary, manager-authored task after autoStopForgottenTimers closed its runaway
// timer: `autoStopped` is stamped on the EXISTING doc, and `isQuickWork` is never set.
const forgottenTimerTask = (over = {}) => ({
    title: 'Pakeisti siurblį objekte',
    assignedUserId: 'w1',
    autoStopped: true,
    autoStopReason: 'forgotten-timer-16h',
    autoStoppedAt: '2026-07-20T03:00:00.000Z',
    status: 'in-progress',
    ...over,
});

describe('isUndescribedQuickWork — which tasks may be renamed by the describe prompt', () => {
    it('accepts an unnamed auto-stopped quick-work entry (the feature this prompt exists for)', () => {
        expect(isUndescribedQuickWork(quickWorkTask())).toBe(true);
    });

    it('REJECTS an ordinary task auto-stopped by the 16h forgotten-timer sweep', () => {
        // The data-destruction regression: this task is a real, manager-authored one. Admitting it
        // let addQuickWorkDescription overwrite its title and description with no undo.
        expect(isUndescribedQuickWork(forgottenTimerTask())).toBe(false);
    });

    it('REJECTS a forgotten-timer task even when it was credited to the heartbeat', () => {
        expect(isUndescribedQuickWork(forgottenTimerTask({
            autoStopReason: 'forgotten-timer-16h-credited-to-heartbeat',
            timerMinutes: 480,
        }))).toBe(false);
    });

    it('fails CLOSED on a task that is merely missing the discriminator', () => {
        // Never infer "quick work" from the absence of a marker — renaming is destructive, so an
        // ambiguous record must stay out of the prompt.
        const ambiguous = quickWorkTask();
        delete ambiguous.isQuickWork;
        expect(isUndescribedQuickWork(ambiguous)).toBe(false);
    });

    it('drops an entry once it has been described (autoStopped cleared)', () => {
        expect(isUndescribedQuickWork(quickWorkTask({ autoStopped: false }))).toBe(false);
    });

    it('hides soft-deleted quick work, by flag and by status', () => {
        expect(isUndescribedQuickWork(quickWorkTask({ isDeleted: true }))).toBe(false);
        expect(isUndescribedQuickWork(quickWorkTask({ status: 'deleted' }))).toBe(false);
    });

    it('tolerates a null/undefined task instead of throwing', () => {
        expect(isUndescribedQuickWork(null)).toBe(false);
        expect(isUndescribedQuickWork(undefined)).toBe(false);
    });
});
