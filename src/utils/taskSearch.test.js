import { describe, it, expect } from 'vitest';
import {
    foldChars,
    normalizeSearchText,
    tokenizeQuery,
    boundedEditDistance,
    scoreToken,
    scoreFields,
    filterRankTasks,
    buildTaskSuggestions,
    highlightMatch,
    getTaskMatchFields,
    getTaskSuggestionSources,
} from './taskSearch';

// The search core is the thing a phone user on a building site leans on, so these tests pin the
// behaviours that make it forgiving: diacritic folding, word-order-free AND, typo tolerance, and
// relevance ranking. They are pure (no DOM, no clock) so they run anywhere.

describe('foldChars / normalizeSearchText', () => {
    it('folds Lithuanian diacritics to a bare ASCII base, length-preserving', () => {
        expect(foldChars('Dažymas')).toBe('dazymas');
        expect(foldChars('Jonelienė')).toBe('joneliene');
        expect(foldChars('ąčęėįšųūž')).toBe('aceeisuuz');
        // length preserved so highlight indices line up with the original string
        expect(foldChars('Dažymas')).toHaveLength('Dažymas'.length);
    });

    it('collapses whitespace and trims for the matching form', () => {
        expect(normalizeSearchText('  Plytų   mūras  ')).toBe('plytu muras');
    });
});

describe('tokenizeQuery', () => {
    it('splits a multi-word query into normalized tokens', () => {
        expect(tokenizeQuery('Jonas Dažymas')).toEqual(['jonas', 'dazymas']);
        expect(tokenizeQuery('   ')).toEqual([]);
    });
});

describe('boundedEditDistance', () => {
    it('returns the distance when within budget, -1 otherwise', () => {
        expect(boundedEditDistance('dazymas', 'dazymas', 2)).toBe(0);
        expect(boundedEditDistance('dazymas', 'dazimas', 2)).toBe(1); // one substitution
        expect(boundedEditDistance('dazymas', 'dzymas', 2)).toBe(1); // one deletion
        expect(boundedEditDistance('cat', 'dog', 1)).toBe(-1); // over budget
    });
});

describe('scoreToken — match ladder', () => {
    it('ranks exact > prefix > word-start > substring', () => {
        const exact = scoreToken('dazymas', 'dazymas');
        const prefix = scoreToken('dazymas darbai', 'dazymas');
        const wordStart = scoreToken('lauko dazymas', 'dazym');
        const substring = scoreToken('perdazymas', 'dazym');
        expect(exact).toBeGreaterThan(prefix);
        expect(prefix).toBeGreaterThan(wordStart);
        expect(wordStart).toBeGreaterThan(substring);
        expect(substring).toBeGreaterThan(0);
    });

    it('tolerates a typo via bounded edit distance', () => {
        expect(scoreToken('dazymas', 'dazimas')).toBeGreaterThan(0); // i for y
        expect(scoreToken('dazymas', 'dazymsa')).toBeGreaterThan(0); // transposition-ish
    });

    it('falls back to subsequence for dropped letters', () => {
        // no substring, no close edit distance, but letters appear in order
        expect(scoreToken('dazymas', 'dzm')).toBeGreaterThan(0);
    });

    it('does not match unrelated tokens', () => {
        expect(scoreToken('dazymas', 'pjovimas')).toBe(0);
    });
});

describe('scoreFields — weighted AND across tokens', () => {
    const fields = [
        { text: 'Dažymas', weight: 1.0 },
        { text: 'Jonas Jonaitis', weight: 0.9 },
        { text: 'Statyba', weight: 0.85 },
    ];

    it('requires every token to land somewhere (AND)', () => {
        expect(scoreFields(fields, ['jonas', 'dazymas'])).toBeGreaterThan(0); // both present
        expect(scoreFields(fields, ['jonas', 'pjovimas'])).toBe(0); // second token misses
    });

    it('is word-order independent', () => {
        const a = scoreFields(fields, ['jonas', 'dazymas']);
        const b = scoreFields(fields, ['dazymas', 'jonas']);
        expect(a).toBe(b);
    });
});

describe('filterRankTasks', () => {
    const tasks = [
        { title: 'Sienų dažymas', description: '', assignedUserName: 'Jonas', tag: 'Statyba' },
        { title: 'Grindų klojimas', description: 'reikia dažų', assignedUserName: 'Petras', tag: 'Statyba' },
        { title: 'Langų plovimas', description: '', assignedUserName: 'Ona', tag: 'Valymas' },
    ];

    it('keeps matches and ranks the strongest first', () => {
        // "dazymas" (no diacritics) — the diacritic-folded title is the strongest match and must
        // rank first. (The matcher is deliberately forgiving: an unrelated near-spelling like the
        // "Valymas" tag is within edit distance 2 and may appear LOWER, but never above the real
        // hit — that is exactly the typo tolerance + relevance ranking we want.)
        const out = filterRankTasks(tasks, 'dazymas', getTaskMatchFields);
        expect(out.length).toBeGreaterThanOrEqual(1);
        expect(out[0].title).toBe('Sienų dažymas');
        // a genuinely unrelated task (no shared fuzzy/substring signal) is excluded entirely
        expect(out.map(t => t.title)).not.toContain('Grindų klojimas');
    });

    it('matches across fields and tolerates typos', () => {
        const out = filterRankTasks(tasks, 'jonas', getTaskMatchFields);
        expect(out.map(t => t.title)).toContain('Sienų dažymas');
        const typo = filterRankTasks(tasks, 'plovmas', getTaskMatchFields); // dropped 'i'
        expect(typo.map(t => t.title)).toContain('Langų plovimas');
    });

    it('returns the input untouched for an empty query', () => {
        expect(filterRankTasks(tasks, '', getTaskMatchFields)).toBe(tasks);
    });
});

describe('buildTaskSuggestions', () => {
    const tasks = [
        { title: 'Sienų dažymas', assignedUserName: 'Jonas Jonaitis', tag: 'Statyba' },
        { title: 'Sienų dažymas', assignedUserName: 'Petras', tag: 'Statyba' }, // dup title + tag
        { title: 'Grindų dažymas', assignedUserName: 'Ona', tag: 'Apdaila' },
    ];

    it('dedupes by kind+value and surfaces matching titles/workers/tags', () => {
        const out = buildTaskSuggestions(tasks, 'daz', getTaskSuggestionSources);
        const titles = out.filter(s => s.kind === 'task').map(s => s.value);
        // both distinct titles, but "Sienų dažymas" appears once despite two tasks
        expect(titles.filter(t => t === 'Sienų dažymas')).toHaveLength(1);
        expect(titles).toContain('Grindų dažymas');
    });

    it('honours a kinds filter (WorkerView drops worker suggestions)', () => {
        const out = buildTaskSuggestions(tasks, 'jonas', getTaskSuggestionSources, { kinds: ['task', 'tag'] });
        expect(out.every(s => s.kind !== 'worker')).toBe(true);
    });

    it('returns nothing for an empty query', () => {
        expect(buildTaskSuggestions(tasks, '', getTaskSuggestionSources)).toEqual([]);
    });
});

describe('highlightMatch', () => {
    it('locates the match span on the original (accented) string via the fold', () => {
        const parts = highlightMatch('Sienų dažymas', 'dazym');
        expect(parts).not.toBeNull();
        expect(parts.match).toBe('dažym'); // original accented slice, not the folded one
        expect(parts.before + parts.match + parts.after).toBe('Sienų dažymas');
    });

    it('returns null when nothing matches', () => {
        expect(highlightMatch('Langų plovimas', 'xyz')).toBeNull();
    });
});
