import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// recoveryNotice is a thin window.localStorage carrier. Rather than pull in a DOM environment,
// we back it with a tiny in-memory localStorage stub on globalThis.window (the module only ever
// touches getItem/setItem/removeItem). errorLog is mocked to keep the firebase module graph out
// of this storage-only test.
vi.mock('./errorLog', () => ({ logError: vi.fn() }));

import {
    addRecoveryNotice,
    getRecoveryNotices,
    removeRecoveryNotice,
    clearRecoveryNotices,
} from './recoveryNotice';

const UID = 'u1';

const store = new Map();
const localStorageStub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
};

beforeEach(() => {
    store.clear();
    globalThis.window = { localStorage: localStorageStub };
});

afterEach(() => {
    delete globalThis.window;
});

describe('addRecoveryNotice — dedupe by (kind, taskId)', () => {
    it('collapses two notices of the SAME kind for the same task into one', () => {
        addRecoveryNotice(UID, { kind: 'task', taskId: 't1', minutes: 10 });
        addRecoveryNotice(UID, { kind: 'task', taskId: 't1', minutes: 99 });
        const notices = getRecoveryNotices(UID);
        expect(notices).toHaveLength(1);
        expect(notices[0].minutes).toBe(10); // first wins, the duplicate is dropped
    });

    it('lets a recovered "task" notice and a "task-gap" claim for the same task coexist', () => {
        addRecoveryNotice(UID, { kind: 'task', taskId: 't1', minutes: 10 });
        addRecoveryNotice(UID, { kind: 'task-gap', taskId: 't1', gapMinutes: 20 });
        const notices = getRecoveryNotices(UID);
        expect(notices).toHaveLength(2);
        expect(notices.map((n) => n.kind).sort()).toEqual(['task', 'task-gap']);
    });
});

describe('removeRecoveryNotice — drop one, keep the rest', () => {
    it('removes only the matching (kind, taskId) and returns the remainder', () => {
        addRecoveryNotice(UID, { kind: 'task', taskId: 't1', minutes: 10 });
        addRecoveryNotice(UID, { kind: 'task-gap', taskId: 't1', gapMinutes: 20 });
        addRecoveryNotice(UID, { kind: 'task-gap', taskId: 't2', gapMinutes: 5 });

        const remaining = removeRecoveryNotice(UID, { kind: 'task-gap', taskId: 't1' });

        expect(remaining).toHaveLength(2);
        expect(remaining.some((n) => n.kind === 'task-gap' && n.taskId === 't1')).toBe(false);
        // The persisted store matches what was returned.
        expect(getRecoveryNotices(UID)).toHaveLength(2);
    });

    it('clears the store key entirely when the last notice is removed', () => {
        addRecoveryNotice(UID, { kind: 'task-gap', taskId: 't1', gapMinutes: 20 });
        removeRecoveryNotice(UID, { kind: 'task-gap', taskId: 't1' });
        expect(getRecoveryNotices(UID)).toHaveLength(0);
    });
});

describe('clearRecoveryNotices', () => {
    it('drops everything for the user', () => {
        addRecoveryNotice(UID, { kind: 'task', taskId: 't1', minutes: 10 });
        addRecoveryNotice(UID, { kind: 'task-gap', taskId: 't2', gapMinutes: 5 });
        clearRecoveryNotices(UID);
        expect(getRecoveryNotices(UID)).toHaveLength(0);
    });
});
