import { describe, it, expect } from 'vitest';
import { readSignInEnvironment, isPopupSignInBlocked } from './authEnvironment';

/** Minimal Window stand-in — only the three facts the detection actually reads. */
const fakeWindow = ({ userAgent = '', maxTouchPoints = 0, displayMode = 'browser', standalone } = {}) => ({
    navigator: { userAgent, maxTouchPoints, ...(standalone === undefined ? {} : { standalone }) },
    matchMedia: (query) => ({ matches: query === `(display-mode: ${displayMode})` }),
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
