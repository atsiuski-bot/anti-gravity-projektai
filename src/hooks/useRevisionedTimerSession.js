import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

const initialState = {
    record: null,
    confirmedRecord: null,
    loaded: false,
    metadata: {
        fromCache: true,
        hasPendingWrites: false,
    },
    error: null,
};

export function useRevisionedTimerSession(userId, enabled) {
    const [state, setState] = useState(initialState);

    useEffect(() => {
        if (!enabled || !userId) {
            setState(initialState);
            return undefined;
        }

        return onSnapshot(
            doc(db, 'active_sessions', userId),
            { includeMetadataChanges: true },
            (snapshot) => {
                const metadata = {
                    fromCache: snapshot.metadata.fromCache,
                    hasPendingWrites: snapshot.metadata.hasPendingWrites,
                };
                const record = snapshot.exists() ? snapshot.data() : null;
                setState((previous) => ({
                    record,
                    confirmedRecord: !metadata.fromCache && !metadata.hasPendingWrites
                        ? record
                        : previous.confirmedRecord,
                    loaded: true,
                    metadata,
                    error: null,
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
