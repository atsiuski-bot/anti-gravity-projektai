import { describe, it, expect } from 'vitest';
import { isSamsungInternet } from './installBrowser';

const SAMSUNG_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/30.0 Chrome/130.0.0.0 Mobile Safari/537.36';
const CHROME_ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

describe('isSamsungInternet', () => {
    it('detects Samsung Internet on a Samsung phone', () => {
        expect(isSamsungInternet(SAMSUNG_UA)).toBe(true);
    });

    it('does not flag Chrome on the same Samsung phone', () => {
        expect(isSamsungInternet(CHROME_ANDROID_UA)).toBe(false);
    });

    it('does not flag iOS Safari or desktop Chrome', () => {
        expect(isSamsungInternet(IPHONE_UA)).toBe(false);
        expect(isSamsungInternet(WINDOWS_UA)).toBe(false);
    });

    it('treats a missing user agent as not Samsung', () => {
        expect(isSamsungInternet(undefined)).toBe(false);
        expect(isSamsungInternet('')).toBe(false);
    });
});
