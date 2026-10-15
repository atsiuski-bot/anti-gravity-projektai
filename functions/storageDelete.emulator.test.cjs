/**
 * Emulator ROUND-TRIP of the attachment-delete path in functions/index.js (deleteObjects).
 *
 * WHY THIS EXISTS. deleteObjects() is the ONLY Storage call the functions make:
 * `bucket.file(path).delete()`, with a 404 swallowed as "already gone" and any other error logged
 * as a WARNING and dropped. That makes a broken Storage client SILENT — no trigger fails, no retry
 * fires, the attachment (often a completion photo of a client's premises) simply stays in the
 * bucket forever. Nothing else in the gate touches Storage, so a firebase-admin /
 * @google-cloud/storage / gaxios / uuid bump could break this without any test going red. (The
 * 2026-10-12 audit floored uuid to ^11 under gaxios 6 via an npm override; this is the permanent
 * form of the one-off proof that the override left the delete path working.)
 *
 * WHAT THIS PROVES, against a real Storage emulator round-trip:
 *   1. the REAL deleteObjects() — reached through the exported cleanupAttachmentsOnTaskUpdate
 *      trigger's .run(), so URL parsing, the bucket guard and the owner guard are all the
 *      deployed code — removes an `attachments/<uid>/…` object and logs no warning;
 *   2. a second delete of the same object fails with code 404 at the SDK level, the exact shape
 *      deleteObjects() matches to treat a gone object as success;
 *   3. replaying the trigger on the now-missing object therefore logs no warning either.
 *
 * MUST run against the emulator, and against functions/node_modules (the DEPLOYED SDK copy). Both
 * conditions are asserted below rather than assumed.
 *
 * Run: firebase emulators:exec --project demo-workz-timer --only storage "node functions/storageDelete.emulator.test.cjs"
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// --- preconditions ---------------------------------------------------------
// Fail LOUDLY, never skip — and never let this run against the real bucket.
if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    console.error('storageDelete.emulator.test: FIREBASE_STORAGE_EMULATOR_HOST is not set — run this through `firebase emulators:exec`, not bare node.');
    process.exit(1);
}

const adminEntry = require.resolve('firebase-admin');
const functionsModules = path.join(__dirname, 'node_modules') + path.sep;
assert.ok(adminEntry.startsWith(functionsModules), `firebase-admin resolved to ${adminEntry}, outside functions/node_modules — this run would vet the wrong SDK copy`);

const PROJECT = 'demo-workz-timer';
const BUCKET = `${PROJECT}.appspot.com`;
// index.js calls a bare initializeApp(), which takes its default bucket from FIREBASE_CONFIG —
// exactly as in production, where the platform sets it.
process.env.GCLOUD_PROJECT = PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT, storageBucket: BUCKET });

// Capture deleteObjects()' warning channel. Patched BEFORE index.js loads so its `logger` binding
// is this same module instance.
const logger = require('firebase-functions/logger');
const warnings = [];
logger.warn = (...args) => { warnings.push(args); };

const { cleanupAttachmentsOnTaskUpdate } = require('./index.js');
const { getStorage } = require('firebase-admin/storage');
const bucket = getStorage().bucket();
assert.strictEqual(bucket.name, BUCKET, `default bucket is ${bucket.name}, not ${BUCKET} — deleteObjects' bucket guard would ignore every URL`);

const OWNER = 'storage-smoke-uid';
const OBJECT_PATH = `attachments/${OWNER}/smoke-${Date.now()}.jpg`;
const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(OBJECT_PATH)}?alt=media&token=t`;

// The in-modal removal event: the attachment was on the task before, gone after.
function removalEvent() {
    const before = { assignedUserId: OWNER, attachmentUrls: [url] };
    const after = { assignedUserId: OWNER, attachmentUrls: [] };
    return { params: { id: 'storage-smoke' }, data: { before: { data: () => before }, after: { data: () => after } } };
}

const checks = [];
function check(name, fn) {
    checks.push({ name, fn });
}

check('the real deleteObjects() removes an attachments/<uid>/ object without a warning', async () => {
    const file = bucket.file(OBJECT_PATH);
    await file.save(Buffer.from('smoke'), { contentType: 'image/jpeg' });
    assert.strictEqual((await file.exists())[0], true, 'upload did not land — nothing to delete');

    await cleanupAttachmentsOnTaskUpdate.run(removalEvent());

    assert.deepStrictEqual(warnings, [], `deleteObjects logged a warning: ${JSON.stringify(warnings)}`);
    assert.strictEqual((await file.exists())[0], false, 'object still exists after deleteObjects() — the delete path is broken, and in production it would fail silently');
});

check('deleting a missing object reports code 404 in the shape deleteObjects() matches', async () => {
    let err = null;
    try {
        await bucket.file(OBJECT_PATH).delete();
    } catch (e) {
        err = e;
    }
    assert.ok(err, 'deleting a missing object unexpectedly succeeded');
    assert.strictEqual(err.code, 404, `missing-object delete reported code ${JSON.stringify(err.code)}; deleteObjects() treats only 404 as "already gone", so every replay would log a false warning`);
});

check('replaying the trigger on an already-gone object stays silent', async () => {
    await cleanupAttachmentsOnTaskUpdate.run(removalEvent());
    assert.deepStrictEqual(warnings, [], `already-gone object produced a warning: ${JSON.stringify(warnings)}`);
});

// --- MIRROR LOCK ------------------------------------------------------------
// Check 2 restates deleteObjects()' 404 predicate; make sure index.js still uses it.
check('the 404 guard in index.js still matches what this suite vets', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    assert.ok(
        source.includes('if (err && err.code !== 404) logger.warn('),
        'deleteObjects() no longer guards on err.code !== 404 — this suite may be vetting a predicate the code no longer uses',
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
        console.error(`storageDelete.emulator.test: ${failed} of ${checks.length} checks FAILED`);
        process.exit(1);
    }
    console.log(`storageDelete.emulator.test: OK — ${checks.length} checks against the Storage emulator with the SDK in functions/node_modules`);
    process.exit(0);
})();
