import { describe, it, expect, vi, afterEach } from 'vitest';
import { hasDuplicateRateIds, buildPayRateDoc } from './PayRateModal';

// Two money invariants of the pay-tariff editor, both invisible in the UI when broken:
//
//  1. The saved document must ALWAYS carry the named `rates` set, because that is the only place a
//     tariff's id lives and tasks reference their tariff by id (task.payRateId). When the editor
//     dropped `rates` for a single tariff, every task bound to a deleted tariff silently re-priced
//     against whatever table remained (resolvePayRate falls back to list[0]).
//  2. A tariff id must never repeat. The crypto.randomUUID fallback (plain-http LAN host, where
//     randomUUID does not exist) used to be a module-level counter that restarted at 1 on every
//     page load, so a fresh session re-minted an id an earlier session had already stored.

describe('buildPayRateDoc — the named rate set is never dropped', () => {
    const oneTariff = [{ id: 'rate_a', label: 'Statyba', tiers: [{ fromHours: 0, netRate: 10 }] }];

    it('keeps `rates` (with its ids) even when only ONE tariff is left', () => {
        const doc = buildPayRateDoc(oneTariff);
        expect(doc.rates).toHaveLength(1);
        expect(doc.rates[0].id).toBe('rate_a');
    });

    it('mirrors the first tariff into the legacy `tiers` / `label` fields', () => {
        const doc = buildPayRateDoc(oneTariff);
        expect(doc.tiers).toEqual([{ fromHours: 0, netRate: 10 }]);
        expect(doc.label).toBe('Statyba');
    });

    it('omits an empty label rather than storing a blank one', () => {
        const doc = buildPayRateDoc([{ id: 'rate_a', label: '', tiers: [{ fromHours: 0, netRate: 10 }] }]);
        expect('label' in doc).toBe(false);
        expect(doc.rates[0].id).toBe('rate_a');
    });

    it('keeps every tariff id resolvable when a set shrinks from two to one', () => {
        const before = buildPayRateDoc([
            { id: 'rate_statyba', label: 'Statyba', tiers: [{ fromHours: 0, netRate: 10 }] },
            { id: 'rate_griovimas', label: 'Griovimas', tiers: [{ fromHours: 0, netRate: 25 }] },
        ]);
        // The admin deletes "Statyba"; tasks still carry the Griovimas id and must keep finding it.
        const after = buildPayRateDoc(before.rates.filter((r) => r.id !== 'rate_statyba'));
        expect(after.rates.map((r) => r.id)).toContain('rate_griovimas');
        expect(after.rates.find((r) => r.id === 'rate_griovimas').tiers[0].netRate).toBe(25);
    });
});

describe('hasDuplicateRateIds — a collision must never reach Firestore', () => {
    it('is false for distinct ids', () => {
        expect(hasDuplicateRateIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe(false);
    });

    it('is true when two tariffs share an id', () => {
        expect(hasDuplicateRateIds([{ id: 'rate_1_1' }, { id: 'b' }, { id: 'rate_1_1' }])).toBe(true);
    });
});

describe('mintId — collision-proof without a secure context', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    // A fresh module registry is exactly what a page reload gives the app: any module-level counter
    // starts over. `crypto` without randomUUID is the plain-http LAN host.
    const loadOnInsecureHost = async () => {
        vi.resetModules();
        vi.stubGlobal('crypto', {});
        return import('./PayRateModal');
    };

    it('does not re-mint the same id after a page reload', async () => {
        const session1 = await loadOnInsecureHost();
        const stored = session1.mintId();          // saved to Firestore in an earlier session
        const session2 = await loadOnInsecureHost(); // page reloaded — module state is back to zero
        const minted = session2.mintId();            // a NEW tariff added now
        expect(minted).not.toBe(stored);
        expect(hasDuplicateRateIds([{ id: stored }, { id: minted }])).toBe(false);
    });

    it('mints unique ids within one session', async () => {
        const mod = await loadOnInsecureHost();
        const ids = Array.from({ length: 200 }, () => mod.mintId());
        expect(new Set(ids).size).toBe(ids.length);
    });
});
