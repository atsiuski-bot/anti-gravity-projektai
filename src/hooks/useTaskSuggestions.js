import { useEffect, useState, useMemo, useCallback } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { parseTimeStringToMinutes } from '../utils/timeUtils';
import { titleStemSet, stemSetsSimilar } from '../utils/titleSimilarity';

/**
 * useTaskSuggestions — turns the creator's OWN past tasks into create-form assistance.
 *
 * The task-creation analysis (171 real tasks, 5 months) showed two things this exploits:
 *   1. titles recur per author (the heaviest user reuses ~30 word-stems) — so the same
 *      person creates the same kinds of work again and again;
 *   2. a given kind of work tends to take a consistent time.
 * So we read the user's authored history once when the create modal opens and derive:
 *   - `recentTitles`   — de-duplicated, most-recent-first, to power title type-ahead;
 *   - `topTimes`       — the user's most-used estimated-time values, to personalise the chips;
 *   - `suggestTimeForTitle(title)` — the typical time for a title (exact match → keyword
 *     overlap), so picking a known job can pre-fill its usual duration.
 *
 * Read-only and dependency-light: a single `where('createdBy','==',uid)` equality query (no
 * composite index, no new Firestore rule — task READ is already team-broad). Run only while
 * `enabled` (i.e. creating, not editing); it re-reads on each open so a just-created task shows
 * up next time, and Firestore's local cache keeps the repeat cost near-free.
 */

// Words shorter than this are connective noise ("ir", "prie", "po") — skip them when matching
// titles by keyword so the overlap score reflects the meaningful nouns/verbs.
const MIN_WORD = 4;

const normTitle = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const titleWords = (s) => normTitle(s).split(/[\s,/:;.\-_]+/).filter((w) => w.length >= MIN_WORD);

// A usable estimated-time string is one the canonical parser accepts as a positive duration —
// this filters out the legacy free-text junk ("1 val" parses, "" / garbage does not).
const isUsableTime = (t) => !!t && parseTimeStringToMinutes(t) > 0;

// Pick the most frequent valid estimated-time across a set of history rows.
const mostCommonTime = (rows) => {
    const freq = new Map();
    for (const r of rows) {
        const t = (r.estimatedTime || '').trim();
        if (!isUsableTime(t)) continue;
        freq.set(t, (freq.get(t) || 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [t, c] of freq) {
        if (c > bestCount) {
            best = t;
            bestCount = c;
        }
    }
    return best;
};

export default function useTaskSuggestions({ uid, enabled }) {
    // Raw authored history: [{ title, estimatedTime, createdAt }].
    const [history, setHistory] = useState([]);

    useEffect(() => {
        if (!enabled || !uid) return undefined;
        let cancelled = false;
        (async () => {
            try {
                const snap = await getDocs(
                    query(collection(db, 'tasks'), where('createdBy', '==', uid))
                );
                if (cancelled) return;
                const rows = snap.docs
                    .map((d) => {
                        const t = d.data();
                        return {
                            title: t.title || '',
                            estimatedTime: t.estimatedTime || '',
                            createdAt: t.createdAt || '',
                        };
                    })
                    .filter((r) => r.title.trim());
                setHistory(rows);
            } catch (e) {
                // Suggestions are a pure enhancement — a failed read must never block creating a
                // task, so swallow it to an empty history and let the form work unaided.
                console.warn('useTaskSuggestions: failed to load history', e);
                if (!cancelled) setHistory([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [uid, enabled]);

    // Distinct titles, most-recent-first (de-duplicated case-insensitively, keeping the most
    // recent spelling). This is the type-ahead source.
    const recentTitles = useMemo(() => {
        const seen = new Set();
        const out = [];
        const sorted = [...history].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        for (const r of sorted) {
            const key = normTitle(r.title);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(r.title.trim());
        }
        return out;
    }, [history]);

    // The user's most-used valid estimated-time values, most-frequent first — used to put the
    // chips THEY actually pick at the front instead of a fixed guess.
    const topTimes = useMemo(() => {
        const freq = new Map();
        for (const r of history) {
            const t = (r.estimatedTime || '').trim();
            if (!isUsableTime(t)) continue;
            freq.set(t, (freq.get(t) || 0) + 1);
        }
        return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    }, [history]);

    // Typical time for a title: an exact (normalised) match wins; otherwise the time of the
    // best keyword-overlap past task. Returns '' when history has nothing relevant.
    const suggestTimeForTitle = useCallback(
        (title) => {
            const key = normTitle(title);
            if (!key) return '';

            const exact = history.filter((r) => normTitle(r.title) === key);
            if (exact.length) {
                const t = mostCommonTime(exact);
                if (t) return t;
            }

            const qWords = new Set(titleWords(title));
            if (qWords.size === 0) return '';
            let bestRow = null;
            let bestScore = 0;
            for (const r of history) {
                if (!isUsableTime(r.estimatedTime)) continue;
                let score = 0;
                for (const w of titleWords(r.title)) {
                    if (qWords.has(w)) score++;
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestRow = r;
                }
            }
            return bestScore > 0 && bestRow ? bestRow.estimatedTime.trim() : '';
        },
        [history]
    );

    // Precomputed distinctive-stem sets for the authored history — the fuzzy-match source.
    const historyStemSets = useMemo(() => history.map((r) => titleStemSet(r.title)), [history]);

    // How many prior authored tasks describe work SIMILAR to this title. Fuzzy, not exact: in the
    // real corpus no title repeats 3× verbatim, so an exact count would always be 0 and the
    // "save as a template?" nudge would never fire. Similarity is shared distinctive stems (see
    // titleSimilarity) — recurrence by meaning, not spelling.
    const countSimilarTitles = useCallback(
        (title) => {
            const a = titleStemSet(title);
            if (a.size === 0) return 0;
            let n = 0;
            for (const b of historyStemSets) {
                if (stemSetsSimilar(a, b)) n++;
            }
            return n;
        },
        [historyStemSets]
    );

    return {
        recentTitles,
        topTimes,
        suggestTimeForTitle,
        countSimilarTitles,
        hasHistory: history.length > 0,
    };
}
