/**
 * taskSearch — the shared, dependency-free fuzzy search core for the task lists.
 *
 * One matcher behind both WorkerView ("Mano užduotys") and ManagerView, so the two lists
 * search identically instead of drifting (they previously each carried their own naive
 * `String.includes` filter). The goals, in priority order, are the ones a phone user on a
 * building site actually needs:
 *
 *  1. **Diacritic-insensitive.** Lithuanian field staff almost never type ą č ę ė į š ų ū ž on a
 *     phone. `foldChars` folds both the query and the text to a bare ASCII base, so "dazymas"
 *     finds "Dažymas" and "joneliene" finds "Jonelienė". The fold is **1:1 per character**
 *     (length-preserving) on purpose — that lets the suggestion UI map a match span back onto
 *     the original (accented) string for highlighting without re-implementing the search.
 *  2. **Word-order-free AND.** A multi-word query is split into tokens; every token must hit
 *     *some* field (logical AND), but the order is free — "jonas dazymas" matches a "Dažymas"
 *     task assigned to "Jonas", whichever way round it was typed.
 *  3. **Typo-tolerant.** A token that does not appear as a substring still matches a field word
 *     within a small edit distance (1 for short tokens, 2 for longer), and as a last resort by
 *     subsequence ("dzm" -> "dazymas"). Fat-finger typos on glass keep working.
 *  4. **Ranked by relevance.** Every match carries a score (exact > prefix > word-start >
 *     substring > fuzzy, weighted by which field hit), so the most relevant task floats up while
 *     you type, rather than the list just shrinking in document order.
 *
 * Everything is pure and cheap: the lists are tens-to-low-hundreds of rows and matching runs on
 * a debounced query, so even the fuzzy path (bounded, early-exit edit distance) is free here.
 */

// 1:1 fold map — each accented character maps to exactly one ASCII base, so folding never
// changes string length. Lithuanian first (the product language), then the common Latin accents
// that show up in imported worker names. Length preservation is what makes highlight mapping safe.
const FOLD_MAP = {
    ą: 'a', č: 'c', ę: 'e', ė: 'e', į: 'i', š: 's', ų: 'u', ū: 'u', ž: 'z',
    á: 'a', à: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a',
    é: 'e', è: 'e', ê: 'e', ë: 'e',
    í: 'i', ì: 'i', î: 'i', ï: 'i',
    ó: 'o', ò: 'o', ô: 'o', ö: 'o', õ: 'o', ø: 'o',
    ú: 'u', ù: 'u', û: 'u', ü: 'u',
    ñ: 'n', ç: 'c', ý: 'y', ÿ: 'y', ß: 's',
};

const FOLD_RE = /[ąčęėįšųūžáàâäãåéèêëíìîïóòôöõøúùûüñçýÿß]/g;

/**
 * foldChars — lowercase + strip diacritics, **preserving length** (1:1 per char).
 * Use this when you need indices into the result to line up with the original string
 * (e.g. highlighting a matched span). For matching/tokenizing use {@link normalizeSearchText}.
 */
export function foldChars(str) {
    if (!str) return '';
    return String(str).toLowerCase().replace(FOLD_RE, (ch) => FOLD_MAP[ch] || ch);
}

/**
 * normalizeSearchText — `foldChars` + collapse runs of whitespace + trim. This is the canonical
 * form for matching and tokenizing. (It is NOT length-preserving, because it rewrites whitespace.)
 */
export function normalizeSearchText(str) {
    return foldChars(str).replace(/\s+/g, ' ').trim();
}

/** Split a normalized query into its search tokens (drops empties). */
export function tokenizeQuery(query) {
    const norm = normalizeSearchText(query);
    return norm ? norm.split(' ') : [];
}

// Per-match score bands. Named, not magic: they only need to preserve the ordering
// exact > whole-field-prefix > word-start > substring > fuzzy > subsequence.
const SCORE = {
    EXACT: 100,
    FIELD_PREFIX: 75,
    WORD_PREFIX: 60,
    SUBSTRING: 45,
    FUZZY_BASE: 35, // minus 8 per edit of distance
    FUZZY_STEP: 8,
    SUBSEQUENCE: 15,
};

