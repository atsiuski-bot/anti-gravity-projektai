import { describe, it, expect } from 'vitest';
import { isTimerEngineEnabledFor, TIMER_ENGINE_CLIENT_CONTRACT } from './timerEngineGate';

// This is the rollout SAFETY policy for an engine that has never run in production and whose output
// is people's pay. Everything here locks a fail-closed property: the legacy path is the proven one,
// so every ambiguity must land there.
describe('isTimerEngineEnabledFor — who gets the canonical engine', () => {
    const CONTRACT = 5;

    it('stays on legacy when the config document is absent or empty', () => {
        expect(isTimerEngineEnabledFor(null, 'u1', CONTRACT)).toBe(false);
        expect(isTimerEngineEnabledFor({}, 'u1', CONTRACT)).toBe(false);
        expect(isTimerEngineEnabledFor({ rollout: {} }, 'u1', CONTRACT)).toBe(false);
    });

    // The load-bearing one. An already-installed bundle reads `enabled` and switches; it cannot be
    // taught otherwise. So `enabled` must never again mean "on" for a current bundle — otherwise
    // turning the engine on for a pilot would ALSO switch every stale phone in the fleet.
    it('IGNORES the legacy `enabled` boolean entirely', () => {
        expect(isTimerEngineEnabledFor({ enabled: true }, 'u1', CONTRACT)).toBe(false);
        // …and a rollout block governs on its own, whatever the legacy field says.
        expect(isTimerEngineEnabledFor({ enabled: false, rollout: { enabled: true } }, 'u1', CONTRACT)).toBe(true);
    });

    it('admits everyone once the rollout is open with no allowlist', () => {
        expect(isTimerEngineEnabledFor({ rollout: { enabled: true } }, 'u1', CONTRACT)).toBe(true);
        expect(isTimerEngineEnabledFor({ rollout: { enabled: true, allowUserIds: [] } }, 'u1', CONTRACT)).toBe(true);
    });

    it('admits ONLY the named workers while an allowlist is present (the pilot phase)', () => {
        const cfg = { rollout: { enabled: true, allowUserIds: ['pilot-1', 'pilot-2'] } };
        expect(isTimerEngineEnabledFor(cfg, 'pilot-1', CONTRACT)).toBe(true);
        expect(isTimerEngineEnabledFor(cfg, 'someone-else', CONTRACT)).toBe(false);
        expect(isTimerEngineEnabledFor(cfg, null, CONTRACT)).toBe(false);
    });

    it('keeps a bundle below the required contract on legacy, even for an allowlisted worker', () => {
        const cfg = { rollout: { enabled: true, minClientContract: 7, allowUserIds: ['pilot-1'] } };
        expect(isTimerEngineEnabledFor(cfg, 'pilot-1', 5)).toBe(false);  // stale PWA
        expect(isTimerEngineEnabledFor(cfg, 'pilot-1', 7)).toBe(true);   // exactly at the floor
        expect(isTimerEngineEnabledFor(cfg, 'pilot-1', 9)).toBe(true);   // newer than required
    });

    it('treats a malformed contract floor as no floor rather than blocking the rollout', () => {
        const cfg = { rollout: { enabled: true, minClientContract: 'soon' } };
        expect(isTimerEngineEnabledFor(cfg, 'u1', CONTRACT)).toBe(true);
    });

    it('ships a contract high enough that any floor excludes pre-rollout bundles', () => {
        // Older bundles have no contract concept at all, so the comparison sees them as 0.
        expect(TIMER_ENGINE_CLIENT_CONTRACT).toBeGreaterThan(0);
    });
});
