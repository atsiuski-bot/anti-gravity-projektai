import { describe, it, expect, vi, beforeAll } from 'vitest';

// Locks the one invariant the service worker exists to guarantee: a page navigation must always
// RESOLVE with a document. The previous generated worker handed the browser a rejected promise
// whenever its precached shell could not be produced, and a rejected `respondWith` is exactly what
// Chrome renders as ERR_FAILED — "Nepavyksta pasiekti šios svetainės". On a phone that state is
// self-perpetuating: the worker keeps intercepting, so every refresh fails the same way and the
// app is unreachable until site data is cleared by hand.
//
// The worker registers its route at module load, so the test captures the handler workbox is given
// and drives it directly.

const precacheHandler = vi.fn();
let navigationHandler;

vi.mock('workbox-precaching', () => ({
    precacheAndRoute: vi.fn(),
    cleanupOutdatedCaches: vi.fn(),
    createHandlerBoundToURL: vi.fn(() => precacheHandler),
}));

vi.mock('workbox-routing', () => ({
    registerRoute: vi.fn(),
    NavigationRoute: class {
        constructor(handler) {
            navigationHandler = handler;
        }
    },
}));

describe('service worker navigation route', () => {
    beforeAll(async () => {
        // The worker runs in a ServiceWorkerGlobalScope; supply the parts it touches.
        globalThis.self = {
            addEventListener: vi.fn(),
            skipWaiting: vi.fn(),
            registration: { update: vi.fn(() => Promise.resolve()) },
            __WB_MANIFEST: [],
        };
        await import('../sw.js');
    });

    it('serves the precached app shell when it is available', async () => {
        precacheHandler.mockResolvedValueOnce(new Response('<html>app</html>'));

        const response = await navigationHandler({ request: new Request('https://example.test/?tab=my-tasks') });

        expect(await response.text()).toBe('<html>app</html>');
    });

    it('resolves with an offline document instead of rejecting when the shell cannot be produced', async () => {
        precacheHandler.mockRejectedValueOnce(new Error('precache miss and network unreachable'));

        const response = await navigationHandler({ request: new Request('https://example.test/?tab=my-tasks') });

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toContain('text/html');
        expect(await response.text()).toContain('Nepavyko įkelti programos');
    });

    it('asks the browser to reinstall the worker so a wiped precache heals itself', async () => {
        globalThis.self.registration.update.mockClear();
        precacheHandler.mockRejectedValueOnce(new Error('precache miss and network unreachable'));

        await navigationHandler({ request: new Request('https://example.test/') });

        expect(globalThis.self.registration.update).toHaveBeenCalledTimes(1);
    });
});
