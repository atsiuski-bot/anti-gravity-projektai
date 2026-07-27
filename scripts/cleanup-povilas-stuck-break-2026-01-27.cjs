#!/usr/bin/env node
/*
 * One-time cleanup — delete Povilas's stuck-break telemetry glitch of 2026-01-27.
 * ------------------------------------------------------------------------------
 * WHY: on 2026-01-27 Povilas's break timer malfunctioned and re-persisted a *new*
 * completed break_sessions row on (effectively) every tick, all sharing the SAME
 * startTime 2026-01-27T13:59:51.361Z but with progressively later endTimes. The result
 * is ~300 phantom rows totalling ≈7000 break-minutes (≈117 h) for a single afternoon —
 * a pure system fault that grossly inflates his break time in every report. The fix is
 * to delete the glitch cluster.
 *
 * EXACTLY WHAT IS DELETED — and what is KEPT:
 *   • DELETE: break_sessions where userId == Povilas AND startTime == the glitch instant
 *     (STUCK_START below). These are the duplicates and nothing else shares that instant.
 *   • KEEP:   every other break, including Povilas's one legitimate 2026-01-27 break that
 *     started 2026-01-27T08:22:50.590Z. The selector pins startTime, so that row is untouched.
 *
 * SAFETY (mirrors scripts/migrate-legacy-session-userid.cjs):
 *   • DRY-RUN by default — prints the count + samples and writes NOTHING. Pass --apply to delete.
 *   • PROJECT GUARD — aborts unless the credentials resolve to the WORKZ project (darbo-planavimas).
 *   • OWNER + INSTANT PINNED — only rows matching BOTH the userId and the exact glitch startTime
 *     are eligible; the legitimate 08:22 break (different startTime) can never be selected.
 *   • IDEMPOTENT — re-running after --apply simply finds nothing left to delete.
 *
 * RUN (human-operated). Two credential modes — pick one:
 *   (A) ADC via gcloud (no key file needed; uses your firebase/gcloud login):
 *         gcloud auth application-default login        # once, sign in as audrius@medievalclub.org
 *         node scripts/cleanup-povilas-stuck-break-2026-01-27.cjs            # dry-run (no writes)
 *         node scripts/cleanup-povilas-stuck-break-2026-01-27.cjs --apply    # commit the deletes
 *   (B) Service-account key:
 *         GOOGLE_APPLICATION_CREDENTIALS=/path/to/darbo-planavimas-sa.json \
 *           node scripts/cleanup-povilas-stuck-break-2026-01-27.cjs [--apply]
 * (Needs `firebase-admin` resolvable, e.g. run from a dir where `npm i firebase-admin` was done.)
 */

const admin = require('firebase-admin');
const fs = require('fs');

const EXPECTED_PROJECT = 'darbo-planavimas';
const COLLECTION = 'break_sessions';
const POVILAS_UID = 'LmBETqta7iVHpYcrrpeB8loVhwX2';
const STUCK_START = '2026-01-27T13:59:51.361Z'; // the glitch instant every phantom row shares
// Extra single, explicitly-identified glitch rows to delete by document id. Each is guard-checked
// to belong to POVILAS_UID before deletion, so a wrong id can never delete someone else's data.
//   1NQhfR6npY7s8jssBPFP — 2026-05-15 break 06:43:50 → 13:55:19, ≈431 min (forgotten break timer).
const EXTRA_DELETE_IDS = ['1NQhfR6npY7s8jssBPFP'];
const APPLY = process.argv.includes('--apply');
const BATCH_LIMIT = 400;

let db; // initialized in run(), AFTER the credentials are validated

