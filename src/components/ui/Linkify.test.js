import { describe, it, expect } from 'vitest';
import { splitTextWithLinks } from '../../utils/linkify';

describe('splitTextWithLinks', () => {
    it('returns a single text part when there is no URL', () => {
        expect(splitTextWithLinks('just a plain note')).toEqual([
            { type: 'text', value: 'just a plain note' },
        ]);
    });

    it('returns [] for empty or non-string input', () => {
        expect(splitTextWithLinks('')).toEqual([]);
        expect(splitTextWithLinks(null)).toEqual([]);
        expect(splitTextWithLinks(undefined)).toEqual([]);
    });

    it('extracts an https URL surrounded by text', () => {
        expect(splitTextWithLinks('see https://drive.google.com/x here')).toEqual([
            { type: 'text', value: 'see ' },
            { type: 'link', value: 'https://drive.google.com/x', href: 'https://drive.google.com/x' },
            { type: 'text', value: ' here' },
        ]);
    });

    it('prefixes https:// onto a bare www. link for the href but keeps the visible text', () => {
        const parts = splitTextWithLinks('www.workz.lt');
        expect(parts).toEqual([
            { type: 'link', value: 'www.workz.lt', href: 'https://www.workz.lt' },
        ]);
    });

    it('peels trailing sentence punctuation off the link', () => {
        expect(splitTextWithLinks('open http://a.lt.')).toEqual([
            { type: 'text', value: 'open ' },
            { type: 'link', value: 'http://a.lt', href: 'http://a.lt' },
            { type: 'text', value: '.' },
        ]);
    });

    it('keeps a link wrapped in parentheses intact, punctuation outside', () => {
        expect(splitTextWithLinks('(https://a.lt)')).toEqual([
            { type: 'text', value: '(' },
            { type: 'link', value: 'https://a.lt', href: 'https://a.lt' },
            { type: 'text', value: ')' },
        ]);
    });

    it('handles multiple URLs in one string', () => {
        const parts = splitTextWithLinks('a https://x.lt b https://y.lt');
        expect(parts.filter((p) => p.type === 'link').map((p) => p.value)).toEqual([
            'https://x.lt',
            'https://y.lt',
        ]);
    });

    it('does not treat ordinary dotted words as links', () => {
        expect(splitTextWithLinks('file.txt v1.2 done')).toEqual([
            { type: 'text', value: 'file.txt v1.2 done' },
        ]);
    });

    it('keeps a "www." whose anchoring dot the peel would eat as plain text', () => {
        // Without the post-peel re-validation this emitted { type:'link', href:'www' } — a RELATIVE
        // href that opens /www, i.e. a second cold boot of the PWA in a new tab.
        expect(splitTextWithLinks('adresas www.!')).toEqual([
            { type: 'text', value: 'adresas ' },
            { type: 'text', value: 'www.!' },
        ]);
        expect(splitTextWithLinks('www.,')).toEqual([{ type: 'text', value: 'www.,' }]);
        expect(splitTextWithLinks('adresas www.!').some((p) => p.type === 'link')).toBe(false);
    });

    it('prefixes https:// onto an auto-capitalised Www. link too', () => {
        expect(splitTextWithLinks('Www.regitra.lt')).toEqual([
            { type: 'link', value: 'Www.regitra.lt', href: 'https://Www.regitra.lt' },
        ]);
    });
});
