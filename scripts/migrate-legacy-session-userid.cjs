#!/usr/bin/env node
/*
 * One-time migration — stamp `userId` (+ `teamManagerIds`) onto legacy go-live sessions.
 * ---------------------------------------------------------------------------------------
 * WHY: the earliest production sessions (≈2026-01-04 → 2026-03-31, the go-live quarter) were
 * written with the OLD owner field `workerId` and carry NO `userId` and NO `teamManagerIds`.
 * The schema later switched to `userId` (first `userId` rows appear 2026-04-02). Because every
 * scoped query keys on `userId` / `teamManagerIds`, those legacy rows are invisible to:
 *   • a worker viewing their OWN history (query is where('userId','==',uid)), and
 *   • a scoped manager / senior (query is where('teamManagerIds','array-contains',uid)),
 * and they are dropped by any raw-`userId` client bucketing (useWorkerStats / Suvestinė).
 * Setting userId = workerId and stamping the owner's CURRENT overseer closure heals all of it,
 * permanently and app-wide. The data is finite (a fixed historical quarter), so this is run once.
 *
 * SAFETY:
 *   • DRY-RUN by default — prints exactly what it would change and writes NOTHING. Pass --apply to write.
 *   • PROJECT GUARD — aborts unless the credentials resolve to the WORKZ project (darbo-planavimas).
 *   • IDEMPOTENT — only touches rows that have `workerId` and lack `userId`; safe to re-run.
 *   • Per-field — never overwrites an existing `userId`; only fills a missing/empty `teamManagerIds`.
 *
 * teamManagerIds is computed with the SAME rule as the deployed Cloud Function `overseersFor`
 * (functions/index.js): worker → direct managers ∪ each manager's seniors; manager → own seniors;
 * senior/admin → []. Stamping the CURRENT closure onto old rows is the established full-history
 * behaviour (ADR 0005/0007). Running the existing `backfillTeamStamps` callable afterwards is a
 * harmless no-op (its sameSet guard sees the stamp already correct).
 *
 * RUN (human-operated — needs a darbo-planavimas service-account key):
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/darbo-planavimas-sa.json \
 *     node scripts/migrate-legacy-session-userid.cjs            # dry-run (no writes)
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/darbo-planavimas-sa.json \
 *     node scripts/migrate-legacy-session-userid.cjs --apply    # commit
 * (Needs `firebase-admin` resolvable, e.g. run from a dir where `npm i firebase-admin` was done.)
 */

const admin = require('firebase-admin');

const EXPECTED_PROJECT = 'darbo-planavimas';
const COLLECTIONS = ['work_sessions', 'break_sessions'];
const APPLY = process.argv.includes('--apply');
const BATCH_LIMIT = 400;

admin.initializeApp();
const db = admin.firestore();

function resolvedProject() {
    return (
        admin.app().options.projectId ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT ||
        process.env.FIREBASE_PROJECT ||
        null
    );
}

// Mirror of functions/index.js overseersFor(uid). Cached: only ~roster-sized number of reads.
const overseerCache = new Map();
async function overseersFor(uid) {
    if (!uid) return [];
    if (overseerCache.has(uid)) return overseerCache.get(uid);
    let result = [];
    try {
        const snap = await db.collection('users').doc(uid).get();
        if (snap.exists) {
            const u = snap.data();
            const role = u.role || 'worker';
            if (role === 'manager') {
                result = Array.isArray(u.seniorManagerIds) ? u.seniorManagerIds.filter(Boolean) : [];
            } else if (role === 'seniorManager' || role === 'admin' || role === 'Administratorius') {
                result = [];
            } else {
                const mgrs = Array.isArray(u.teamManagerIds) ? u.teamManagerIds.filter(Boolean) : [];
                const set = new Set(mgrs);
                for (const m of mgrs) {
                    try {
                        const ms = await db.collection('users').doc(m).get();
                        const seniors = ms.exists ? ms.data().seniorManagerIds : null;
                        if (Array.isArray(seniors)) seniors.filter(Boolean).forEach((s) => set.add(s));
                    } catch {
                        /* missing manager doc — skip */
                    }
                }
                result = [...set];
            }
        }
    } catch {
        /* missing user doc — leave [] */
    }
    overseerCache.set(uid, result);
    return result;
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
        console.warn(
            'WARNING: could not confirm the project from the credentials. ' +
                'Verify the sample rows below belong to WORKZ before running with --apply.'
        );
    }
    console.log(`Mode                : ${APPLY ? 'APPLY (will write)' : 'DRY-RUN (no writes)'}\n`);

    let totalLegacy = 0;
    let totalWritten = 0;
    const perWorker = {}; // workerId -> count
    const samples = [];

    for (const col of COLLECTIONS) {
        process.stdout.write(`Scanning ${col} … `);
        const snap = await db.collection(col).get();
        let scanned = 0;
        let legacyHere = 0;
        let batch = db.batch();
        let inBatch = 0;

        for (const doc of snap.docs) {
            scanned += 1;
            const d = doc.data();
            const isLegacy = d.workerId && !d.userId; // the selector — has old field, lacks new
            if (!isLegacy) continue;
            legacyHere += 1;
            totalLegacy += 1;
            perWorker[d.workerId] = (perWorker[d.workerId] || 0) + 1;

            const update = { userId: d.workerId };
            const hasTeam = Array.isArray(d.teamManagerIds) && d.teamManagerIds.length > 0;
            if (!hasTeam) update.teamManagerIds = await overseersFor(d.workerId);

            if (samples.length < 10) {
                samples.push({ col, id: doc.id, date: d.date || '(no date)', set: update });
            }

            if (APPLY) {
                batch.update(doc.ref, update);
                inBatch += 1;
                totalWritten += 1;
                if (inBatch >= BATCH_LIMIT) {
                    await batch.commit();
                    batch = db.batch();
                    inBatch = 0;
                }
            }
        }
        if (APPLY && inBatch > 0) await batch.commit();
        console.log(`${scanned} scanned, ${legacyHere} legacy.`);
    }

    console.log(`\n=== Legacy rows (workerId, no userId): ${totalLegacy} ===`);
    console.log('Per worker (rows → teamManagerIds that will be stamped):');
    const ids = Object.keys(perWorker).sort((a, b) => perWorker[b] - perWorker[a]);
    for (const uid of ids) {
        const ov = await overseersFor(uid);
        console.log(`  ${uid} : ${perWorker[uid]} rows → teamManagerIds=[${ov.join(', ') || '(none)'}]`);
    }

    console.log('\nSample writes:');
    samples.forEach((s) => console.log(`  ${s.col}/${s.id} (${s.date}) -> ${JSON.stringify(s.set)}`));

    if (APPLY) {
        console.log(`\n✔ WROTE ${totalWritten} documents.`);
    } else {
        console.log(`\nDRY-RUN complete — would write ${totalLegacy} documents. Re-run with --apply to commit.`);
    }
    process.exit(0);
}

run().catch((err) => {
    console.error('FATAL:', err && err.message ? err.message : err);
    process.exit(1);
});
