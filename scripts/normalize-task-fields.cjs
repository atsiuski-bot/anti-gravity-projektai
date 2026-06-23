#!/usr/bin/env node
/*
 * One-time backfill — normalize legacy task data hygiene on `tasks` + `archived_tasks`.
 * ---------------------------------------------------------------------------------------------
 * WHY: the data audit found ~47% of tasks carry a non-canonical priority casing (Medium vs MEDIUM,
 * 6 spellings) and that `estimatedTimeMinutes` was never persisted on the create path, so every
 * report and the time-limit monitor re-parsed a free-text string. The WRITE path is now fixed
 * (priority canonicalized + estimatedTimeMinutes written on create), but ~5 months of historical
 * rows remain forked. This heals the back catalogue so consumers can stop defensively re-casing /
 * re-parsing, and so reports over past periods read a clean numeric estimate.
 *
 * SCOPE — touches ONLY two fields, never timer/assignee/duration/status (so it cannot re-trip the
 * data-durability concerns):
 *   • priority            → the canonical UPPERCASE token (mirror of src/utils/priority.js).
 *   • estimatedTimeMinutes → parsed from estimatedTime when absent (mirror of timeUtils parser).
 * Rows whose estimatedTime is present but UNPARSEABLE (parses to 0) are NOT guessed — they are
 * reported for human triage.
 *
 * SAFETY:
 *   • DRY-RUN by default — prints what it would change and writes NOTHING. Pass --apply to write.
 *   • PROJECT GUARD — aborts unless the credentials resolve to WORKZ (darbo-planavimas).
 *   • IDEMPOTENT — only writes a doc whose priority/estimate actually differs; safe to re-run.
 *   • Backups/PITR are live (ADR 0011), so a mistake is recoverable — but run on a known-good baseline.
 *
 * RUN (human-operated — needs a darbo-planavimas service-account key):
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/darbo-planavimas-sa.json \
 *     node scripts/normalize-task-fields.cjs            # dry-run (no writes)
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/darbo-planavimas-sa.json \
 *     node scripts/normalize-task-fields.cjs --apply    # commit
 * (Needs `firebase-admin` resolvable, e.g. run from the functions/ dir or a dir with it installed.)
 */

const admin = require('firebase-admin');
const fs = require('fs');

const EXPECTED_PROJECT = 'darbo-planavimas';
const APPLY = process.argv.includes('--apply');
const BATCH_LIMIT = 400;
const COLLECTIONS = ['tasks', 'archived_tasks'];

admin.initializeApp();
const db = admin.firestore();

// --- Canonical priority — MIRROR of src/utils/priority.js normalizePriority. ---
const PRIORITIES = ['URGENT', 'HIGH', 'MEDIUM', 'LOW', 'VERY_LOW'];
function normalizePriority(p) {
    if (!p) return 'MEDIUM';
    const up = String(p).toUpperCase();
    return PRIORITIES.includes(up) ? up : 'MEDIUM';
}

// --- Parse estimate to minutes — MIRROR of src/utils/timeUtils.js parseTimeStringToMinutes
// (comma decimals "1,5h" + the Lithuanian "val" suffix). Returns 0 when unparseable. ---
function parseEstimateMinutes(str) {
    if (!str || typeof str !== 'string') return 0;
    const norm = str.trim().toLowerCase().replace(',', '.');
    const m = norm.match(/^(?:(\d+(?:\.\d+)?)\s*(?:h|val))?\s*(?:(\d+)\s*(?:m|min))?$/);
    if (!m) return 0;
    let total = 0;
    const hours = m[1] ? parseFloat(m[1]) : 0;
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    if (Number.isFinite(hours) && hours >= 0) total += hours * 60;
    if (Number.isFinite(mins) && mins >= 0) total += mins;
    return Number.isFinite(total) ? total : 0;
}

function projectFromKeyFile() {
    const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!p) return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8')).project_id || null;
    } catch {
        return null;
    }
}

function resolvedProject() {
    return (
        projectFromKeyFile() ||
        admin.app().options.projectId ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT ||
        process.env.FIREBASE_PROJECT ||
        null
    );
}

async function run() {
    const project = resolvedProject();
    console.log(`\nCredentials project : ${project || '(unknown)'}`);
    if (project && project !== EXPECTED_PROJECT) {
        console.error(
            `ABORT: connected to "${project}", expected "${EXPECTED_PROJECT}". ` +
                `Point GOOGLE_APPLICATION_CREDENTIALS at a ${EXPECTED_PROJECT} service-account key.`
        );
        process.exit(1);
    }
    if (!project) {
        console.warn('WARNING: could not confirm the project from the credentials. Verify before --apply.');
    }
    console.log(`Mode                : ${APPLY ? 'APPLY (will write)' : 'DRY-RUN (no writes)'}\n`);

    let priorityFixes = 0;
    let estimateFixes = 0;
    let docsWritten = 0;
    const ambiguous = []; // estimatedTime present but unparseable — needs human triage

    let batch = db.batch();
    let inBatch = 0;
    const flush = async (force) => {
        if (APPLY && (inBatch >= BATCH_LIMIT || (force && inBatch > 0))) {
            await batch.commit();
            batch = db.batch();
            inBatch = 0;
        }
    };

    for (const col of COLLECTIONS) {
        const snap = await db.collection(col).get();
        console.log(`${col} scanned: ${snap.size}`);

        for (const docSnap of snap.docs) {
            const d = docSnap.data();
            const update = {};

            // (1) Priority casing — only when a value exists and its canonical form differs.
            if (d.priority !== undefined && d.priority !== null) {
                const canon = normalizePriority(d.priority);
                if (canon !== d.priority) {
                    update.priority = canon;
                    priorityFixes += 1;
                }
            }

            // (2) estimatedTimeMinutes — populate when absent and the string parses to a real value.
            const hasNumericEstimate = typeof d.estimatedTimeMinutes === 'number' && Number.isFinite(d.estimatedTimeMinutes);
            if (!hasNumericEstimate && typeof d.estimatedTime === 'string' && d.estimatedTime.trim()) {
                const mins = parseEstimateMinutes(d.estimatedTime);
                if (mins > 0) {
                    update.estimatedTimeMinutes = mins;
                    estimateFixes += 1;
                } else if (ambiguous.length < 30) {
                    ambiguous.push(`  ${col}/${docSnap.id}: estimatedTime="${d.estimatedTime}" (unparseable)`);
                }
            }

            if (Object.keys(update).length === 0) continue;
            docsWritten += 1;
            if (APPLY) {
                batch.update(docSnap.ref, update);
                inBatch += 1;
                await flush(false);
            }
        }
    }
    await flush(true);

    console.log('\n=== Summary ===');
    console.log(`Priority casing fixes      : ${priorityFixes}`);
    console.log(`estimatedTimeMinutes filled: ${estimateFixes}`);
    console.log(`Docs ${APPLY ? 'written' : 'to write'}          : ${docsWritten}`);

    if (ambiguous.length) {
        console.log('\n=== Unparseable estimates (NOT changed — triage manually) ===');
        ambiguous.forEach((l) => console.log(l));
    }

    if (APPLY) {
        console.log(`\n✔ WROTE ${docsWritten} docs (${priorityFixes} priority, ${estimateFixes} estimate).`);
    } else {
        console.log(`\nDRY-RUN complete — would write ${docsWritten} docs. Re-run with --apply to commit.`);
    }
    process.exit(0);
}

run().catch((err) => {
    console.error('FATAL:', err && err.message ? err.message : err);
    process.exit(1);
});
