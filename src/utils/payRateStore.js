// payRateStore.js — WHERE a worker's pay rate lives, and who is allowed to read it.
//
// The tier arithmetic itself is pure and lives in utils/payRate.js; this module owns only the
// storage boundary, so payRate.js stays free of Firebase imports.
//
// WHY THIS EXISTS. Pay rates used to sit on the user document as `users/{uid}.payRate`. That
// document is deliberately readable by every ACTIVE user — it is the roster the whole app
// renders — and Firestore cannot hide a single field inside an allowed document read. So every
// worker could read every colleague's salary by listening to the users collection, which
// UsersContext does app-wide (audit R-10). The rate now lives in its own document,
//
//     users/{uid}/private/payRate
//
// whose read is scoped by firestore.rules to the owner, their overseer, and admins.
//
// MIGRATION SHAPE. Readers accept BOTH locations and PREFER the private document
// (`effectivePayRate`), so a client that ships before the backfill runs keeps working against
// un-migrated user documents. Every admin save writes the private document and clears the
// legacy field in the same action, so each edit fully migrates one user;
// scripts/migrate-payrate-to-private.cjs does the remainder in bulk (a privileged prod write —
// human-run, per CLAUDE.md).
import { deleteDoc, deleteField, doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { logError } from './errorLog';

// One document per user. A fixed id (not a collection of many) keeps the read a point lookup,
// so no index and no list query is ever needed — and a list query over `private` would be the
// one shape that could leak the collection's existence across users.
export const PAY_RATE_DOC_ID = 'payRate';

export const payRateDocRef = (uid) => doc(db, 'users', uid, 'private', PAY_RATE_DOC_ID);

/**
 * The rate to actually bill by, from the two possible locations.
 * The private document wins whenever it exists; the inline field on the user document is the
 * pre-migration fallback. Returns null when the worker has no rate at all.
 */
export const effectivePayRate = (privateDoc, legacyUser) => privateDoc || legacyUser?.payRate || null;

/**
 * Read ONE user's pay rate document. Returns null when the document does not exist.
 * Throws on a real failure (permission denied, offline) so a caller that needs to distinguish
 * "no rate" from "could not read" — the admin editor — can.
 */
export async function fetchPayRate(uid) {
    if (!uid) return null;
    const snap = await getDoc(payRateDocRef(uid));
    return snap.exists() ? snap.data() : null;
}

/**
 * Read pay rates for MANY users at once, best-effort: a uid whose rate is missing or unreadable
 * maps to null rather than failing the batch. Used by screens that render a roster (user
 * management, reports), where one unreadable rate must not blank the whole page.
 * @returns {Promise<Record<string, object|null>>} uid -> payRate | null
 */
export async function fetchPayRates(uids) {
    const list = Array.from(new Set((uids || []).filter(Boolean)));
    const entries = await Promise.all(
        list.map(async (uid) => {
            try {
                return [uid, await fetchPayRate(uid)];
            } catch {
                // Best-effort by design: an out-of-scope manager legitimately cannot read a rate,
                // and that must render as "no rate shown", never as a broken screen.
                return [uid, null];
            }
        })
    );
    return Object.fromEntries(entries);
}

/**
 * Live subscription to ONE user's pay rate — used for the signed-in user's own rate, so an admin
 * changing it is reflected without a reload (matching the old behaviour, where the rate rode
 * along on the user-document listener).
 * @returns {() => void} unsubscribe
 */
export function subscribePayRate(uid, onData, onErrorCb) {
    if (!uid) {
        onData(null);
        return () => {};
    }
    return onSnapshot(
        payRateDocRef(uid),
        (snap) => onData(snap.exists() ? snap.data() : null),
        (error) => {
            // A permission-denied here is the EXPECTED state until the rules carrying the
            // users/{uid}/private match block are deployed (deploy is human-only, so the app ships
            // first): with no rule, Firestore default-denies. Logging it would write a durable
            // crash record for every user on every login for a leak this change is closing —
            // so it is swallowed, exactly as the agent kill-switch listener swallows its own
            // pre-rollout denial. Every OTHER failure is still recorded.
            if (error?.code !== 'permission-denied') {
                logError(error, { source: 'onSnapshot:payRate', userId: uid });
            }
            if (onErrorCb) onErrorCb(error);
            // Fail CLOSED either way: an unreadable rate falls back to the legacy inline field via
            // effectivePayRate, and shows no earnings at all once that is gone — never a guess.
            onData(null);
        }
    );
}

/**
 * Persist a worker's pay rate (admin-only — enforced by firestore.rules). Passing null clears it.
 *
 * `legacyUser` is the user document as the caller already has it. When it still carries the
 * pre-migration inline `payRate`, that field is deleted in the same action — so one edit fully
 * migrates one user and the company-readable document stops carrying salary. When it does not,
 * no write is issued against the user document at all (it would be a pointless mutation that
 * also wakes the re-stamp trigger).
 */
export async function savePayRate(uid, payRate, legacyUser) {
    const ref = payRateDocRef(uid);
    if (payRate) {
        await setDoc(ref, payRate);
    } else {
        await deleteDoc(ref);
    }

    if (legacyUser && legacyUser.payRate !== undefined) {
        try {
            await updateDoc(doc(db, 'users', uid), { payRate: deleteField() });
        } catch (error) {
            // The rate itself is saved and `effectivePayRate` already prefers the private copy, so
            // the product is correct; what remains is a stale readable duplicate for the migration
            // script to sweep. Record it rather than failing the admin's save.
            logError(error, { source: 'savePayRate.clearLegacy', userId: uid });
        }
    }
}
