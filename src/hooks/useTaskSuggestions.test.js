import { describe, it, expect } from 'vitest';
import { pickSuggestedTime, roundSuggestedMinutes } from './useTaskSuggestions';

// A history row as the hook builds it from a task doc.
const row = (title, { estimatedTime = '', actualMinutes = 0, completed = false } = {}) =>
    ({ title, estimatedTime, actualMinutes, completed, createdAt: '' });

describe('roundSuggestedMinutes', () => {
    it('uses five-minute steps under an hour', () => {
        expect(roundSuggestedMinutes(23)).toBe(25);
        expect(roundSuggestedMinutes(47)).toBe(45);
    });

    it('uses quarter-hours above an hour', () => {
        expect(roundSuggestedMinutes(187)).toBe(180);
        expect(roundSuggestedMinutes(200)).toBe(195);
        // Nearest, half up — deliberately NOT biased upward: a suggestion that always rounded up
        // would re-inflate estimates over time, which is the loop this whole change exists to close.
        expect(roundSuggestedMinutes(187.5)).toBe(195);
    });

    it('never rounds a real duration down to nothing', () => {
        expect(roundSuggestedMinutes(1)).toBe(5);
    });

    it('rejects junk', () => {
        expect(roundSuggestedMinutes(0)).toBe(0);
        expect(roundSuggestedMinutes(NaN)).toBe(0);
        expect(roundSuggestedMinutes(null)).toBe(0);
    });
});

describe('pickSuggestedTime', () => {
    it('suggests the MEDIAN ACTUAL once there are enough completed runs', () => {
        // The estimate said 2h every time; the work actually takes ~4h. Reality must win.
        const history = [
            row('Ugnies šou kostiumai', { estimatedTime: '2h', actualMinutes: 240, completed: true }),
            row('Ugnies šou kostiumai', { estimatedTime: '2h', actualMinutes: 230, completed: true }),
            row('Ugnies šou kostiumai', { estimatedTime: '2h', actualMinutes: 250, completed: true }),
        ];
        expect(pickSuggestedTime(history, 'Ugnies šou kostiumai')).toBe('4h');
    });

    it('is unmoved by one wild run', () => {
        const history = [
            row('Printai', { actualMinutes: 120, completed: true }),
            row('Printai', { actualMinutes: 120, completed: true }),
            row('Printai', { actualMinutes: 125, completed: true }),
            row('Printai', { actualMinutes: 4000, completed: true }),
        ];
        // Mean would be ~18h; the median lands on the real 2h job.
        expect(pickSuggestedTime(history, 'Printai')).toBe('2h');
    });

    it('falls back to the past ESTIMATE below the three-run floor', () => {
        const history = [
            row('Skulptūros', { estimatedTime: '2h', actualMinutes: 600, completed: true }),
            row('Skulptūros', { estimatedTime: '2h', actualMinutes: 600, completed: true }),
        ];
        // Only two actuals — not a measurement yet, so the remembered guess still answers.
        expect(pickSuggestedTime(history, 'Skulptūros')).toBe('2h');
    });

    it('ignores unfinished runs when counting measurements', () => {
        const history = [
            row('Mašinų parvežimas', { estimatedTime: '1h', actualMinutes: 300, completed: false }),
            row('Mašinų parvežimas', { estimatedTime: '1h', actualMinutes: 300, completed: false }),
            row('Mašinų parvežimas', { estimatedTime: '1h', actualMinutes: 300, completed: true }),
        ];
        expect(pickSuggestedTime(history, 'Mašinų parvežimas')).toBe('1h');
    });

    it('matches a re-phrased repeat by keyword overlap', () => {
        const history = [
            row('Piro jungimas scenoje', { actualMinutes: 60, completed: true }),
            row('Piro jungimas lauke', { actualMinutes: 60, completed: true }),
            row('Piro jungimas salėje', { actualMinutes: 70, completed: true }),
        ];
        expect(pickSuggestedTime(history, 'Piro jungimas festivalyje')).toBe('1h');
    });

    it('returns nothing for an empty title or an empty history', () => {
        expect(pickSuggestedTime([], 'Bet kas')).toBe('');
        expect(pickSuggestedTime([row('Kažkas', { estimatedTime: '1h' })], '')).toBe('');
    });

    it('round-trips through the estimate parser it feeds', async () => {
        const { parseTimeStringToMinutes } = await import('../utils/timeUtils');
        const history = [
            row('Stovai', { actualMinutes: 200, completed: true }),
            row('Stovai', { actualMinutes: 195, completed: true }),
            row('Stovai', { actualMinutes: 190, completed: true }),
        ];
        const suggested = pickSuggestedTime(history, 'Stovai');
        expect(suggested).toBe('3h 15m');
        expect(parseTimeStringToMinutes(suggested)).toBe(195);
    });
});
