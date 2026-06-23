import { describe, it, expect } from 'vitest';
import { titleStemSet, stemSetsSimilar, titlesSimilar } from './titleSimilarity';

describe('titleStemSet', () => {
    it('folds Lithuanian diacritics so spelling variants share stems', () => {
        // "kostiumų" and "kostiumai" both reduce to the stem "kosti"
        expect(titleStemSet('kostiumų').has('kosti')).toBe(true);
        expect(titleStemSet('kostiumai').has('kosti')).toBe(true);
        expect(titleStemSet('Ugnies').has('ugnie')).toBe(true);
    });

    it('drops connective stopwords and short words', () => {
        const s = titleStemSet('ir prie po šou'); // all stopwords or <4 chars
        expect(s.size).toBe(0);
    });

    it('drops generic action-verb stems so the verb never drives a match', () => {
        // "padaryti" -> "padar" is generic and excluded; only the object stem remains
        const s = titleStemSet('Padaryti stovus');
        expect(s.has('padar')).toBe(false);
        expect(s.has('stovu')).toBe(true);
    });
});

describe('stemSetsSimilar / titlesSimilar', () => {
    it('matches differently-worded titles describing the same recurring work', () => {
        expect(
            titlesSimilar('Ugnies šou kostiumų surinkimas', 'Ugnies šou kostiumų aksesuarų taisymas ir gamyba')
        ).toBe(true);
        expect(
            titlesSimilar('Einamosios savaitės kostiumų paruošimas', 'Einamosios savaites renginiu kostiumai')
        ).toBe(true);
        expect(titlesSimilar('Andriaus printai', 'SLA 3D printai')).toBe(true);
    });

    it('does NOT match when only a generic verb is shared', () => {
        // "Padaryti X" vs "Padaryti Y" share only the dropped verb -> not similar
        expect(titlesSimilar('Padaryti stovus', 'Padaryti woolus')).toBe(false);
    });

    it('does NOT match unrelated one-off titles', () => {
        expect(titlesSimilar('Skalbimas', 'Roman candle gun pataisyti')).toBe(false);
        expect(titlesSimilar('Serveteliu atrusiavimas', 'Issiusti siunta vizitines')).toBe(false);
    });

    it('treats empty / single-stem sets safely', () => {
        expect(stemSetsSimilar(new Set(), new Set(['kosti']))).toBe(false);
        // one shared distinctive stem alone is not enough (needs >=2 or Jaccard >= 0.5)
        expect(titlesSimilar('Kostiumų fotografavimas', 'Kostiumotekos svetainės tvarkymas')).toBe(false);
    });
});