// Resolve credentials and PIN the target project before any Firestore access — the load-bearing
// guard against touching the wrong project. Two supported modes:
//   (A) Service-account key  — GOOGLE_APPLICATION_CREDENTIALS points at a .json key. We read its
//       project_id and abort unless it is darbo-planavimas.
//   (B) ADC (gcloud login)   — no key file. firebase-admin uses Application Default Credentials
//       (e.g. `gcloud auth application-default login` as audrius@medievalclub.org). The project
//       is pinned explicitly to EXPECTED_PROJECT in initializeApp, so we can only ever read/write
//       darbo-planavimas regardless of the ADC quota project.
// Returns { project, options } for initializeApp.
function resolveCredentialsOrExit() {
    const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (keyPath) {
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
        return { project, options: {} }; // SDK reads the key from the env var
    }
    // ADC mode — project is hard-pinned, so the wrong-project risk does not apply.
    console.log('No GOOGLE_APPLICATION_CREDENTIALS — using Application Default Credentials (gcloud).');
    return { project: EXPECTED_PROJECT, options: { projectId: EXPECTED_PROJECT } };
}

async function run() {
    const { project, options } = resolveCredentialsOrExit();
    admin.initializeApp(options);
    db = admin.firestore();
    console.log(`\nCredentials project : ${project}`);
    console.log(`Mode                : ${APPLY ? 'APPLY (will DELETE)' : 'DRY-RUN (no writes)'}`);
    console.log(`Target              : ${COLLECTION} userId == ${POVILAS_UID}`);
    console.log(`                      • cluster: startTime == ${STUCK_START}`);
    console.log(`                      • extra by id: ${EXTRA_DELETE_IDS.join(', ')} (guard-checked owner)\n`);

    // Query on userId only (single-field, auto-indexed — no composite index needed) and pin the
    // exact glitch instant in memory. Belt-and-suspenders: this guarantees the legitimate 08:22
    // break (different startTime) is filtered out before anything is ever marked for deletion.
    const snap = await db.collection(COLLECTION).where('userId', '==', POVILAS_UID).get();
    const clusterDocs = snap.docs.filter((d) => d.data().startTime === STUCK_START);

    // Resolve the extra by-id rows, guard-checking ownership. Any id that is missing or owned by
    // someone other than Povilas is skipped with a loud warning rather than deleted.
    const extraDocs = [];
    for (const id of EXTRA_DELETE_IDS) {
        const got = await db.collection(COLLECTION).doc(id).get();
        if (!got.exists) {
            console.warn(`  ! SKIP ${id}: document does not exist (already deleted?).`);
            continue;
        }
        if (got.data().userId !== POVILAS_UID) {
            console.warn(`  ! SKIP ${id}: owned by ${got.data().userId}, not Povilas — refusing to delete.`);
            continue;
        }
        extraDocs.push(got);
    }

    const docs = [...clusterDocs, ...extraDocs];
    const totalMinutes = docs.reduce((s, d) => s + (Number(d.data().durationMinutes) || 0), 0);

    console.log(`Matched ${clusterDocs.length} cluster rows + ${extraDocs.length} extra by-id rows = ${docs.length} total (≈${Math.round(totalMinutes)} break-minutes).`);
    console.log('Samples (id | startTime | endTime | durationMinutes):');
    docs.slice(0, 10).forEach((d) => {
        const x = d.data();
        console.log(`  ${d.id} | ${x.startTime} | ${x.endTime} | ${Number(x.durationMinutes).toFixed(2)}`);
    });

    if (!APPLY) {
        console.log(`\nDRY-RUN complete — would DELETE ${docs.length} documents. Re-run with --apply to commit.`);
        process.exit(0);
    }

    let deleted = 0;
    let batch = db.batch();
    let inBatch = 0;
    for (const d of docs) {
        batch.delete(d.ref);
        inBatch += 1;
        deleted += 1;
        if (inBatch >= BATCH_LIMIT) {
            await batch.commit();
            batch = db.batch();
            inBatch = 0;
        }
    }
    if (inBatch > 0) await batch.commit();

    console.log(`\n✔ DELETED ${deleted} documents. The legitimate 08:22:50 break is untouched.`);
    process.exit(0);
}

run().catch((err) => {
    console.error('FATAL:', err && err.message ? err.message : err);
    process.exit(1);
});
