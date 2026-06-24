import { describe, it, expect } from 'vitest';
import {
    absenceLabel,
    absenceTypeForWrite,
    normalizeAbsenceType,
    ABSENCE_GENERIC_LABEL,
    ABSENCE_TYPES,
} from './absence';

// The reason-agnostic absence model (2026-06-24) hangs entirely off these pure helpers:
// every NEW absence is written reason-agnostic (neutral default type), yet the load-bearing
// `isVacation` gate and the legacy typed docs must keep reading and labelling correctly. These
// tests pin that contract so a future edit can't silently drift the gate, the default, or the
// label a worker / report / calendar sees.

describe('absenceLabel', () => {
    it('labels a reason-agnostic absence (isVacation only) as the neutral "Nedirba"', () => {
        // A doc carrying only the gate — the new neutral default — must read as "Nedirba", never
        // as a specific reason the platform no longer asserts.
        expect(absenceLabel({ isVacation: true })).toBe('Nedirba');
        expect(ABSENCE_GENERIC_LABEL).toBe('Nedirba');
    });

    it('keeps a legacy typed absence ({ absenceType: "sick" }) reading as "Liga"', () => {
        // Historical sick/holiday/unpaid docs predate the neutral model and must still label
        // truthfully with their own kind.
        expect(absenceLabel({ isVacation: true, absenceType: 'sick' })).toBe('Liga');
    });

    it('labels the explicit neutral default type ("vacation") as "Nedirba"', () => {
        // What every new absence and every legacy isVacation-only doc normalizes to.
        expect(absenceLabel({ isVacation: true, absenceType: 'vacation' })).toBe('Nedirba');
    });

    it('labels the other legacy kinds with their specific labels', () => {
        expect(absenceLabel({ isVacation: true, absenceType: 'holiday' })).toBe('Šventė');
        expect(absenceLabel({ isVacation: true, absenceType: 'unpaid' })).toBe('Neapmokama');
    });

    it('returns null for worked (non-absence) time so callers can branch on it', () => {
        expect(absenceLabel({ isVacation: false })).toBeNull();
        expect(absenceLabel({})).toBeNull();
        expect(absenceLabel(undefined)).toBeNull();
    });

    it('falls back to the neutral label for an unknown/garbage type on an absence', () => {
        expect(absenceLabel({ isVacation: true, absenceType: 'bogus' })).toBe('Nedirba');
    });
});

describe('absenceTypeForWrite', () => {
    it('returns the neutral default type when no reason is supplied (the new-absence path)', () => {
        // The planner writes absences via absenceTypeForWrite(true, undefined); it must persist a
        // valid ABSENCE_TYPES value ("vacation") so workerStats buckets it identically to before —
        // NOT a fresh "unavailable" key that would create an unknown bucket.
        const written = absenceTypeForWrite(true, undefined);
        expect(written).toBe('vacation');
        expect(ABSENCE_TYPES.some((a) => a.value === written)).toBe(true);
    });

    it('preserves a valid legacy reason when one is supplied (editing an old typed absence)', () => {
        expect(absenceTypeForWrite(true, 'sick')).toBe('sick');
        expect(absenceTypeForWrite(true, 'holiday')).toBe('holiday');
    });

    it('coerces an unknown supplied reason to the neutral default', () => {
        expect(absenceTypeForWrite(true, 'bogus')).toBe('vacation');
    });

    it('returns null for worked time (not an absence), so no absenceType is persisted', () => {
        expect(absenceTypeForWrite(false, undefined)).toBeNull();
        expect(absenceTypeForWrite(false, 'sick')).toBeNull();
    });
});

describe('normalizeAbsenceType', () => {
    it('normalizes an isVacation-only doc to the neutral default type', () => {
        expect(normalizeAbsenceType({ isVacation: true })).toBe('vacation');
    });

    it('returns null for worked time', () => {
        expect(normalizeAbsenceType({ isVacation: false })).toBeNull();
    });

    it('keeps a valid legacy type intact', () => {
        expect(normalizeAbsenceType({ isVacation: true, absenceType: 'unpaid' })).toBe('unpaid');
    });
});
