import { describe, it, expect } from 'vitest';
import { readSignInEnvironment, isPopupSignInBlocked, resolveAuthDomain } from './authEnvironment';

/** Minimal Window stand-in — only the facts the detection and the domain choice actually read. */
const fakeWindow = ({ userAgent = '', maxTouchPoints = 0, displayMode = 'browser', standalone, host } = {}) => ({
    navigator: { userAgent, maxTouchPoints, ...(standalone === undefined ? {} : { standalone }) },
    matchMedia: (query) => ({ matches: query === `(display-mode: ${displayMode})` }),
    ...(host === undefined ? {} : { location: { host } }),
});

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36';

describe('readSignInEnvironment', () => {
    it('reads an iPhone in a plain Safari tab', () => {
        expect(readSignInEnvironment(fakeWindow({ userAgent: IPHONE_UA })))
            .toEqual({ ios: true, standalone: false });
    });

    it('reads an iPhone launched from the Home Screen', () => {
        expect(readSignInEnvironment(fakeWindow({ userAgent: IPHONE_UA, displayMode: 'standalone' })))
            .toEqual({ ios: true, standalone: true });
    });

    it('honours the legacy navigator.standalone flag older iOS still sets', () => {
        expect(readSignInEnvironment(fakeWindow({ userAgent: IPHONE_UA, standalone: true })).standalone)
            .toBe(true);
    });

    it('treats a touch-capable "Macintosh" as iPadOS, which masquerades as desktop Safari', () => {
        expect(readSignInEnvironment(fakeWindow({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).ios)
            .toBe(true);
    });

    it('does not mistake a real Mac for an iPad', () => {
        expect(readSignInEnvironment(fakeWindow({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).ios)
            .toBe(false);
    });
});

describe('isPopupSignInBlocked', () => {
    it('blocks the popup ONLY in the installed iOS app — the null window.opener case', () => {
        expect(isPopupSignInBlocked({ ios: true, standalone: true })).toBe(true);
    });

    it('keeps the popup for iOS Safari in a normal tab', () => {
        expect(isPopupSignInBlocked({ ios: true, standalone: false })).toBe(false);
    });

    it('keeps the popup for an INSTALLED Android/desktop app, where window.opener still works', () => {
        expect(isPopupSignInBlocked(readSignInEnvironment(fakeWindow({ userAgent: ANDROID_UA, displayMode: 'standalone' }))))
            .toBe(false);
        expect(isPopupSignInBlocked(readSignInEnvironment(fakeWindow({ userAgent: WINDOWS_UA, displayMode: 'standalone' }))))
            .toBe(false);
    });

    it('is safe on a missing/partial environment descriptor', () => {
        expect(isPopupSignInBlocked(undefined)).toBe(false);
        expect(isPopupSignInBlocked({})).toBe(false);
    });
});

describe('resolveAuthDomain', () => {
    const HOSTED = 'darbo-planavimas.firebaseapp.com';

    it('serves the helper from OUR origin in the installed iOS app, where a cross-origin one cannot work', () => {
        const win = fakeWindow({ userAgent: IPHONE_UA, displayMode: 'standalone', host: 'app.example.com' });
        expect(resolveAuthDomain(HOSTED, win)).toBe('app.example.com');
    });

    it('keeps Firebase\'s hosted helper for iOS Safari in a normal tab', () => {
        const win = fakeWindow({ userAgent: IPHONE_UA, host: 'app.example.com' });
        expect(resolveAuthDomain(HOSTED, win)).toBe(HOSTED);
    });

    it('leaves every other browser untouched — including an INSTALLED Android/desktop app', () => {
        for (const userAgent of [ANDROID_UA, WINDOWS_UA]) {
            const win = fakeWindow({ userAgent, displayMode: 'standalone', host: 'app.example.com' });
            expect(resolveAuthDomain(HOSTED, win)).toBe(HOSTED);
        }
    });

    // Every uncertain case must land on the hosted helper: it is the only one that can work when
    // we do not know what origin we are on, and picking wrong here breaks sign-in for everyone.
    it('falls back to the hosted helper when there is no DOM or no host to self-host from', () => {
        expect(resolveAuthDomain(HOSTED, undefined)).toBe(HOSTED);
        expect(resolveAuthDomain(HOSTED, {})).toBe(HOSTED);
        // Installed iOS, but the host is unreadable — must NOT return an empty authDomain.
        expect(resolveAuthDomain(HOSTED, fakeWindow({ userAgent: IPHONE_UA, displayMode: 'standalone' })))
            .toBe(HOSTED);
    });
});
