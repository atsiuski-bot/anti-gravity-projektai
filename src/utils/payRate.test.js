import { describe, it, expect } from 'vitest';
import {
    EFFECTIVE_TAX_RATE,
    NET_RETENTION,
    netToGross,
    grossToNet,
    hasPayRate,
    normalizeTiers,
    validateTiers,
    marginalNetEarnings,
} from './payRate';

// Characterization coverage for the pay-rate model (ADR 0012, 2026-06-23): the admin enters NET
// hourly rates and the worker is shown the GROSS (with-tax) equivalent via a single orientation
// effective tax rate (≈29.22%) derived once from a fixed annual-income assumption. These tests
// pin the CURRENT arithmetic and the marginal tier integration so a future re-baseline (changing
// the tax knobs) or a tier-table refactor can't silently drift what a worker is paid or shown.

describe('EFFECTIVE_TAX_RATE / NET_RETENTION', () => {
    it('resolves the ADR 0012 orientation rate to ≈29.22% (net keeps ≈70.78%)', () => {
        // GPM at €30k taxable = 3500 (effective 11.667%); Sodra = 30000*0.9*0.195 = 5265.
        // (3500 + 5265) / 30000 = 0.292166…  →  retention 0.707833…
        expect(EFFECTIVE_TAX_RATE).toBeCloseTo(0.292166, 5);
        expect(NET_RETENTION).toBeCloseTo(0.707833, 5);
    });

    it('keeps the two constants complementary (tax + retention === 1)', () => {
        expect(EFFECTIVE_TAX_RATE + NET_RETENTION).toBeCloseTo(1, 12);
    });
});

describe('netToGross / grossToNet', () => {
    it('lifts a net amount to its gross equivalent (net / retention)', () => {
        // 100 net at ≈70.78% retention grosses up to ≈141.28.
        expect(netToGross(100)).toBeCloseTo(100 / NET_RETENTION, 9);
        expect(netToGross(100)).toBeCloseTo(141.276, 3);
    });

    it('drops a gross amount to its net equivalent (gross * retention)', () => {
        expect(grossToNet(100)).toBeCloseTo(100 * NET_RETENTION, 9);
        expect(grossToNet(100)).toBeCloseTo(70.783, 3);
    });

    it('round-trips a value through gross→net→gross', () => {
        expect(netToGross(grossToNet(250))).toBeCloseTo(250, 9);
    });

    it('maps zero to zero in both directions', () => {
        expect(netToGross(0)).toBe(0);
        expect(grossToNet(0)).toBe(0);
    });

    it('returns 0 for non-finite input rather than NaN/Infinity', () => {
        // Guards the display path against junk (missing/garbage rate) leaking a NaN to the UI.
        expect(netToGross(NaN)).toBe(0);
        expect(netToGross(Infinity)).toBe(0);
        expect(netToGross(undefined)).toBe(0);
        expect(grossToNet(NaN)).toBe(0);
        expect(grossToNet(Infinity)).toBe(0);
        expect(grossToNet(undefined)).toBe(0);
    });

    it('scales linearly with the input', () => {
        expect(netToGross(200)).toBeCloseTo(2 * netToGross(100), 9);
        expect(grossToNet(200)).toBeCloseTo(2 * grossToNet(100), 9);
    });
});

describe('hasPayRate', () => {
    it('is true only for a config carrying a non-empty tiers array', () => {
        expect(hasPayRate({ tiers: [{ fromHours: 0, netRate: 10 }] })).toBe(true);
    });

    it('is false for missing config, missing tiers, or an empty/invalid tiers field', () => {
        expect(hasPayRate(null)).toBe(false);
        expect(hasPayRate(undefined)).toBe(false);
        expect(hasPayRate({})).toBe(false);
        expect(hasPayRate({ tiers: [] })).toBe(false);
        expect(hasPayRate({ tiers: 'nope' })).toBe(false);
    });
});

