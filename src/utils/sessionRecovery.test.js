import { describe, it, expect } from 'vitest';
import {
    shouldReloadForSessionRecovery,
    recognitionDelayMs,
    SESSION_RECOVERY_RELOAD_COOLDOWN_MS,
    LOGIN_RECOGNITION_WAIT_MS,
    LISTENER_RECOGNITION_WAIT_MS,
} from './sessionRecovery';

describe('shouldReloadForSessionRecovery', () => {
    const now = 1_800_000_000_000;

    it('allows the first recovery reload of a tab', () => {
        expect(shouldReloadForSessionRecovery(null, now)).toBe(true);
    });

    it('refuses a second reload inside the cooldown, so recovery can never loop', () => {
        expect(shouldReloadForSessionRecovery(String(now - 5_000), now)).toBe(false);
        expect(shouldReloadForSessionRecovery(String(now - SESSION_RECOVERY_RELOAD_COOLDOWN_MS + 1), now)).toBe(false);
    });

    it('allows another reload once the cooldown has passed', () => {
        expect(shouldReloadForSessionRecovery(String(now - SESSION_RECOVERY_RELOAD_COOLDOWN_MS), now)).toBe(true);
    });

    it('treats an unreadable or future record as absent rather than blocking recovery forever', () => {
        expect(shouldReloadForSessionRecovery('garbage', now)).toBe(true);
        expect(shouldReloadForSessionRecovery(String(now + 60 * 60 * 1000), now)).toBe(true);
    });
});

describe('recognitionDelayMs', () => {
    it('backs off quickly at first, then settles on a steady interval', () => {
        expect([0, 1, 2, 3, 4, 5, 50].map(recognitionDelayMs)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    });

    it('lets the login flow probe several times before it gives up', () => {
        // Mirror of the loop in AuthContext.readOwnDocOnceRecognised: one probe per delay until the
        // waited total reaches the budget.
        let waited = 0;
        let probes = 0;
        while (waited < LOGIN_RECOGNITION_WAIT_MS) {
            waited += recognitionDelayMs(probes);
            probes += 1;
        }
        expect(probes).toBe(5);
        expect(waited).toBeLessThanOrEqual(20_000);
    });

    it('keeps an open session checking for minutes, not forever', () => {
        expect(LISTENER_RECOGNITION_WAIT_MS).toBeGreaterThan(LOGIN_RECOGNITION_WAIT_MS);
        expect(LISTENER_RECOGNITION_WAIT_MS).toBeLessThanOrEqual(5 * 60 * 1000);
    });
});
