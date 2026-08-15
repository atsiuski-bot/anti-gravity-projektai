import { describe, it, expect } from 'vitest';
import {
    medianMinutes,
    planBand,
    improvementVerdict,
    buildPlanVerdict,
    hasVerdictContent,
    MIN_PRIOR_INSTANCES,
    MIN_IMPROVEMENT_RATIO,
    MIN_COMPARABLE_MINUTES,
} from './planPerformance';

describe('medianMinutes', () => {
    it('returns the middle value for an odd count', () => {
        expect(medianMinutes([60, 240, 120])).toBe(120);
    });

    it('averages the two middle values for an even count', () => {
        expect(medianMinutes([60, 120, 180, 240])).toBe(150);
    });

    it('is unmoved by one wild row — the reason this is a median, not a mean', () => {
        expect(medianMinutes([120, 130, 125, 6000])).toBe(127.5);
    });

    it('drops junk instead of poisoning the result', () => {
        expect(medianMinutes([120, null, undefined, NaN, -30, 0, 180])).toBe(150);
    });

    it('returns null when nothing usable is left', () => {
        expect(medianMinutes([])).toBeNull();
        expect(medianMinutes([0, -1])).toBeNull();
        expect(medianMinutes(null)).toBeNull();
    });
});

describe('planBand', () => {
    it('counts landing under the estimate as in-plan', () => {
        expect(planBand(200, 240)).toEqual({ percentOfPlan: 83, band: 'on_plan' });
    });

    it('treats exactly 100% as in-plan, not an overrun', () => {
        expect(planBand(240, 240)).toEqual({ percentOfPlan: 100, band: 'on_plan' });
    });

    it('flags anything past the estimate as over', () => {
        expect(planBand(300, 240)).toEqual({ percentOfPlan: 125, band: 'over' });
    });

    it('gives the same verdict to a fast finish and a very fast one — nothing rewards racing to zero', () => {
        expect(planBand(200, 240).band).toBe(planBand(20, 240).band);
    });

    it('says nothing when the task carried no usable estimate', () => {
        expect(planBand(200, 0)).toBeNull();
        expect(planBand(200, null)).toBeNull();
        expect(planBand(200, undefined)).toBeNull();
    });
});

describe('improvementVerdict', () => {
    // Baseline 240 min; 15% faster is anything at or under 204 min.
    const priors = [240, 240, 240, 250];

    it('reports a real improvement against the worker own median', () => {
        const v = improvementVerdict(180, priors);
        expect(v).toMatchObject({ baselineMinutes: 240, percentFaster: 25, priorCount: 4 });
    });

    it('stays quiet below the improvement threshold', () => {
        // 220 of 240 is ~8% — day-to-day variance, not an achievement.
        expect(improvementVerdict(220, priors)).toBeNull();
    });

    it('accepts a run exactly at the threshold', () => {
        const exact = 240 * (1 - MIN_IMPROVEMENT_RATIO);
        expect(improvementVerdict(exact, priors)).not.toBeNull();
    });

    it('stays quiet until there is enough history for a median to mean anything', () => {
        const tooFew = new Array(MIN_PRIOR_INSTANCES - 1).fill(240);
        expect(improvementVerdict(60, tooFew)).toBeNull();
        expect(improvementVerdict(60, new Array(MIN_PRIOR_INSTANCES).fill(240))).not.toBeNull();
    });

    it('refuses to measure work too short for the measurement to survive noise', () => {
        const shortWork = new Array(4).fill(MIN_COMPARABLE_MINUTES - 1);
        expect(improvementVerdict(1, shortWork)).toBeNull();
    });

    it('NEVER returns a verdict for a slower run — slowness never travels to the worker', () => {
        expect(improvementVerdict(400, priors)).toBeNull();
        expect(improvementVerdict(100000, priors)).toBeNull();
    });

    it('rejects a nonsense current duration', () => {
        expect(improvementVerdict(0, priors)).toBeNull();
        expect(improvementVerdict(NaN, priors)).toBeNull();
    });
});

describe('buildPlanVerdict', () => {
    it('carries both halves when both apply', () => {
        const v = buildPlanVerdict({
            actualMinutes: 180,
            estimatedMinutes: 240,
            priorMinutes: [240, 240, 240],
        });
        expect(v.band).toBe('on_plan');
        expect(v.percentOfPlan).toBe(75);
        expect(v.improvement.percentFaster).toBe(25);
    });

    it('reports an improvement even when the task carried no estimate', () => {
        const v = buildPlanVerdict({
            actualMinutes: 180,
            estimatedMinutes: null,
            priorMinutes: [240, 240, 240],
        });
        expect(v.band).toBeNull();
        expect(v.improvement).not.toBeNull();
    });

    it('reports the plan even when there is no history to compare against', () => {
        const v = buildPlanVerdict({ actualMinutes: 180, estimatedMinutes: 240 });
        expect(v.band).toBe('on_plan');
        expect(v.improvement).toBeNull();
    });

    it('an overrun with no history carries nothing to celebrate but still states the fact', () => {
        const v = buildPlanVerdict({ actualMinutes: 300, estimatedMinutes: 240 });
        expect(v.band).toBe('over');
        expect(v.improvement).toBeNull();
        expect(hasVerdictContent(v)).toBe(true);
    });

    it('is empty when there is neither an estimate nor usable history', () => {
        const v = buildPlanVerdict({ actualMinutes: 180 });
        expect(hasVerdictContent(v)).toBe(false);
    });

    it('survives being called with nothing at all', () => {
        expect(hasVerdictContent(buildPlanVerdict())).toBe(false);
    });
});