describe('normalizeTiers', () => {
    it('coerces, sorts ascending, and forces the lowest tier to start at 0', () => {
        // Out-of-order, with the lowest threshold non-zero — the bottom must be pulled to 0 so
        // there is never an un-priced gap at the start of the month.
        const out = normalizeTiers([
            { fromHours: '40', netRate: '15' },
            { fromHours: '8', netRate: '10' },
        ]);
        expect(out).toEqual([
            { fromHours: 0, netRate: 10 },
            { fromHours: 40, netRate: 15 },
        ]);
    });

    it('drops junk rows (NaN, negative hours/rates)', () => {
        const out = normalizeTiers([
            { fromHours: 0, netRate: 10 },
            { fromHours: -5, netRate: 12 },
            { fromHours: 20, netRate: -1 },
            { fromHours: 'x', netRate: 14 },
        ]);
        expect(out).toEqual([{ fromHours: 0, netRate: 10 }]);
    });

    it('keeps a zero rate (>= 0 is allowed; only negatives are junk)', () => {
        const out = normalizeTiers([{ fromHours: 0, netRate: 0 }]);
        expect(out).toEqual([{ fromHours: 0, netRate: 0 }]);
    });

    it('returns [] for a non-array input', () => {
        expect(normalizeTiers(null)).toEqual([]);
        expect(normalizeTiers(undefined)).toEqual([]);
        expect(normalizeTiers('tiers')).toEqual([]);
    });
});

describe('validateTiers', () => {
    it('returns null for a valid ascending table starting at 0 with rates > 0', () => {
        expect(validateTiers([
            { fromHours: 0, netRate: 10 },
            { fromHours: 40, netRate: 15 },
        ])).toBeNull();
    });

    it('rejects an empty / non-array table', () => {
        expect(validateTiers([])).toBe('Pridėkite bent vieną rėžį.');
        expect(validateTiers(null)).toBe('Pridėkite bent vieną rėžį.');
    });

    it('rejects a zero or negative rate', () => {
        expect(validateTiers([{ fromHours: 0, netRate: 0 }]))
            .toBe('Kiekvieno rėžio įkainis turi būti didesnis už 0.');
        expect(validateTiers([{ fromHours: 0, netRate: -1 }]))
            .toBe('Kiekvieno rėžio įkainis turi būti didesnis už 0.');
    });

    it('requires the first tier to start exactly at 0', () => {
        expect(validateTiers([{ fromHours: 5, netRate: 10 }]))
            .toBe('Pirmas rėžis turi prasidėti nuo 0 val.');
    });

    it('requires strictly ascending thresholds', () => {
        expect(validateTiers([
            { fromHours: 0, netRate: 10 },
            { fromHours: 40, netRate: 15 },
            { fromHours: 40, netRate: 20 },
        ])).toBe('Rėžių valandos turi didėti — kiekvienas kitas rėžis prasideda vėliau.');
    });
});

describe('marginalNetEarnings', () => {
    const tiers = [
        { fromHours: 0, netRate: 10 },
        { fromHours: 40, netRate: 15 },
        { fromHours: 60, netRate: 20 },
    ];

    it('prices a slice entirely within the first tier', () => {
        // Hours 0→8, all at €10/h.
        expect(marginalNetEarnings(0, 8, tiers)).toBe(80);
    });

    it('prices marginally across a tier boundary (only hours above re-price)', () => {
        // 38→44: 2h @10 (38→40) + 4h @15 (40→44) = 20 + 60 = 80.
        expect(marginalNetEarnings(38, 44, tiers)).toBe(80);
    });

    it('integrates a slice spanning all three tiers', () => {
        // 0→70: 40@10 + 20@15 + 10@20 = 400 + 300 + 200 = 900.
        expect(marginalNetEarnings(0, 70, tiers)).toBe(900);
    });

    it('treats the last tier as open-ended (large hours)', () => {
        // 60→1060 is 1000h all in the top tier @20 = 20000.
        expect(marginalNetEarnings(60, 1060, tiers)).toBe(20000);
    });

    it('is exactly on a boundary: a zero-width slice earns 0', () => {
        expect(marginalNetEarnings(40, 40, tiers)).toBe(0);
    });

    it('returns 0 when toHours <= fromHours (no work, or reversed range)', () => {
        expect(marginalNetEarnings(20, 10, tiers)).toBe(0);
        expect(marginalNetEarnings(10, 10, tiers)).toBe(0);
    });

    it('returns 0 when there is no usable tier table', () => {
        expect(marginalNetEarnings(0, 10, [])).toBe(0);
        expect(marginalNetEarnings(0, 10, null)).toBe(0);
    });

    it('respects normalization: a non-zero lowest threshold still prices from 0', () => {
        // The lowest tier is pulled to 0, so 0→8 prices at that tier's rate.
        const shifted = [{ fromHours: 8, netRate: 12 }];
        expect(marginalNetEarnings(0, 8, shifted)).toBe(96);
    });
});
