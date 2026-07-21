import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from 'firebase/app';
import {
    addDoc,
    collection,
    connectFirestoreEmulator,
    disableNetwork,
    enableNetwork,
    getFirestore,
    onSnapshot,
    query,
    where,
} from 'firebase/firestore';

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

// Plain SDK clients against the emulator, not @firebase/rules-unit-testing: this pins client-cache
// semantics, not authorization, so the rules layer only adds a dependency and a failure mode.
const [emulatorHost, emulatorPort] = (process.env.FIRESTORE_EMULATOR_HOST || '').split(':');
const apps = [];

function emulatorDb(name) {
    const app = initializeApp({ projectId: PROJECT_ID }, name);
    apps.push(app);
    const db = getFirestore(app);
    connectFirestoreEmulator(db, emulatorHost, Number(emulatorPort));
    return db;
}

// Start from an empty database. Without this a document left by an earlier run is already present
// (and already committed) when the listener attaches, so the assertions below would be reading the
// previous run's state rather than this one's.
beforeAll(async () => {
    if (!emulatorAvailable) return;
    await fetch(
        `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
        { method: 'DELETE' }
    );
}, 30_000);

afterAll(async () => {
    await Promise.all(apps.map((app) => deleteApp(app).catch(() => undefined)));
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
        const db = emulatorDb('pending-a');
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
        const db = emulatorDb('pending-b');
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
