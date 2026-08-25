/**
 * Deploy-style DISCOVERY LOAD of functions/index.js.
 *
 * WHY THIS EXISTS. Nothing else in the release gate loads this file. `npm run test` (vitest) runs
 * against src/ and never enters functions/. The other functions/ suites cover pure-JS modules —
 * integrityScans.js and workDay.js have zero require() calls, and decisionLog.js has one lazy,
 * try/caught require of firebase-functions/logger — so none of them pull in firebase-admin or the
 * v2 trigger builders. The consequence: a firebase-admin / firebase-functions MAJOR BUMP could
 * pass the entire gate green while proving nothing, and only fail at `firebase deploy`, which is
 * the irreversible human-only step. That is exactly backwards. (Observed during the 2026-08-25
 * firebase-admin 13.10.0 -> 14.3.0 upgrade, where the only real evidence came from throwaway
 * probes.)
 *
 * WHAT THIS PROVES. Requiring index.js runs its whole module scope, which is where the SDK is
 * actually touched: initializeApp(), getFirestore(), setGlobalOptions(), defineSecret(), and the
 * v2 trigger builders that turn each export into a deployable endpoint. The Firebase CLI discovers
 * functions the same way — load the module, read `__endpoint` off every export — so a green run
 * here is the same evidence the deploy would gather, minus the deploy.
 *
 * The two env vars below are what the CLI sets during discovery. Without them the admin SDK has no
 * project to infer and initializeApp() throws. No credentials are involved and nothing is
 * contacted over the network: discovery only builds the endpoint descriptors.
 *
 * Runs on bare node, ~1s, no emulator: `node functions/discovery.test.cjs`.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Read installed versions off disk rather than require()-ing the manifest: firebase-admin v14
// dropped "./package.json" from its exports map, so require('firebase-admin/package.json') throws
// on exactly the versions this suite exists to vet. Printed (not asserted) so that when this file
// fails, the log already says which SDK produced the failure.
function installedVersion(pkg) {
    const manifest = path.join(__dirname, 'node_modules', pkg, 'package.json');
    try {
        return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    } catch {
        return '(not installed)';
    }
}
console.log(`discovery.test: firebase-admin ${installedVersion('firebase-admin')}, firebase-functions ${installedVersion('firebase-functions')}`);

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-workz-timer';
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'demo-workz-timer' });

// The load itself is the first assertion: module scope calls initializeApp() and getFirestore(),
// so a breaking change in either surfaces here as a throw rather than at deploy time.
const mod = require('./index.js');

const TRIGGER_KINDS = ['eventTrigger', 'callableTrigger', 'scheduleTrigger', 'httpsTrigger', 'taskQueueTrigger', 'blockingTrigger'];

const names = Object.keys(mod);
const counts = {};

for (const name of names) {
    const endpoint = mod[name] && mod[name].__endpoint;
    // An export without __endpoint is not deployable — the CLI would silently skip it.
    assert.ok(endpoint, `export "${name}" has no __endpoint — it would not deploy as a function`);

    const kinds = TRIGGER_KINDS.filter((kind) => endpoint[kind] !== undefined);
    assert.strictEqual(kinds.length, 1, `export "${name}" resolved to ${kinds.length} trigger kinds (${kinds.join('+') || 'none recognised'})`);
    counts[kinds[0]] = (counts[kinds[0]] || 0) + 1;

    // gcfv2 proves the v2 builders produced the endpoint; region + maxInstances prove the
    // module-scope setGlobalOptions() actually applied to it. A bump that quietly stopped applying
    // global options would deploy every function to us-central1 with default scaling — live, and
    // only visible after the fact.
    assert.strictEqual(endpoint.platform, 'gcfv2', `export "${name}" is not a 2nd-gen endpoint`);
    assert.deepStrictEqual(endpoint.region, ['europe-west1'], `export "${name}" is not pinned to europe-west1`);
    assert.strictEqual(endpoint.maxInstances, 10, `export "${name}" has maxInstances ${endpoint.maxInstances}, not the global 10 — either setGlobalOptions stopped applying, or this function was given a deliberate per-function override (in which case relax this assertion for it)`);
}

// defineSecret() binds at module scope; the binding only shows up on the endpoint that declares it.
// If this stops resolving, parseTaskDraft deploys without its key and fails at runtime, not deploy.
const draftSecrets = (mod.parseTaskDraft.__endpoint.secretEnvironmentVariables || []).map((s) => s.key);
assert.deepStrictEqual(draftSecrets, ['OPENROUTER_API_KEY'], 'parseTaskDraft lost its defineSecret binding');

// SHAPE LEDGER — update these four numbers deliberately when a function is added or removed.
// The counts are not busywork: they are the only thing that catches an export DISAPPEARING (a bad
// merge, a rename, a module-scope throw swallowed by a refactor). Without them, "every export has
// an __endpoint" stays trivially true for the survivors while the deploy quietly drops a function.
const EXPECTED = { total: 24, eventTrigger: 15, callableTrigger: 3, scheduleTrigger: 6 };
assert.strictEqual(names.length, EXPECTED.total, `expected ${EXPECTED.total} deployable functions, found ${names.length} — if this change was intentional, update the ledger in ${path.basename(__filename)}`);
assert.strictEqual(counts.eventTrigger, EXPECTED.eventTrigger, `eventTrigger count moved to ${counts.eventTrigger} — update the ledger if intentional`);
assert.strictEqual(counts.callableTrigger, EXPECTED.callableTrigger, `callableTrigger count moved to ${counts.callableTrigger} — update the ledger if intentional`);
assert.strictEqual(counts.scheduleTrigger, EXPECTED.scheduleTrigger, `scheduleTrigger count moved to ${counts.scheduleTrigger} — update the ledger if intentional`);

console.log(`discovery.test: OK — ${names.length} endpoints (${counts.eventTrigger} event, ${counts.callableTrigger} callable, ${counts.scheduleTrigger} schedule), all gcfv2 in europe-west1`);
