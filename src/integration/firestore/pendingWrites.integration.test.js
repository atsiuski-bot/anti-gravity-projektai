import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
    addDoc,
    collection,
    disableNetwork,
    doc,
    enableNetwork,
    onSnapshot,
    query,
    setDoc,
    where,
} from 'firebase/firestore';
import { readFile } from 'node:fs/promises';

// Regression oracle for the silent planned-hours loss.
//
// The failure it guards: Firestore applies a write to the on-device cache the instant it is made,
// so a planned shift appears on the worker's calendar whether or not it ever reaches the server. On
// a connection that cannot deliver it, the entry looks saved, the manager sees nothing, and the
// shift is lost when the cache is cleared. WorkPlanner now distinguishes the two states — and this
// pins the two SDK facts that distinction rests on:
//
//   1. an unsent write is observable — the snapshot reports hasPendingWrites === true;
//   2. `includeMetadataChanges: true` is REQUIRED to see it clear — the pending -> committed
//      transition changes only metadata, so without the option the listener never re-fires and the
//      "Neišsiųsta" marker would stick to an entry that is in fact saved.
//
// Fact 2 is the one a future edit is most likely to break (dropping the option looks harmless), and
// breaking it is worse than the original bug: it would cry wolf on every saved entry.

const PROJECT_ID = 'demo-workz-pending-writes';
const WORKER_ID = 'pending-worker';
const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describeEmulator = emulatorAvailable ? describe : describe.skip;

// Authenticated clients via @firebase/rules-unit-testing, NOT a bare initializeApp client.
//
// This file used to build plain, unauthenticated SDK clients on the argument that it pins cache
// semantics rather than authorization, so the rules layer would only add a dependency and a failure
// mode. That reasoning does not hold: the emulator loads the real firestore.rules whatever client
// connects to it, so authorization is never opted out of — only the principal is chosen. An
// anonymous client is denied `list` on /work_hours (read requires isUserActive()), the listener's
// initial snapshot therefore never arrives, and BOTH cases below timed out before asserting
// anything. The dependency is also already unavoidable — the three sibling integration files pin
// offline/pending semantics through exactly this harness.
//
// Each context gets its own Firebase app, hence its own cache: the two cases below need separate
// caches, which is why they take a client each rather than sharing one.
let testEnv;

function workerDb() {
    return testEnv.authenticatedContext(WORKER_ID, {
        email: 'pending-worker@example.test',
    }).firestore();
}

beforeAll(async () => {
    if (!emulatorAvailable) return;
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
            rules: await readFile(new URL('../../../firestore.rules', import.meta.url), 'utf8'),
        },
    });
}, 30_000);

// Start from an empty database, and seed the ACTIVE user doc the read rule resolves against
// (isUserActive() = signed in + users/{uid} exists + not disabled). Without the reset a document
// left by an earlier case is already present (and already committed) when the listener attaches, so
// the assertions below would be reading that state rather than this case's.
beforeEach(async () => {
    if (!emulatorAvailable) return;
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), `users/${WORKER_ID}`), {
            id: WORKER_ID,
            role: 'worker',
            isDisabled: false,
            email: 'pending-worker@example.test',
        });
    });
}, 30_000);

afterAll(async () => {
    await testEnv?.cleanup();
});

// Collects every snapshot the planner's listener would receive, in order.
function watchWorkHours(db, onEach) {
    const q = query(collection(db, 'work_hours'), where('userId', '==', WORKER_ID));
    return onSnapshot(q, { includeMetadataChanges: true }, onEach);
}

function waitFor(predicate, label, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for: ${label}`));
            setTimeout(tick, 25);
        };
        tick();
    });
}

describeEmulator('work_hours pending-write visibility', () => {
    it('marks a write made without a connection as pending, and clears it once delivered', async () => {
        const db = workerDb();
        const seen = [];
        const unsubscribe = watchWorkHours(db, (snap) => {
            seen.push({
                count: snap.size,
                snapshotPending: snap.metadata.hasPendingWrites,
                docsPending: snap.docs.map((d) => d.metadata.hasPendingWrites),
            });
        });
        await waitFor(() => seen.length > 0, 'the initial (empty) snapshot');

        // Cut the connection, then plan a shift exactly as the worker would.
        await disableNetwork(db);
        // Deliberately NOT awaited: offline, the SDK applies the write locally and leaves this
        // promise pending indefinitely. Awaiting it is what used to freeze the form — the entry was
        // already on screen while the code waiting to confirm it never resumed.
        const write = addDoc(collection(db, 'work_hours'), {
            userId: WORKER_ID,
            start: '2026-07-21T07:30:00.000Z',
            end: '2026-07-21T11:00:00.000Z',
            title: 'Veikla',
            type: 'planned',
        });

        // The entry is visible to the worker...
        await waitFor(() => seen.some((s) => s.count === 1), 'the entry to appear locally');
        // ...and is announced as NOT yet on the server. This is the signal the UI now shows.
        const whileOffline = seen.filter((s) => s.count === 1).at(-1);
        expect(whileOffline.snapshotPending).toBe(true);
        expect(whileOffline.docsPending).toEqual([true]);

        // Reconnect: the queued write flushes on its own — nothing was lost, only unconfirmed.
        await enableNetwork(db);
        await write;

        await waitFor(
            () => seen.some((s) => s.count === 1 && s.snapshotPending === false),
            'the pending flag to clear after delivery'
        );
        const afterSync = seen.at(-1);
        expect(afterSync.count).toBe(1);
        expect(afterSync.snapshotPending).toBe(false);
        expect(afterSync.docsPending).toEqual([false]);

        unsubscribe();
    }, 30_000);

    it('without includeMetadataChanges the pending flag never clears (why the option is required)', async () => {
        const db = workerDb();
        const seen = [];
        const q = query(collection(db, 'work_hours'), where('userId', '==', WORKER_ID));
        // The same listener MINUS the option — i.e. what this component did before the fix.
        const unsubscribe = onSnapshot(q, (snap) => {
            seen.push({ count: snap.size, snapshotPending: snap.metadata.hasPendingWrites });
        });
        await waitFor(() => seen.length > 0, 'the initial (empty) snapshot');

        await disableNetwork(db);
        const write = addDoc(collection(db, 'work_hours'), {
            userId: WORKER_ID,
            start: '2026-07-22T07:30:00.000Z',
            end: '2026-07-22T11:00:00.000Z',
            title: 'Veikla',
            type: 'planned',
        });
        await waitFor(() => seen.some((s) => s.count === 1), 'the entry to appear locally');

        await enableNetwork(db);
        await write;
        // Give the commit ample time to land and any listener to fire.
        await new Promise((resolve) => { setTimeout(resolve, 1500); });

        // The document data never changed, so this listener was never told the write was delivered:
        // its last word on the subject is still "pending". A UI keyed on that would mark a saved
        // entry as unsent forever.
        expect(seen.at(-1).snapshotPending).toBe(true);

        unsubscribe();
    }, 30_000);
});
