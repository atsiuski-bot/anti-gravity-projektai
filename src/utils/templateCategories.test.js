import { describe, it, expect } from 'vitest';
import { inferTemplateCategory, getTemplateCategory, CATEGORY_LABELS } from './templateCategories';

const tmpl = (templateName, title) => ({ templateName, data: { title } });

describe('inferTemplateCategory', () => {
    it('maps the real existing templates to sensible categories', () => {
        expect(inferTemplateCategory(tmpl('Pirotechnika', 'Sutvarkyti naudota pirotechnika'))).toBe('piro');
        expect(inferTemplateCategory(tmpl('Sukami fontanai', 'Piro fontanu darymas'))).toBe('piro');
        expect(inferTemplateCategory(tmpl('Fejerverkai', 'Atnesti reikalingus fejerverkus'))).toBe('piro');
        expect(inferTemplateCategory(tmpl('Savaitinis masinu tikrinimas', 'Savaitinis masinu tikrinimas'))).toBe('transportas');
        expect(inferTemplateCategory(tmpl('Naujo Vykdytojo įvedimas', 'Naujo Vykdytojo įvedimas'))).toBe('onboarding');
        expect(inferTemplateCategory(tmpl('Kostiumotekos kliento aptarnavimas', 'Kostiumotekos kliento aptarnavimas'))).toBe('kostiumai');
    });

    it('routes fakyrai to ugnies_sou but fire SCULPTURES to skulpturos (specific beats broad)', () => {
        expect(inferTemplateCategory(tmpl('Giedriaus fakyru tikrinimas', 'fakyru medziagu patikrinimas'))).toBe('ugnies_sou');
        // "ugnies skulpturos" must NOT fall into ugnies_sou (keyed on "ugnies sou"/"fakyr", not bare "ugnies")
        expect(inferTemplateCategory(tmpl('Ugnies skulpturos', 'Paruosti ugnies skulpturas'))).toBe('skulpturos');
    });

    it('falls back to kita when nothing matches', () => {
        expect(inferTemplateCategory(tmpl('Garso komplektu patikrinimas', 'Garso komplektu patikrinimas'))).toBe('kita');
    });

    it('is diacritic-insensitive', () => {
        expect(inferTemplateCategory(tmpl('Mašinų nuoma', 'Mašinos parvežimas'))).toBe('transportas');
    });
});

describe('getTemplateCategory', () => {
    it('prefers an explicit valid category over inference', () => {
        expect(getTemplateCategory({ category: 'gamyba', templateName: 'Pirotechnika', data: { title: 'piro' } })).toBe('gamyba');
    });

    it('ignores an invalid explicit category and infers instead', () => {
        expect(getTemplateCategory({ category: 'not-a-real-id', templateName: 'Pirotechnika', data: { title: 'piro' } })).toBe('piro');
    });

    it('every category id has a label', () => {
        for (const id of ['piro', 'ugnies_sou', 'kostiumai', 'skulpturos', 'palapines', 'transportas', 'gamyba', 'rutinos', 'onboarding', 'kita']) {
            expect(CATEGORY_LABELS[id]).toBeTruthy();
        }
    });
});
