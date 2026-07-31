import { describe, it, expect } from 'vitest';
import { formatDisplayName } from './formatters';

// Regression coverage for the surname-initial guard added 2026-06-23: a placeholder
// surname (a lone "-"/"--"/"." from an SSO profile with no real last name) must not
// render as a meaningless "Name -." across the ~20 name surfaces that route through here.
describe('formatDisplayName', () => {
    it('abbreviates a normal two-part name to "First L."', () => {
        expect(formatDisplayName('Jonas Kazlauskas')).toBe('Jonas K.');
    });

    it('uses the LAST token for the initial in a 3+-part name', () => {
        expect(formatDisplayName('First Middle Last')).toBe('First L.');
    });

    it('returns a single-token name unchanged', () => {
        expect(formatDisplayName('Petras')).toBe('Petras');
    });

    it('drops a placeholder dash surname instead of rendering "Name -."', () => {
        expect(formatDisplayName('Jogile -')).toBe('Jogile');
        expect(formatDisplayName('Kęstutis --')).toBe('Kęstutis');
    });

    it('drops other non-letter placeholder surname tokens', () => {
        expect(formatDisplayName('Ona .')).toBe('Ona');
        expect(formatDisplayName('Ona _')).toBe('Ona');
        expect(formatDisplayName('Ona 123')).toBe('Ona');
    });

    it('keeps a Lithuanian-diacritic surname initial', () => {
        expect(formatDisplayName('Jonas Šimkus')).toBe('Jonas Š.');
        expect(formatDisplayName('Eglė Ąžuolaitė')).toBe('Eglė Ą.');
    });

    it('returns an empty string for falsy input', () => {
        expect(formatDisplayName('')).toBe('');
        expect(formatDisplayName(null)).toBe('');
        expect(formatDisplayName(undefined)).toBe('');
    });
});