/**
 * boundedEditDistance — Levenshtein with an early-exit ceiling. Returns the edit distance if it
 * is `<= max`, otherwise -1. The width guard (length delta > max can never be within budget)
 * plus a per-row running minimum keep this O(n·max) and cheap for the short words we compare.
 */
export function boundedEditDistance(a, b, max) {
    if (a === b) return 0;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > max) return -1;
    if (la === 0) return lb <= max ? lb : -1;
    if (lb === 0) return la <= max ? la : -1;

    let prev = new Array(lb + 1);
    let curr = new Array(lb + 1);
    for (let j = 0; j <= lb; j += 1) prev[j] = j;

    for (let i = 1; i <= la; i += 1) {
        curr[0] = i;
        let rowMin = curr[0];
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= lb; j += 1) {
            const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
            const del = prev[j] + 1;
            const ins = curr[j - 1] + 1;
            const sub = prev[j - 1] + cost;
            const v = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
            curr[j] = v;
            if (v < rowMin) rowMin = v;
        }
        if (rowMin > max) return -1; // whole row already over budget — bail
        const tmp = prev;
        prev = curr;
        curr = tmp;
    }
    const dist = prev[lb];
    return dist <= max ? dist : -1;
}

/** True if every char of `needle` appears in `hay` in order (gaps allowed). Both pre-folded. */
function isSubsequence(needle, hay) {
    if (!needle) return false;
    let i = 0;
    for (let j = 0; j < hay.length && i < needle.length; j += 1) {
        if (hay.charCodeAt(j) === needle.charCodeAt(i)) i += 1;
    }
    return i === needle.length;
}

/**
 * scoreToken — how well a single (already-normalized) token matches one (already-normalized)
 * field value. 0 means no match. The exact/prefix/word/substring ladder is tried first (cheap);
 * only if all of those miss do we pay for the typo-tolerant fuzzy + subsequence fallbacks, and
 * only for tokens long enough (>=3) that a fuzzy match is meaningful rather than noise.
 */
export function scoreToken(fieldNorm, token) {
    if (!fieldNorm || !token) return 0;
    if (fieldNorm === token) return SCORE.EXACT;
    if (fieldNorm.startsWith(token)) return SCORE.FIELD_PREFIX;

    const words = fieldNorm.split(' ');
    if (words.length > 1 && words.some((w) => w.startsWith(token))) return SCORE.WORD_PREFIX;
    if (fieldNorm.includes(token)) return SCORE.SUBSTRING;

    if (token.length >= 3) {
        const maxDist = token.length >= 6 ? 2 : 1;
        let bestFuzzy = 0;
        for (const w of words) {
            if (w.length < 3) continue;
            const d = boundedEditDistance(w, token, maxDist);
            if (d >= 0) {
                const fs = SCORE.FUZZY_BASE - d * SCORE.FUZZY_STEP;
                if (fs > bestFuzzy) bestFuzzy = fs;
            }
        }
        if (bestFuzzy > 0) return bestFuzzy;
        if (isSubsequence(token, fieldNorm)) return SCORE.SUBSEQUENCE;
    }
    return 0;
}

/**
 * scoreFields — total relevance of a query against a set of weighted fields, or 0 if the query
 * does not match (AND across tokens). `fields` is `[{ text, weight }]`; each token contributes
 * its best weighted field score, and a token that hits nowhere fails the whole match.
 *
 * @param {{text?: string, weight?: number}[]} fields
 * @param {string[]} tokens - pre-tokenized, normalized query terms.
 * @returns {number} score (higher = more relevant); 0 = no match.
 */
export function scoreFields(fields, tokens) {
    if (!tokens || tokens.length === 0) return 0;
    const normFields = [];
    for (const f of fields) {
        const norm = normalizeSearchText(f.text || '');
        if (norm) normFields.push({ norm, weight: f.weight ?? 1 });
    }
    if (normFields.length === 0) return 0;

    let total = 0;
    for (const token of tokens) {
        let best = 0;
        for (const f of normFields) {
            const s = scoreToken(f.norm, token);
            if (s > 0) {
                const weighted = s * f.weight;
                if (weighted > best) best = weighted;
            }
        }
        if (best === 0) return 0; // AND — every token must land somewhere
        total += best;
    }
    return total;
}

