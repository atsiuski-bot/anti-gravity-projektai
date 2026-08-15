import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { calculateCurrentTotalMinutes, sanitizeReportMinutes } from '../utils/timeUtils';
import { titleStemSet, stemSetsSimilar } from '../utils/titleSimilarity';
import { logError } from '../utils/errorLog';

/**
 * useSimilarTaskHistory — how long this worker has USUALLY taken on this kind of work.
 *
 * Feeds the finish summary's "greičiau nei paprastai" line. Two ways to decide what counts as
 * "the same work", tried in order, because they are not equally trustworthy:
 *
 *   1. `sourceTemplateId` — an EXACT lineage key. Recurring tasks are materialised from a
 *      `task_templates` doc and every generated task carries its id, so two tasks sharing it are
 *      provably the same recurring job. This is the only key the SERVER uses, because a permanent
 *      badge must not rest on a guess.
 *   2. Fuzzy title similarity — for repeat work that was never templated. Necessary because in the
 *      real corpus no title repeats three times verbatim (see titleSimilarity): an exact-title match
 *      would find nothing. Good enough for a friendly on-screen sentence, deliberately NOT good
 *      enough to earn a permanent badge.
 *
 * Read shape mirrors useTaskSuggestions: a single equality-only query, which Firestore serves from
 * single-field indexes (no composite index, no new rule — task READ is already team-broad). Pinning
 * `assignedUserId` to the signed-in user is what keeps this self-referential: a worker is only ever
 * compared against their own past, never against a colleague.
 *
 * @param {Object}  params
 * @param {Object}  params.task     the just-finished task (its own id is excluded from the history)
 * @param {string}  params.uid      the signed-in worker
 * @param {boolean} params.enabled  skip the read entirely when the summary is not open
 * @returns {{priorMinutes: number[], loading: boolean, matchedBy: 'template'|'title'|null}}
 */
export default function useSimilarTaskHistory({ task, uid, enabled }) {
    const [state, setState] = useState({ priorMinutes: [], loading: true, matchedBy: null });
    const taskId = task?.id;
    const title = task?.title || '';
    const templateId = task?.sourceTemplateId || '';

    useEffect(() => {
        if (!enabled || !uid || !taskId) {
            setState({ priorMinutes: [], loading: false, matchedBy: null });
            return undefined;
        }
        let cancelled = false;
        setState({ priorMinutes: [], loading: true, matchedBy: null });

        (async () => {
            try {
                const snap = await getDocs(query(
                    collection(db, 'tasks'),
                    where('assignedUserId', '==', uid),
                    where('completed', '==', true),
                ));
                if (cancelled) return;

                const rows = [];
                snap.forEach((d) => {
                    if (d.id === taskId) return;              // never compare a run against itself
                    const t = { id: d.id, ...d.data() };
                    if (t.isQuickWork === true) return;       // one-tap logs are not "the same work"
                    if (t.status === 'deleted') return;
                    // The 16h ceiling matters here: one un-clamped junk row would not move the
                    // median, but it would still be counted as a valid prior instance.
                    const minutes = sanitizeReportMinutes(calculateCurrentTotalMinutes(t));
                    if (!(minutes > 0)) return;
                    rows.push({ minutes, title: t.title || '', sourceTemplateId: t.sourceTemplateId || '' });
                });

                // Exact lineage wins outright — if this job has a template, its own past runs are
                // the only honest comparison set, and falling back to fuzzy matching would dilute
                // them with merely similar-sounding work.
                if (templateId) {
                    const exact = rows.filter((r) => r.sourceTemplateId === templateId);
                    if (exact.length > 0) {
                        setState({ priorMinutes: exact.map((r) => r.minutes), loading: false, matchedBy: 'template' });
                        return;
                    }
                }

                const stems = titleStemSet(title);
                const fuzzy = stems.size > 0
                    ? rows.filter((r) => stemSetsSimilar(stems, titleStemSet(r.title)))
                    : [];
                setState({
                    priorMinutes: fuzzy.map((r) => r.minutes),
                    loading: false,
                    matchedBy: fuzzy.length > 0 ? 'title' : null,
                });
            } catch (e) {
                // A comparison is a pure enhancement on a screen the worker has already earned:
                // a failed read must leave the summary standing, minus one line.
                logError(e, { source: 'useSimilarTaskHistory', userId: uid, taskId });
                if (!cancelled) setState({ priorMinutes: [], loading: false, matchedBy: null });
            }
        })();

        return () => { cancelled = true; };
    }, [enabled, uid, taskId, title, templateId]);

    return state;
}
