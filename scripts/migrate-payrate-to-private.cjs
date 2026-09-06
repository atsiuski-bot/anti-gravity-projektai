#!/usr/bin/env node
/*
 * One-time migration — move every worker's pay rate off the company-readable user document.
 * ---------------------------------------------------------------------------------------
 * WHY (audit R-10). `users/{uid}` is deliberately readable by every ACTIVE user: it is the roster
 * the whole app renders (names, colours, roles, overseer stamps), and `UsersContext` subscribes to
 * the entire collection app-wide. Firestore cannot project fields out of an allowed document read,
 * so ANY confidential field on that document is company-wide readable — and `payRate` (the NET
 * salary tier table, ADR 0012) was exactly that: every worker could read every colleague's salary.
 *
 * The fix moves the rate to its own document, `users/{uid}/private/payRate`, whose read rule is
 * scoped to the owner, their overseers and admins (firestore.rules → match /users/{userId}/private).
 * The client reads BOTH locations and prefers the private one (utils/payRateStore.js
 * `effectivePayRate`), so the app is correct before, during and after this migration. This script
 * finishes the job for users whose rate no admin has re-saved since the change:
 *
 *   1. copy `users/{uid}.payRate` → `users/{uid}/private/payRate`
 *   2. delete the inline `payRate` field from `users/{uid}`  ← the step that stops the leak
 *
 * ORDER MATTERS: the copy is committed before the delete, so an interrupted run can only ever
 * leave a readable duplicate (the pre-migration status quo), never a lost rate.
 *
 * SAFETY:
 *   • DRY-RUN by default — prints exactly what it would change and writes NOTHING. Pass --apply.
 *   • PROJECT GUARD — aborts unless the key file resolves to darbo-planavimas.
 *   • IDEMPOTENT — only touches users that still carry an inline `payRate`; safe to re-run.
 *   • NON-DESTRUCTIVE ON CONFLICT — if a private document already exists AND differs from the
 *     inline value, the user is REPORTED and SKIPPED rather than overwritten: a differing private
 *     copy means an admin already re-saved the rate through the app, and that newer value wins.
 *
 * AFTERWARDS, verify the leak is closed (read-only):
 *   node scripts/migrate-payrate-to-private.cjs          # dry-run again → must report 0 to migrate
 *
 * RUN (human-operated — a bulk production write, per CLAUDE.md; needs a darbo-planavimas
 * service-account key):
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/darbo-planavimas-sa.json \
 *     node scripts/migrate-payrate-to-private.cjs           # dry-run (no writes)
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/darbo-planavimas-sa.json \
 *     node scripts/migrate-payrate-to-private.cjs --apply   # commit
 * (Needs `firebase-admin` resolvable, e.g. run from the repo root after `npm i`.)
 *
 * NOTE ON ROLLOUT ORDER: deploy the RULES and the app build first, then run this. The rules add a
 * new match block and change nothing existing, so they are safe to deploy on their own; the app
 * reads both locations either way. Running this before the app ships would hide rates from any
 * still-cached old client until it updates.
 */

const admin = require('firebase-admin');
// firebase-admin 14 dropped the `admin.firestore()` / `admin.credential` namespaces from the
// default export; the modular entry point is the supported shape, and it is the same one
// functions/index.js already uses.
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const fs = require('fs');

const EXPECTED_PROJECT = 'darbo-planavimas';
const PRIVATE_COLLECTION = 'private';
const PAY_RATE_DOC_ID = 'payRate';
const APPLY = process.argv.includes('--apply');

let db; // initialized in run(), AFTER the credentials are validated

