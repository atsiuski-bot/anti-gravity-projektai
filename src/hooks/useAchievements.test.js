import { describe, it, expect } from 'vitest';
import { deriveProgress, STAT_FIELD_BY_KEY } from './useAchievements';
import { BADGE_CATALOG } from '../utils/badgeCatalog';

// The hook's React wiring (onSnapshot/useState/useMemo) needs no harness here — what is unique
// and purely testable is the tier-boundary maths in deriveProgress and the client<->server
// _stats field bridge in STAT_FIELD_BY_KEY. Both are exercised directly.
//
// `follow_through` is the boundary fixture: thresholds [1, 10, 40, 120], counter `completedTasks`.
// Picking concrete counts around those thresholds proves the off-by-one tier edges; the missing /
// at-max cases prove the two ends of the ladder.

const FT = 'follow_through';
const FT_FIELD = STAT_FIELD_BY_KEY[FT]; // 'completedTasks'
const FT_THRESHOLDS = BADGE_CATALOG.find((d) => d.key === FT).thresholds; // [1, 10, 40, 120]

const progressFor = (count) => deriveProgress({ [FT_FIELD]: count })[FT];

describe('deriveProgress — tier boundaries (follow_through: [1, 10, 40, 120])', () => {
    it('treats a missing counter as count 0, tier 0, aiming at the first threshold', () => {
        // No _stats at all (engine never fired) is the same honest empty start as an explicit 0.
        const fromNull = deriveProgress(null)[FT];
        const fromZero = progressFor(0);
        expect(fromNull).toEqual(fromZero);
        expect(fromZero).toMatchObject({
            count: 0,
            tier: 0,
            prevThreshold: 0,
            nextThreshold: FT_THRESHOLDS[0], // 1
            nextTier: 1,
            atMax: false,
        });
    });

    it('crosses into tier 1 exactly AT the first threshold (>= boundary, not >)', () => {
        // Just below the first threshold is still tier 0...
        expect(progressFor(0)).toMatchObject({ tier: 0, nextThreshold: 1 });
        // ...and landing exactly on it promotes to tier 1, now aiming at the second threshold.
        expect(progressFor(FT_THRESHOLDS[0])).toMatchObject({
            count: 1,
            tier: 1,
            prevThreshold: FT_THRESHOLDS[0], // 1
            nextThreshold: FT_THRESHOLDS[1], // 10
            nextTier: 2,
            atMax: false,
        });
    });

    it('reports the surrounding band for a mid-band count between two thresholds', () => {
        // 25 sits inside the silver band [10, 40): tier 2, prev 10, aiming at 40 (tier 3).
        expect(progressFor(25)).toMatchObject({
            count: 25,
            tier: 2,
            prevThreshold: FT_THRESHOLDS[1], // 10
            nextThreshold: FT_THRESHOLDS[2], // 40
            nextTier: 3,
            atMax: false,
        });
    });

    it('caps at the top tier (atMax) once the final threshold is met or exceeded', () => {
        const top = FT_THRESHOLDS.length; // 4
        // Exactly on the final threshold is already maxed.
        expect(progressFor(FT_THRESHOLDS[top - 1])).toMatchObject({
            count: FT_THRESHOLDS[top - 1], // 120
            tier: top, // 4
            nextTier: top, // does not advance past the top
            nextThreshold: FT_THRESHOLDS[top - 1], // stays the final threshold, never an unreachable target
            atMax: true,
        });
        // Beyond the final threshold stays maxed (no fifth tier exists).
        const beyond = progressFor(FT_THRESHOLDS[top - 1] + 50);
        expect(beyond).toMatchObject({ tier: top, nextTier: top, atMax: true });
    });
});

describe('STAT_FIELD_BY_KEY — client<->server _stats bridge', () => {
    it('maps every BADGE_CATALOG key to a non-empty _stats field name (no silent gaps)', () => {
        // A missing mapping would make deriveProgress read undefined and silently render an
        // empty bar for a real badge — so assert the bridge spans the whole catalog.
        BADGE_CATALOG.forEach((def) => {
            expect(
                STAT_FIELD_BY_KEY[def.key],
                `BADGE_CATALOG key "${def.key}" has no STAT_FIELD_BY_KEY mapping`,
            ).toEqual(expect.any(String));
            expect(STAT_FIELD_BY_KEY[def.key].length).toBeGreaterThan(0);
        });
    });

    it('has no orphan mappings pointing at keys the catalog no longer defines', () => {
        // The reverse guard: a stat field left behind after a badge is removed would be dead drift.
        const catalogKeys = new Set(BADGE_CATALOG.map((d) => d.key));
        Object.keys(STAT_FIELD_BY_KEY).forEach((key) => {
            expect(catalogKeys.has(key), `STAT_FIELD_BY_KEY has orphan key "${key}"`).toBe(true);
        });
    });

    it('produces a progress entry for every catalog badge (the map and the bridge agree)', () => {
        const out = deriveProgress({});
        BADGE_CATALOG.forEach((def) => {
            expect(out[def.key]).toBeDefined();
            expect(out[def.key]).toMatchObject({ count: 0, tier: 0, atMax: false });
        });
    });
});
