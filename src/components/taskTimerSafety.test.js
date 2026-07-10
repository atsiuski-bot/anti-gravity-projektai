import { describe, it, expect } from 'vitest';

// Pure safety-decision logic for the worker timer net (Branch A). No firebase / React imports here,
// so these run in the plain node test env like the rest of the suite — the component owns the
// wiring, this module owns the rules, and the rules are what must never silently regress.
import {
    classifyCommit,
    commitNeedsRevert,
    checklistFinishWarning,
    canUndoOwnFinish,
} from './taskTimerSafety';

describe('classifyCommit — what really happened to an optimistic timer write', () => {
    it('a thrown write is a failure, regardless of connectivity', () => {
        expect(classifyCommit({ errored: true, wasOffline: false, drained: false })).toBe('failed');
        expect(classifyCommit({ errored: true, wasOffline: true, drained: false })).toBe('failed');
    });

    it('offline + no error = safely queued (not a failure)', () => {
        expect(classifyCommit({ errored: false, wasOffline: true, drained: false })).toBe('queued');
    });

    it('online + queue drained = committed', () => {
        expect(classifyCommit({ errored: false, wasOffline: false, drained: true })).toBe('committed');
    });

    it('online + no acknowledgement in time = queued, so the control stays usable', () => {
        expect(classifyCommit({ errored: false, wasOffline: false, drained: false })).toBe('queued');
    });
});

describe('commitNeedsRevert — which outcomes roll back the optimistic UI + warn', () => {
    it('reverts only on a confirmed failure', () => {
        expect(commitNeedsRevert('failed')).toBe(true);
        expect(commitNeedsRevert('queued')).toBe(false);
    });
    it('does NOT revert on committed or queued', () => {
        expect(commitNeedsRevert('committed')).toBe(false);
        expect(commitNeedsRevert('queued')).toBe(false);
    });
});

describe('checklistFinishWarning — soft, non-blocking nudge', () => {
    it('is silent when there is no checklist', () => {
        expect(checklistFinishWarning(undefined)).toBeNull();
        expect(checklistFinishWarning([])).toBeNull();
    });

    it('is silent when every item is done', () => {
        expect(checklistFinishWarning([{ id: 'a', done: true }, { id: 'b', done: true }])).toBeNull();
    });

    it('counts the remaining items, with singular grammar for exactly one', () => {
        expect(checklistFinishWarning([{ id: 'a', done: true }, { id: 'b', done: false }]))
            .toBe('Liko 1 nebaigtas punktas. Vis tiek užbaigti?');
    });

    it('uses the plural form for more than one remaining', () => {
        expect(checklistFinishWarning([{ id: 'a', done: false }, { id: 'b', done: false }, { id: 'c', done: true }]))
            .toBe('Liko 2 nebaigtų punktų. Vis tiek užbaigti?');
    });
});

describe('canUndoOwnFinish — only the assigned worker may undo', () => {
    it('allows the worker whose task it is', () => {
        expect(canUndoOwnFinish({ assignedUserId: 'u1' }, 'u1')).toBe(true);
    });
    it('refuses a different user (e.g. a manager closing someone else’s task)', () => {
        expect(canUndoOwnFinish({ assignedUserId: 'u1' }, 'mgr')).toBe(false);
    });
    it('refuses when task or uid is missing', () => {
        expect(canUndoOwnFinish(null, 'u1')).toBe(false);
        expect(canUndoOwnFinish({ assignedUserId: 'u1' }, undefined)).toBe(false);
        expect(canUndoOwnFinish({ assignedUserId: undefined }, undefined)).toBe(false);
    });
});
