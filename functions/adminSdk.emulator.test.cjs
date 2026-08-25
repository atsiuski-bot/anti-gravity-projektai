/**
 * Emulator ROUND-TRIP of the firebase-admin behaviours functions/index.js depends on.
 *
 * WHY THIS EXISTS — and why discovery.test.cjs is not enough. Loading index.js proves the module
 * still BUILDS. It does not exercise a single Firestore call. The calls that matter here are the
 * ones whose failure is SILENT:
 *
 *   createIfAbsent           (index.js:2440, guard at :2445) — swallows err.code 6 / 'already-exists'
 *   notifyOverEstimateTimers (index.js:2362)                 — same predicate, `continue`
 *   writeStamp               (index.js:1269, guard at :1273) — swallows err.code 5 / 'not-found'
 *
 * Each of those catch blocks decides "this is the expected dedup / the row is gone, stop" purely by
 * matching an error CODE. If a major SDK bump changed the code's shape, nothing would crash. The
 * guard would simply MISS: the branch falls through to `throw`, the trigger reports failure, and
 * because these triggers retry, the platform re-runs them against a document that will never
 * satisfy them — retrying for days. That is a production incident that no build-time check and no
 * amount of "it deployed fine" can see.
 *
 * So the codes are asserted against a REAL server round-trip, not a mock. A mock would only prove
 * that we still believe what we believed when we wrote it.
 *
 * Also round-tripped: runTransaction (9 call sites), bulkWriter (index.js:1408) and batch
 * (index.js:3421) — the write paths that carry the counter reconciliation and the team restamp.
 *
 * MUST run against the emulator, and against functions/node_modules — this file lives in
 * functions/ precisely so node resolves the DEPLOYED SDK copy, not the app's devDependency. Both
 * conditions are asserted below rather than assumed.
 *
 * Run: firebase emulators:exec --project demo-workz-timer --only firestore "node functions/adminSdk.emulator.test.cjs"
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// --- preconditions ---------------------------------------------------------
// Fail LOUDLY, never skip. A suite that self-skips when its environment is missing reports green
// and proves nothing — the exact trap that let the emulator-only files sit unexercised under
// `npm test` for months.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('adminSdk.emulator.test: FIRESTORE_EMULATOR_HOST is not set — run this through `firebase emulators:exec`, not bare node.');
    process.exit(1);
}

// Prove we loaded the SDK that actually deploys. Root node_modules carries its own firebase-admin
// as a devDependency, so a file placed anywhere else would silently vet the wrong copy.
const adminEntry = require.resolve('firebase-admin');
const functionsModules = path.join(__dirname, 'node_modules') + path.sep;
assert.ok(adminEntry.startsWith(functionsModules), `firebase-admin resolved to ${adminEntry}, outside functions/node_modules — this run would vet the wrong SDK copy`);

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp({ projectId: 'demo-workz-timer' });
const db = getFirestore();

const COL = '_smoke_admin_sdk';

const checks = [];
function check(name, fn) {
    checks.push({ name, fn });
}

// --- the ALREADY_EXISTS guard (createIfAbsent, notifyOverEstimateTimers) ----
// A re-fired scan recomputes the same deterministic id and hits this path. It is the normal dedup
// route, taken on every retry — so the code it reports has to keep matching the guard.
check('duplicate create() reports ALREADY_EXISTS in the shape the guards match', async () => {
    const ref = db.collection(COL).doc('dup');
    await ref.create({ first: true });

    let err = null;
    try {
        await ref.create({ second: true });
    } catch (e) {
        err = e;
    }
    assert.ok(err, 'second create() unexpectedly succeeded — the dedup guards rely on it throwing');
    assert.ok(
        err.code === 6 || err.code === 'already-exists',
        `duplicate create() reported code ${JSON.stringify(err.code)}; index.js:2445 and :2362 match only 6 / 'already-exists', so this change would make both guards MISS and retry forever`,
    );

    // The winner's data must survive — create() must not have partially applied the loser.
    const snap = await ref.get();
    assert.strictEqual(snap.data().first, true);
    assert.strictEqual(snap.data().second, undefined);
});

// --- the NOT_FOUND guard (writeStamp) --------------------------------------
// A session row can be hard-deleted between its create event and the stamp handler (the recovery
// banner's "Nedirbau" does exactly that within seconds). The guard turns that into "done".
check('update() on a missing doc reports NOT_FOUND in the shape the guard matches', async () => {
    const ref = db.collection(COL).doc('never-created');

    let err = null;
    try {
        await ref.update({ teamManagerIds: ['x'] });
    } catch (e) {
        err = e;
    }
    assert.ok(err, 'update() on a missing document unexpectedly succeeded');
    assert.ok(
        err.code === 5 || err.code === 'not-found',
        `update() on a missing doc reported code ${JSON.stringify(err.code)}; index.js:1273 matches only 5 / 'not-found', so writeStamp would retry a row that will never exist again`,
    );
});

// --- runTransaction (9 call sites) -----------------------------------------
check('runTransaction round-trips a read-modify-write', async () => {
    const ref = db.collection(COL).doc('counter');
    await ref.set({ minutes: 10 });

    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        assert.strictEqual(snap.exists, true, 'transaction read lost the document');
        tx.update(ref, { minutes: snap.data().minutes + 5 });
    });

    assert.strictEqual((await ref.get()).data().minutes, 15);

    // Reading a missing doc inside a transaction must yield exists:false, not throw — several call
    // sites branch on exactly this instead of catching.
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(db.collection(COL).doc('absent-in-tx'));
        assert.strictEqual(snap.exists, false);
    });
});

// --- bulkWriter (index.js:1408, the team restamp) --------------------------
check('bulkWriter applies queued updates and settles on close()', async () => {
    const ids = ['bw1', 'bw2', 'bw3'];
    await Promise.all(ids.map((id) => db.collection(COL).doc(id).set({ teamManagerIds: [] })));

    const writer = db.bulkWriter();
    for (const id of ids) {
        writer.update(db.collection(COL).doc(id), { teamManagerIds: ['mgr'] });
    }
    await writer.close(); // close() must flush AND await — restampUserRows returns straight after

    for (const id of ids) {
        const snap = await db.collection(COL).doc(id).get();
        assert.deepStrictEqual(snap.data().teamManagerIds, ['mgr'], `bulkWriter update did not land on ${id}`);
    }
});

// --- batch (index.js:3421) --------------------------------------------------
check('batch commits set and update atomically', async () => {
    const a = db.collection(COL).doc('batch-a');
    const b = db.collection(COL).doc('batch-b');
    await b.set({ keep: 'yes', status: 'old' });

    const batch = db.batch();
    batch.set(a, { created: true });
    batch.update(b, { status: 'new' });
    await batch.commit();

    assert.strictEqual((await a.get()).data().created, true);
    const bData = (await b.get()).data();
    assert.strictEqual(bData.status, 'new');
    assert.strictEqual(bData.keep, 'yes', 'batch update() must merge, not replace');
});

// --- MIRROR LOCK ------------------------------------------------------------
// The predicates above are RESTATED here rather than imported — createIfAbsent and writeStamp are
// module-private, and exporting them purely for a test would widen the surface of index.js. The
// cost of restating is drift: index.js could change its guard while this file keeps vetting the old
// one and stays green. So assert the guards are still literally there, in the expected places.
check('the guard predicates in index.js still match what this suite vets', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const occurrences = (needle) => source.split(needle).length - 1;

    assert.strictEqual(
        occurrences("err.code === 6 || err.code === 'already-exists'"), 2,
        'the ALREADY_EXISTS guard no longer appears exactly twice in index.js (createIfAbsent, notifyOverEstimateTimers) — this suite may be vetting a predicate the code no longer uses',
    );
    assert.strictEqual(
        occurrences("err.code === 5 || err.code === 'not-found'"), 1,
        'the NOT_FOUND guard no longer appears exactly once in index.js (writeStamp) — this suite may be vetting a predicate the code no longer uses',
    );
});

// --- runner -----------------------------------------------------------------
(async () => {
    let failed = 0;
    for (const { name, fn } of checks) {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            failed += 1;
            console.error(`  FAIL ${name}\n       ${err.message}`);
        }
    }
    if (failed) {
        console.error(`adminSdk.emulator.test: ${failed} of ${checks.length} checks FAILED`);
        process.exit(1);
    }
    console.log(`adminSdk.emulator.test: OK — ${checks.length} checks against the SDK in functions/node_modules`);
    process.exit(0);
})();