// Validate the service-account credentials BEFORE any Firestore access, reading the project id
// straight from the key file — not from lazily-populated SDK state, which is empty until the first
// request and would let a wrong-project key slip past.
function validateCredentialsOrExit() {
    const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!keyPath) {
        console.error('ABORT: GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a darbo-planavimas service-account key (.json).');
        process.exit(1);
    }
    if (!fs.existsSync(keyPath)) {
        console.error(`ABORT: key file not found: ${keyPath}`);
        process.exit(1);
    }
    let project = null;
    try {
        project = JSON.parse(fs.readFileSync(keyPath, 'utf8')).project_id || null;
    } catch {
        console.error(`ABORT: could not parse the key file as JSON: ${keyPath}`);
        process.exit(1);
    }
    if (project !== EXPECTED_PROJECT) {
        console.error(`ABORT: key is for project "${project || '(none)'}", expected "${EXPECTED_PROJECT}". Wrong key — fix GOOGLE_APPLICATION_CREDENTIALS.`);
        process.exit(1);
    }
    return project;
}

// Structural equality, order-sensitive for arrays (tier order is meaningful) — used only to decide
// whether an existing private copy is the SAME rate we would write.
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function run() {
    const project = validateCredentialsOrExit();
    // Bare initializeApp picks up Application Default Credentials, i.e. the key that
    // GOOGLE_APPLICATION_CREDENTIALS points at — already validated above.
    admin.initializeApp();
    db = getFirestore();

    console.log(`Project: ${project}`);
    console.log(APPLY ? 'MODE: APPLY (writes will be committed)' : 'MODE: DRY-RUN (no writes)');

    const users = await db.collection('users').get();
    console.log(`Scanned ${users.size} user document(s).`);

    const toMigrate = [];
    const conflicts = [];
    let alreadyClean = 0;

    for (const userDoc of users.docs) {
        const inline = userDoc.get(PAY_RATE_DOC_ID);
        if (inline === undefined || inline === null) { alreadyClean += 1; continue; }

        const privateRef = userDoc.ref.collection(PRIVATE_COLLECTION).doc(PAY_RATE_DOC_ID);
        const existing = await privateRef.get();
        if (existing.exists && !sameValue(existing.data(), inline)) {
            conflicts.push({ id: userDoc.id, name: userDoc.get('displayName') || userDoc.get('email') || userDoc.id });
            continue;
        }
        toMigrate.push({ id: userDoc.id, name: userDoc.get('displayName') || userDoc.get('email') || userDoc.id, inline, privateRef, ref: userDoc.ref, alreadyCopied: existing.exists });
    }

    console.log(`\nNo inline payRate (nothing to do): ${alreadyClean}`);
    console.log(`To migrate: ${toMigrate.length}`);
    for (const u of toMigrate) {
        const tariffs = Array.isArray(u.inline?.rates) ? u.inline.rates.length : (Array.isArray(u.inline?.tiers) ? 1 : 0);
        console.log(`  • ${u.name} (${u.id}) — ${tariffs} tariff(s)${u.alreadyCopied ? ' [private copy already identical — only the inline field is removed]' : ''}`);
    }
    if (conflicts.length) {
        console.log(`\nSKIPPED — a DIFFERENT private rate already exists (an admin re-saved it through the app; that newer value wins): ${conflicts.length}`);
        for (const c of conflicts) console.log(`  • ${c.name} (${c.id})`);
        console.log('  To clear their stale inline copy, verify the private rate in the app first, then re-run with --apply after removing this guard for that user.');
    }

    if (!APPLY) {
        console.log('\nDRY-RUN complete — nothing was written. Re-run with --apply to commit.');
        return;
    }
    if (toMigrate.length === 0) {
        console.log('\nNothing to migrate.');
        return;
    }

    // Copy first, delete second, per user. Two commits rather than one batch on purpose: if the run
    // is interrupted, the worst reachable state is "rate exists in both places" — the pre-migration
    // status quo — never "rate deleted before it was copied".
    let copied = 0;
    let cleared = 0;
    for (const u of toMigrate) {
        if (!u.alreadyCopied) {
            await u.privateRef.set(u.inline);
            copied += 1;
        }
        await u.ref.update({ [PAY_RATE_DOC_ID]: FieldValue.delete() });
        cleared += 1;
        console.log(`  ✓ ${u.name} (${u.id})`);
    }

    console.log(`\nAPPLIED. Private documents written: ${copied}. Inline fields removed: ${cleared}.`);
    console.log('Re-run without --apply to confirm 0 remain.');
}

run().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
