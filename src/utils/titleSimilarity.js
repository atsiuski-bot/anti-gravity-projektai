/**
 * titleSimilarity — lightweight fuzzy matching for task titles.
 *
 * WHY: an exact-title match is useless for "is this work recurring?" — in 171 real WORKZ tasks
 * NO title repeats 3×, and only 5 repeat 2× (every title is phrased a little differently). So
 * recurrence has to be judged by SHARED MEANING, not string equality. This reduces a title to a
 * set of distinctive word-stems and compares those sets.
 *
 * Approach (deliberately simple, no ML, runs client-side):
 *  - fold Lithuanian diacritics (ą→a, č→c, š→s, ž→z, …) so spelling variants collapse;
 *  - keep word-stems (first 5 chars of each ≥4-char word) — a crude stemmer for a richly
 *    inflected language ("kostiumų"/"kostiumai"/"kostiumo" → "kosti");
 *  - drop connective stopwords AND generic action verbs (padaryti/tvarkyti/taisyti/gamyba/…),
 *    because those co-occur everywhere and would group unrelated work ("padaryti X" vs "padaryti Y").
 *  Two titles are "similar" when their distinctive-stem sets share ≥2 stems, or overlap by
 *  Jaccard ≥ 0.5. Calibrated on the real corpus: this fires for ~11% of tasks — exactly the
 *  recurring themes (ugnies šou kostiumai, einamosios savaitės kostiumai, piro jungimas, mašinų
 *  parvežimas, printai, skulptūros) — while one-off tasks score 0–1.
 */

// Connective / filler words that carry no topic.
const STOPWORDS = new Set(
    'prie kad jei jeigu kaip apie arba bei per nuo del kai kuri kurie savo visu visus tik dar kas kur jau bus yra reikia pagal taip tai bet jos jis pas isi'.split(' ')
);

// Generic action-verb stems (already truncated to ≤5 chars). These describe the VERB, not the
// thing — including them would cluster "padaryti stovus" with "padaryti woolus". Dropped.
const GENERIC_STEMS = new Set(
    'padar paded padet tvark sutva taisy gamyb daryt perda paruo patik prizi surin sudet paban nupir'.split(' ')
);

// Fold combining diacritical marks (U+0300–U+036F) without a regex character class (which is
// brittle to author), then lowercase. NFD first so precomposed Lithuanian letters decompose.
const fold = (s) =>
    (s || '')
        .normalize('NFD')
        .split('')
        .filter((c) => {
            const code = c.charCodeAt(0);
            return code < 0x300 || code > 0x36f;
        })
        .join('')
        .toLowerCase();

/**
 * Reduce a title to its set of distinctive word-stems.
 * @param {string} title
 * @returns {Set<string>}
 */
export function titleStemSet(title) {
    const out = new Set();
    const tokens = fold(title).match(/[a-z]+/g) || [];
    for (const w of tokens) {
        if (w.length < 4 || STOPWORDS.has(w)) continue;
        const stem = w.slice(0, 5);
        if (GENERIC_STEMS.has(stem)) continue;
        out.add(stem);
    }
    return out;
}

/**
 * True when two stem sets describe the same kind of work (shared ≥2 stems, or Jaccard ≥ 0.5).
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
export function stemSetsSimilar(a, b) {
    if (!a || !b || a.size === 0 || b.size === 0) return false;
    let inter = 0;
    for (const s of a) if (b.has(s)) inter++;
    if (inter === 0) return false;
    const union = a.size + b.size - inter;
    return inter >= 2 || inter / union >= 0.5;
}

/**
 * Convenience: are two raw titles similar?
 */
export function titlesSimilar(titleA, titleB) {
    return stemSetsSimilar(titleStemSet(titleA), titleStemSet(titleB));
}