/**
 * filterRankTasks — keep only the tasks whose searchable fields match `query`, sorted by
 * descending relevance (stable for ties, so the caller's incoming order is the tie-breaker).
 * Returns the original task objects (no score is attached to them).
 *
 * @param {object[]} tasks
 * @param {string} query - raw user input.
 * @param {(task: object) => {text?: string, weight?: number}[]} getFields
 */
export function filterRankTasks(tasks, query, getFields) {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return tasks;

    const scored = [];
    for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i];
        const score = scoreFields(getFields(task), tokens);
        if (score > 0) scored.push({ task, score, i });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
    return scored.map((s) => s.task);
}

/**
 * buildTaskSuggestions — the "did you mean / quick-complete" list under the search box. Walks the
 * in-scope tasks, collects the distinct values worth suggesting (task titles, worker names, tags
 * — never the long free-text description), scores each against the query, and returns the best
 * few. Selecting one just sets the search text to that value, which then filters the list.
 *
 * @param {object[]} tasks
 * @param {string} query
 * @param {(task: object) => {value?: string, kind: string}[]} getSources
 * @param {{ limit?: number, kinds?: string[] }} [opts]
 * @returns {{ value: string, kind: string, score: number }[]}
 */
export function buildTaskSuggestions(tasks, query, getSources, opts = {}) {
    const { limit = 7, kinds } = opts;
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];
    const queryNorm = tokens.join(' ');

    const best = new Map(); // dedupe key -> { value, kind, score }
    for (const task of tasks) {
        for (const src of getSources(task)) {
            if (kinds && !kinds.includes(src.kind)) continue;
            const value = (src.value || '').trim();
            if (!value) continue;
            const valueNorm = normalizeSearchText(value);
            if (!valueNorm || valueNorm === queryNorm) continue; // skip an exact echo of the query
            const score = scoreFields([{ text: value, weight: 1 }], tokens);
            if (score <= 0) continue;
            const key = `${src.kind}|${valueNorm}`;
            const existing = best.get(key);
            if (!existing || score > existing.score) {
                best.set(key, { value, kind: src.kind, score });
            }
        }
    }

    return [...best.values()]
        .sort((a, b) => (b.score - a.score) || (a.value.length - b.value.length) || a.value.localeCompare(b.value))
        .slice(0, limit);
}

/**
 * highlightMatch — split `text` into `[before, match, after]` around the first occurrence of the
 * best (longest) query token, for emphasis in the suggestion list. Works on the length-preserving
 * fold so the returned slices index straight into the original (accented) `text`. Returns null if
 * nothing matches, so callers can render the plain string.
 *
 * @returns {{ before: string, match: string, after: string } | null}
 */
export function highlightMatch(text, query) {
    if (!text) return null;
    const tokens = tokenizeQuery(query).slice().sort((a, b) => b.length - a.length);
    if (tokens.length === 0) return null;
    const folded = foldChars(text); // same length as text
    for (const token of tokens) {
        const idx = folded.indexOf(token);
        if (idx >= 0) {
            return {
                before: text.slice(0, idx),
                match: text.slice(idx, idx + token.length),
                after: text.slice(idx + token.length),
            };
        }
    }
    return null;
}

/**
 * Canonical field weights for matching a task. Title is what people remember; the assignee and
 * tag are strong secondary keys; the description matches but ranks lowest (it is long and noisy).
 * Shared by both views so ranking is identical everywhere.
 */
export function getTaskMatchFields(task) {
    return [
        { text: task.title, weight: 1.0 },
        { text: task.assignedUserName, weight: 0.9 },
        { text: task.tag, weight: 0.85 },
        { text: task.description, weight: 0.6 },
    ];
}

/**
 * Suggestion sources for a task — the short, human values worth offering as quick completions.
 * `kind` drives the little type label/icon in the dropdown and lets a view opt out of a kind
 * (WorkerView drops `worker`, since every row is the signed-in user's own task).
 */
export function getTaskSuggestionSources(task) {
    return [
        { value: task.title, kind: 'task' },
        { value: task.assignedUserName, kind: 'worker' },
        { value: task.tag, kind: 'tag' },
    ];
}
