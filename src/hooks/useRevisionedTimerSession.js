import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

export const initialSessionState = {
    record: null,
    confirmedRecord: null,
    loaded: false,
    metadata: {
        fromCache: true,
        hasPendingWrites: false,
    },
    error: null,
};

/**
 * Fold one snapshot into the subscription state. Pure and exported so the cache-vs-confirmed rules
 * documented on the hook below are unit-testable without a Firestore double.
 *
 * @param {object} previous - the state before this snapshot.
 * @param {object} snapshot - { record, metadata: { fromCache, hasPendingWrites } }; `record` is null
 *                            when the document does not exist in that snapshot.
 */
export function nextSessionState(previous, { record: live, metadata }) {
    const confirmedRecord = !metadata.fromCache && !metadata.hasPendingWrites
        ? live
        : previous.confirmedRecord;
    // A cache-only miss is "not synced yet", never "no session" — fall back to the last record the
    // server did confirm rather than letting the planners drop to the legacy revision-0 projection.
    const record = live ?? (metadata.fromCache ? previous.confirmedRecord : null);
    return {
        record,
        confirmedRecord,
        loaded: previous.loaded || record !== null || !metadata.fromCache,
        metadata,
        error: null,
    };
}

/**
 * Subscribe to the worker's canonical active-session record (ADR 0020).
 *
 * `loaded` means "the canonical state is KNOWN", not merely "a snapshot arrived". The distinction is
 * the whole point of this hook, because Firestore's first emission comes from the local cache and a
 * cache MISS is indistinguishable from a genuine absence — while the two demand opposite behaviour:
 *
 *   • Genuine absence is normal and safe: the worker has no canonical record yet, so every planner
 *     falls back to the legacy activeSession projection at revision 0 and the next transition
 *     CREATES the record. That is the migration bridge onto the engine.
 *   • A cache miss over an EXISTING server record silently takes the same branch — and then plans a
 *     transition from revision 0 against a document that is already at revision N. The rules reject
 *     it (correctly), so nothing corrupts, but the worker just gets "could not change the timer" on
 *     every tap with no way to tell why, until the server snapshot happens to land.
 *
 * Since the rules forbid deleting an active_sessions document, an absence reported by the SERVER is
 * authoritative forever after; only an unconfirmed cache miss is ambiguous. So the state counts as
 * known once we hold a record, or once any server snapshot has arrived. An offline cold boot is the
 * one case that stays unknown — and there the honest answer is to say the state is unavailable
 * rather than guess, which is exactly what every consumer's `loaded` guard already does.
 */
export function useRevisionedTimerSession(userId, enabled) {
    const [state, setState] = useState(initialSessionState);

    useEffect(() => {
        if (!enabled || !userId) {
            setState(initialSessionState);
            return undefined;
        }

        return onSnapshot(
            doc(db, 'active_sessions', userId),
            { includeMetadataChanges: true },
            (snapshot) => {
                setState((previous) => nextSessionState(previous, {
                    record: snapshot.exists() ? snapshot.data() : null,
                    metadata: {
                        fromCache: snapshot.metadata.fromCache,
                        hasPendingWrites: snapshot.metadata.hasPendingWrites,
                    },
                }));
            },
            (error) => {
                setState((previous) => ({
                    ...previous,
                    loaded: true,
                    error,
                }));
            }
        );
    }, [enabled, userId]);

    return state;
}
