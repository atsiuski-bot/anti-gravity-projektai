// payRate.js — per-worker tiered pay rates + the Lithuanian individual-activity (individuali
// veikla pagal pažymą) tax model that turns the admin-entered NET hourly rates into the GROSS
// (with-tax) figures a worker is shown after finishing work.
//
// WHY a single effective rate instead of the full progressive engine: a Vykdytojas is a
// freelancer whose TOTAL annual income is not visible to WORKZ (they may invoice other clients),
// so tracking year-to-date income here and applying the real GPM progression would be both
// fragile and misleading — the same job would "earn" a different net depending on when in the
// year it was done. Per the product decision (2026-06-23, ADR 0012) we derive ONE orientation
// rate from a fixed assumption: annual taxable income = ASSUMED_ANNUAL_INCOME, with NO
// allowable-expense deduction (taxed on the full amount). Everything below is plain arithmetic
// from that anchor, so the rate is auditable and a one-line change if the assumption ever moves.
//
// 2026 Lithuanian rules used (verified against fin24.lt / financiallithuanians.lt / 77.lt):
//   • GPM (income tax): progressive credit — effective 5% up to €20,000 taxable, rising on a
//     fixed slope to 20% at €42,500, flat above. At €30,000 this resolves to 11.667%.
//   • Sodra: VSD 12.52% + PSD 6.98% = 19.5%, charged on a base of 90% of taxable income.
//   • No expense deduction (product decision) → taxable income == revenue.
// At ASSUMED_ANNUAL_INCOME = €30,000 this yields ≈ 29.22% total, i.e. net ≈ 70.78% of gross.

// --- Tax assumption knobs (re-baseline by changing ONLY these) ------------------------------
const ASSUMED_ANNUAL_INCOME = 30000;   // EUR/year — the orientation income level
const EXPENSE_DEDUCTION_RATE = 0;      // 0 = no allowable-expense deduction (taxed on full amount)
const GPM_LOW_RATE = 0.05;             // effective GPM at/under the lower threshold
const GPM_HIGH_RATE = 0.20;            // effective GPM at/over the upper threshold (2026 reform)
const GPM_LOWER_THRESHOLD = 20000;     // EUR taxable — below this, flat 5%
const GPM_UPPER_THRESHOLD = 42500;     // EUR taxable — above this, flat 20%
const VSD_RATE = 0.1252;               // valstybinis socialinis draudimas (state social insurance)
const PSD_RATE = 0.0698;               // privalomasis sveikatos draudimas (compulsory health)
const SODRA_BASE_FRACTION = 0.90;      // Sodra is charged on 90% of taxable income

// Effective GPM rate at a given annual taxable income. The progressive credit linearises the
// EFFECTIVE rate between the two thresholds (the slope is identical under both the pre-2026 and
// the 2026 framing, so €30k resolves to 11.667% either way).
function gpmEffectiveRate(taxable) {
    if (taxable <= GPM_LOWER_THRESHOLD) return GPM_LOW_RATE;
    if (taxable >= GPM_UPPER_THRESHOLD) return GPM_HIGH_RATE;
    const slope = (GPM_HIGH_RATE - GPM_LOW_RATE) / (GPM_UPPER_THRESHOLD - GPM_LOWER_THRESHOLD);
    return GPM_LOW_RATE + slope * (taxable - GPM_LOWER_THRESHOLD);
}

// Derived ONCE at module load from the assumption above.
const TAXABLE = ASSUMED_ANNUAL_INCOME * (1 - EXPENSE_DEDUCTION_RATE);
const GPM_AMOUNT = TAXABLE * gpmEffectiveRate(TAXABLE);
const SODRA_AMOUNT = TAXABLE * SODRA_BASE_FRACTION * (VSD_RATE + PSD_RATE);

// The single orientation effective tax rate (fraction of gross). ≈ 0.2922.
export const EFFECTIVE_TAX_RATE = (GPM_AMOUNT + SODRA_AMOUNT) / ASSUMED_ANNUAL_INCOME;
// Fraction of a gross amount the worker keeps after tax. ≈ 0.7078.
export const NET_RETENTION = 1 - EFFECTIVE_TAX_RATE;

// The admin enters NET (take-home) rates; this lifts a net amount to its gross (with-tax)
// equivalent. grossToNet is the inverse, kept for symmetry / display.
export const netToGross = (net) => (Number.isFinite(net) && NET_RETENTION > 0 ? net / NET_RETENTION : 0);
export const grossToNet = (gross) => (Number.isFinite(gross) ? gross * NET_RETENTION : 0);

// --- Tier table -----------------------------------------------------------------------------
// A worker's pay is a marginal (progressive) table keyed on CUMULATIVE worked hours within the
// calendar month: each tier sets the NET hourly rate for the hours from its `fromHours`
// threshold up to the next tier's threshold. The first tier MUST start at 0; the last is
// open-ended. "Marginal" = crossing into a higher tier re-prices only the hours ABOVE that
// tier's threshold, never the earlier ones (the user's "tik perlipusioms valandoms").

// True when a config carries a usable tier table.
export const hasPayRate = (payRate) =>
    !!payRate && Array.isArray(payRate.tiers) && payRate.tiers.length > 0;

// Normalise to a clean ascending list of {fromHours, netRate}: coerce numbers, drop junk rows,
// sort, and force the lowest tier to start at 0 so there is never an un-priced gap at the bottom.
export const normalizeTiers = (tiers) => {
    if (!Array.isArray(tiers)) return [];
    const clean = tiers
        .map((t) => ({ fromHours: Number(t?.fromHours), netRate: Number(t?.netRate) }))
        .filter((t) => Number.isFinite(t.fromHours) && t.fromHours >= 0 && Number.isFinite(t.netRate) && t.netRate >= 0)
        .sort((a, b) => a.fromHours - b.fromHours);
    if (clean.length > 0) clean[0].fromHours = 0;
    return clean;
};

// Validate a tier table for SAVING (admin editor). Returns null when OK, else a Lithuanian
// error string. Rules: ≥1 tier, first starts at 0, thresholds strictly ascending, rates > 0.
export const validateTiers = (tiers) => {
    if (!Array.isArray(tiers) || tiers.length === 0) return 'Pridėkite bent vieną rėžį.';
    for (let i = 0; i < tiers.length; i += 1) {
        const from = Number(tiers[i].fromHours);
        const rate = Number(tiers[i].netRate);
        if (!Number.isFinite(rate) || rate <= 0) return 'Kiekvieno rėžio įkainis turi būti didesnis už 0.';
        if (i === 0) {
            if (from !== 0) return 'Pirmas rėžis turi prasidėti nuo 0 val.';
        } else if (!Number.isFinite(from) || from <= Number(tiers[i - 1].fromHours)) {
            return 'Rėžių valandos turi didėti — kiekvienas kitas rėžis prasideda vėliau.';
        }
    }
    return null;
};

// Marginal NET earnings for the hour slice (fromHours, toHours] across the tier table — i.e. the
// value this chunk of work adds on top of the month's already-worked hours. Pure integration of
// the per-tier net rate over the slice.
export const marginalNetEarnings = (fromHours, toHours, tiers) => {
    const t = normalizeTiers(tiers);
    if (t.length === 0 || !(toHours > fromHours)) return 0;
    let total = 0;
    for (let i = 0; i < t.length; i += 1) {
        const lo = t[i].fromHours;
        const hi = i + 1 < t.length ? t[i + 1].fromHours : Infinity;
        const overlap = Math.max(0, Math.min(toHours, hi) - Math.max(fromHours, lo));
        total += overlap * t[i].netRate;
    }
    return total;
};
