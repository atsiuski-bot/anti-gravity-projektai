import { describe, it, expect, vi } from 'vitest';

// Only the PURE alignment helpers are covered here: the upload halves need Storage. These two are
// where a silent, invisible defect lives — a mis-paired thumbnail shows the WRONG photo's preview
// and nothing errors, so the reader trusts a picture that belongs to another task step.
vi.mock('../firebase', () => ({ storage: {} }));
vi.mock('firebase/storage', () => ({
    ref: vi.fn(),
    uploadBytesResumable: vi.fn(),
    getDownloadURL: vi.fn(),
}));

import { withThumbs, padThumbs } from './attachmentUpload';

describe('withThumbs (tile rendition, with the original as the fallback)', () => {
    it('pairs each url with its thumb by POSITION', () => {
        expect(withThumbs(['a', 'b'], ['a-thumb', 'b-thumb'])).toEqual([
            { url: 'a', thumb: 'a-thumb' },
            { url: 'b', thumb: 'b-thumb' },
        ]);
    });

    // Every task photographed before thumbnails shipped hits this path — it must render exactly as
    // it does today, not as a broken tile.
    it('falls back to the original when there is no thumb array at all', () => {
        expect(withThumbs(['a', 'b'])).toEqual([
            { url: 'a', thumb: 'a' },
            { url: 'b', thumb: 'b' },
        ]);
        expect(withThumbs(['a'], undefined)).toEqual([{ url: 'a', thumb: 'a' }]);
        expect(withThumbs(['a'], null)).toEqual([{ url: 'a', thumb: 'a' }]);
    });

    // A null slot is the normal outcome for a HEIC the browser could not decode.
    it('falls back per-slot, not all-or-nothing', () => {
        expect(withThumbs(['a', 'b', 'c'], ['a-thumb', null])).toEqual([
            { url: 'a', thumb: 'a-thumb' },
            { url: 'b', thumb: 'b' },
            { url: 'c', thumb: 'c' },
        ]);
    });

    it('never invents a tile for a photo that is not there', () => {
        expect(withThumbs([], ['orphan-thumb'])).toEqual([]);
        expect(withThumbs()).toEqual([]);
    });
});

describe('padThumbs (keep the arrays positional before appending)', () => {
    // THE bug this exists to prevent: urls has 3 old photos and thumbs has none, so appending a new
    // thumb without padding would land it at index 0 — the newest preview on the OLDEST photo.
    it('pads a short/absent array up to the url count', () => {
        expect(padThumbs(undefined, 3)).toEqual([null, null, null]);
        expect(padThumbs(['a-thumb'], 3)).toEqual(['a-thumb', null, null]);
    });

    it('trims an over-long array so a removed photo cannot leave a stray slot', () => {
        expect(padThumbs(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
    });

    it('is a no-op when the arrays already agree', () => {
        expect(padThumbs(['a', 'b'], 2)).toEqual(['a', 'b']);
        expect(padThumbs([], 0)).toEqual([]);
    });

    // Appending after padding puts new thumbs exactly where their photos are.
    it('composes with an append into a correctly aligned array', () => {
        const storedUrls = ['old1', 'old2'];
        const storedThumbs = undefined;               // pre-thumbnail task
        const newUrls = ['new1'];
        const newThumbs = ['new1-thumb'];

        const urls = [...storedUrls, ...newUrls];
        const thumbs = [...padThumbs(storedThumbs, storedUrls.length), ...newThumbs];

        expect(withThumbs(urls, thumbs)).toEqual([
            { url: 'old1', thumb: 'old1' },
            { url: 'old2', thumb: 'old2' },
            { url: 'new1', thumb: 'new1-thumb' },
        ]);
    });
});
