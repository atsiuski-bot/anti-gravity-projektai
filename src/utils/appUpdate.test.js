import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceAppUpdate, isStaleChunkLoadError, tryRecoverFromStaleChunk } from './appUpdate';

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

// The shell-destruction gate. `navigator.onLine` staying TRUE while nothing is fetchable (captive
// portal, dead mobile route) is the exact state in which the old gate unregistered the worker and
// deleted the precache — leaving a field worker with no app and no way to stop a running timer.
describe('forceAppUpdate app-shell retention', () => {
    let unregister;
    let cachesDelete;
    let reload;

    // A registration whose update() REJECTS — the failed-update path that reaches the fallback.
    const setupWorker = () => {
        unregister = vi.fn(() => Promise.resolve(true));
        const registration = {
            active: { scriptURL: 'https://app.test/sw.js' },
            waiting: null,
            installing: null,
            update: vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
            unregister,
        };
        vi.stubGlobal('navigator', {
            onLine: true,
            serviceWorker: { getRegistrations: () => Promise.resolve([registration]) },
        });
        cachesDelete = vi.fn(() => Promise.resolve(true));
        vi.stubGlobal('caches', {
            keys: () => Promise.resolve(['workbox-precache-v2-https://app.test/']),
            delete: cachesDelete,
        });
        reload = vi.fn();
        vi.stubGlobal('window', { location: { origin: 'https://app.test', reload } });
    };

    const respondWith = (init) => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
        ok: true,
        redirected: false,
        url: 'https://app.test/sw.js',
        headers: { get: () => 'text/javascript' },
        ...init,
    })));

    it('keeps the offline shell when a captive portal answers the freshness probe with HTML', async () => {
        setupWorker();
        respondWith({ headers: { get: () => 'text/html; charset=utf-8' } });

        await forceAppUpdate();

        expect(unregister).not.toHaveBeenCalled();
        expect(cachesDelete).not.toHaveBeenCalled();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('keeps the offline shell when the freshness probe is redirected to a portal', async () => {
        setupWorker();
        respondWith({ redirected: true, url: 'https://portal.isp.test/login' });

        await forceAppUpdate();

        expect(unregister).not.toHaveBeenCalled();
        expect(cachesDelete).not.toHaveBeenCalled();
    });

    it('keeps the offline shell when the freshness probe throws', async () => {
        setupWorker();
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

        await forceAppUpdate();

        expect(unregister).not.toHaveBeenCalled();
        expect(cachesDelete).not.toHaveBeenCalled();
    });

    it('clears the stale shell only once the current build is positively reachable', async () => {
        setupWorker();
        respondWith({});

        await forceAppUpdate();

        expect(unregister).toHaveBeenCalledTimes(1);
        expect(cachesDelete).toHaveBeenCalledWith('workbox-precache-v2-https://app.test/');
        expect(reload).toHaveBeenCalledTimes(1);
    });
});
