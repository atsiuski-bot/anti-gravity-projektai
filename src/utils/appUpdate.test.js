import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isStaleChunkLoadError, tryRecoverFromStaleChunk } from './appUpdate';

const store = new Map();
const sessionStorageStub = {
    getItem: vi.fn((key) => store.get(key) ?? null),
    setItem: vi.fn((key, value) => store.set(key, String(value))),
};

beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T10:00:00Z'));
    vi.stubGlobal('sessionStorage', sessionStorageStub);
    vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('isStaleChunkLoadError', () => {
    it.each([
        'Failed to fetch dynamically imported module: /assets/Dashboard-old.js',
        'Importing a module script failed.',
        'ChunkLoadError: Loading chunk 42 failed.',
        'Unable to preload CSS for /assets/app-old.css',
    ])('recognizes stale-build asset failures: %s', (message) => {
        expect(isStaleChunkLoadError(new TypeError(message))).toBe(true);
    });

    it('does not classify unrelated application errors as stale assets', () => {
        expect(isStaleChunkLoadError(new Error('Cannot read task title'))).toBe(false);
    });
});

describe('tryRecoverFromStaleChunk', () => {
    const chunkError = new TypeError('Failed to fetch dynamically imported module: /assets/Dashboard-old.js');

    it('starts exactly one automatic refresh inside the cooldown window', () => {
        const refresh = vi.fn(() => Promise.resolve());

        expect(tryRecoverFromStaleChunk(chunkError, refresh)).toBe(true);
        expect(tryRecoverFromStaleChunk(chunkError, refresh)).toBe(false);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('allows another attempt after the cooldown expires', () => {
        const refresh = vi.fn(() => Promise.resolve());

        expect(tryRecoverFromStaleChunk(chunkError, refresh)).toBe(true);
        vi.advanceTimersByTime(60_001);
        expect(tryRecoverFromStaleChunk(chunkError, refresh)).toBe(true);
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('does not destroy an offline app shell when no fresh build can be fetched', () => {
        vi.stubGlobal('navigator', { onLine: false });
        const refresh = vi.fn();

        expect(tryRecoverFromStaleChunk(chunkError, refresh)).toBe(false);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('falls through to the visible error screen when session storage cannot guard against loops', () => {
        sessionStorageStub.getItem.mockImplementation(() => {
            throw new Error('storage blocked');
        });
        const refresh = vi.fn();

        expect(tryRecoverFromStaleChunk(chunkError, refresh)).toBe(false);
        expect(refresh).not.toHaveBeenCalled();
    });
});
