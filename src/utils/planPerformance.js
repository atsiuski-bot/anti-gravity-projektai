/**
 * planPerformance — how a finished task landed against its plan, and against the worker's own
 * past runs of the SAME work.
 *
 * WHY this is shaped the way it is (the reasoning is the important part — the arithmetic is trivial):
 *
 * WORKZ pays by the HOUR, on marginal tiers that RISE with cumulative monthly hours. So working
 * faster costs the worker money twice over. That rules out the obvious design — "praise a smaller
 * percentage of the estimate" — because the cheapest way to win it is to stop the timer while still
 * working, which corrupts payroll, reports and tax data. Every rule below follows from that:
 *
 *   1. NO score for "less time". The band is landing INSIDE the plan (<=100%), full stop. 82% and
 *      31% are the same verdict, so nothing rewards racing toward zero.
 *   2. Speed is only ever judged against the worker's OWN history of the same work, never against
 *      the manager's typed estimate. The estimate is one person's guess entered per task; scoring
 *      against it would measure the manager's generosity and invite negotiating a padded plan.
 *   3. There is NO "slower than usual" verdict. Falling behind already has its own machinery (the
 *      70% warning and the 100% hard stop); a second, retrospective judgement aimed at the worker
 *      would turn the finish screen into a reprimand. Slowness travels to the manager as a question
 *      about the work, not to the worker as a verdict.
 *
 * Deliberately dependency-free arithmetic: the same decision runs client-side (the finish summary,
 * which can afford fuzzy title matching) and is MIRRORED in functions/index.js (which writes the
 * authoritative `planVerdict` onto the task). Keep the two in lockstep — firebaseConsistency.test.js
 * locks the constants.
 *
 * Callers pass ALREADY-SANITISED minute values (see sanitizeReportMinutes): this module only drops
 * non-finite and non-positive numbers, it does not know the 16h session ceiling.
 */

// A comparison needs enough past runs for a median to mean anything. Two points have no middle.
export const MIN_PRIOR_INSTANCES = 3;

// How much faster than the baseline counts as a real improvement rather than day-to-day variance.
export const MIN_IMPROVEMENT_RATIO = 0.15;

// Below this, timing noise dominates: finishing a 10-minute job in 8 is not an achievement, it is
// rounding. Gates on the BASELINE, so short work is excluded from comparison entirely.
export const MIN_COMPARABLE_MINUTES = 30;

const positiveMinutes = (values) =>
    (Array.isArray(values) ? values : [])
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0);

/**
 * Median of a set of durations. Robust to the one wild row a long history always contains — which
 * is exactly why this is a median and not a mean.
 * @returns {number|null} null when there is nothing to average
 */
export function medianMinutes(values) {
    const nums = positiveMinutes(values).sort((a, b) => a - b);
    if (nums.length === 0) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * Where a finished task landed relative to its plan.
 *
 * @returns {{percentOfPlan: number, band: 'on_plan'|'over'}|null}
 *          null when the task carried no usable estimate — then there is no plan to land in, and
 *          the summary must say nothing rather than invent a yardstick.
 */
export function planBand(actualMinutes, estimatedMinutes) {
    const actual = Number(actualMinutes);
    const estimated = Number(estimatedMinutes);
    if (!Number.isFinite(actual) || actual < 0) return null;
    if (!Number.isFinite(estimated) || estimated <= 0) return null;
    const percentOfPlan = Math.round((actual / estimated) * 100);
    // Exactly 100% is landing in the plan, not overrunning it.
    return { percentOfPlan, band: percentOfPlan > 100 ? 'over' : 'on_plan' };
}

/**
 * Did this run beat the worker's own usual time for this kind of work?
 *
 * @param   {number}   actualMinutes  this run's duration
 * @param   {number[]} priorMinutes   durations of prior COMPLETED runs of the same work
 * @returns {{baselineMinutes: number, percentFaster: number, priorCount: number}|null}
 *          null whenever we should stay quiet: too little history, work too short to measure, or
 *          not meaningfully faster. Slower never produces a verdict — see rule 3 above.
 */
export function improvementVerdict(actualMinutes, priorMinutes) {
    const actual = Number(actualMinutes);
    if (!Number.isFinite(actual) || actual <= 0) return null;

    const priors = positiveMinutes(priorMinutes);
    if (priors.length < MIN_PRIOR_INSTANCES) return null;

    const baselineMinutes = medianMinutes(priors);
    if (baselineMinutes === null || baselineMinutes < MIN_COMPARABLE_MINUTES) return null;

    const ratioFaster = (baselineMinutes - actual) / baselineMinutes;
    if (ratioFaster < MIN_IMPROVEMENT_RATIO) return null;

    return {
        baselineMinutes,
        percentFaster: Math.round(ratioFaster * 100),
        priorCount: priors.length,
    };
}

/**
 * The full verdict for one finished task — the single shape the finish summary renders and the
 * Cloud Function denormalises onto the task doc as `planVerdict`.
 *
 * Both halves are independent and either may be null: a task can land in its plan with no history
 * to compare against, or beat its own baseline while carrying no estimate at all.
 */
export function buildPlanVerdict({ actualMinutes, estimatedMinutes, priorMinutes = [] } = {}) {
    const plan = planBand(actualMinutes, estimatedMinutes);
    return {
        actualMinutes: Number.isFinite(Number(actualMinutes)) ? Number(actualMinutes) : null,
        percentOfPlan: plan ? plan.percentOfPlan : null,
        band: plan ? plan.band : null,
        improvement: improvementVerdict(actualMinutes, priorMinutes),
    };
}

/** True when a verdict carries anything worth showing at all. */
export function hasVerdictContent(verdict) {
    return !!verdict && (verdict.band !== null || verdict.improvement !== null);
}
