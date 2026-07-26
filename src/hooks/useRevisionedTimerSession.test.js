import { describe, it, expect } from 'vitest';
import { initialSessionState, nextSessionState } from './useRevisionedTimerSession';

// The canonical active-session subscription decides ONE thing that everything downstream depends on:
// whether the worker's canonical state is actually KNOWN. Firestore's first emission comes from the
// local cache, where "no document" is indistinguishable from "not synced yet" — and the two demand
// opposite behaviour, because an unknown state planned as "absent" issues transitions from revision
// 0 against a record that is already at revision N.

const snap = (record, fromCache, hasPendingWrites = false) => ({
    record,
    metadata: { fromCache, hasPendingWrites },
});

const REC = { userId: 'u1', revision: 3, status: 'active', run: { runId: 'r1', type: 'task' } };

describe('nextSessionState (canonical active-session snapshot fold)', () => {
    it('stays UNLOADED on a cache-only miss — that is "not synced yet", not "no session"', () => {
        const state = nextSessionState(initialSessionState, snap(null, true));
        expect(state.loaded).toBe(false);
        expect(state.record).toBeNull();
    });

    it('loads on a SERVER-reported absence — rules forbid deleting the record, so absence is final', () => {
        const state = nextSessionState(initialSessionState, snap(null, false));
        expect(state.loaded).toBe(true);
        expect(state.record).toBeNull();
        expect(state.confirmedRecord).toBeNull();
    });

    it('loads on a cache HIT — a stale revision is rejected by the rules, an unknown base is not', () => {
        const state = nextSessionState(initialSessionState, snap(REC, true));
        expect(state.loaded).toBe(true);
        expect(state.record).toEqual(REC);
        // Cache-sourced, so it is not yet server-confirmed.
        expect(state.confirmedRecord).toBeNull();
    });

    it('keeps the server-confirmed record when a later cache snapshot loses the document', () => {
        const confirmed = nextSessionState(initialSessionState, snap(REC, false));
        expect(confirmed.confirmedRecord).toEqual(REC);

        const cacheMiss = nextSessionState(confirmed, snap(null, true));
        expect(cacheMiss.record, 'a cache eviction must not read as "the run ended"').toEqual(REC);
        expect(cacheMiss.loaded).toBe(true);
    });

    it('honours a SERVER-reported absence even after a confirmed record — the run really ended', () => {
        const confirmed = nextSessionState(initialSessionState, snap(REC, false));
        const ended = nextSessionState(confirmed, snap(null, false));
        expect(ended.record).toBeNull();
        expect(ended.confirmedRecord).toBeNull();
    });

    it('does not confirm a record that still carries this device\'s pending write', () => {
        const pending = nextSessionState(initialSessionState, snap(REC, false, true));
        expect(pending.record).toEqual(REC);
        expect(pending.confirmedRecord, 'an unacknowledged local write is not server truth').toBeNull();
        expect(pending.loaded).toBe(true);
    });

    it('never regresses loaded once the state has been known', () => {
        const known = nextSessionState(initialSessionState, snap(REC, false));
        const later = nextSessionState(known, snap(null, true));
        expect(later.loaded).toBe(true);
    });
});
