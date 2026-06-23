#!/usr/bin/env node
/*
 * One-time backfill — seed the overseer CLOSURE (`overseerIds`) on every user doc and re-stamp
 * each user's owned rows. SA-key mirror of the deployed `backfillTeamStamps` callable.
 * ---------------------------------------------------------------------------------------------
 * WHY: the four-level hierarchy (ADR 0007) gates CREATE/ASSIGN on the TARGET user's `overseerIds`
 * field (firestore.rules overseesUser()). In production that field was never materialized on the
 * user docs — every `users/{uid}` doc lacks `overseerIds`. Consequence: a SCOPED overseer (a
 * scoped manager OR a senior manager) cannot create or assign a task, nor log a time correction,
 * for their own people — `.get('overseerIds', [])` resolves to [] so the rule denies the write.
 * (Reads still work: the row-level `teamManagerIds` stamps and the client roster fallback cover
 * them; this is a WRITE-path gap.) Seeding the closure heals it permanently and app-wide.
 *
 * SAFETY:
 *   • DRY-RUN by default — prints exactly what it would change and writes NOTHING. Pass --apply to write.
 *   • PROJECT GUARD — aborts unless the credentials resolve to the WORKZ project (darbo-planavimas).
 *   • IDEMPOTENT — order-insensitive set compare; only writes a doc/row whose stamp actually differs.
 *     Safe to re-run. Running the deployed `backfillTeamStamps` callable afterwards is a no-op.
 *
 * The closure is computed with the SAME rule as the deployed Cloud Function `overseersFor`
 * (functions/index.js): worker → direct managers ∪ each manager's seniors; manager → own seniors;
 * senior/admin → []. This is the full-history behaviour (ADR 0005/0007).
 *
 * RUN (human-operated — needs a darbo-planavimas service-account key):
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/darbo-planavimas-sa.json \
 *     node scripts/backfill-overseer-ids.cjs            # dry-run (no writes)
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/darbo-planavimas-sa.json \
 *     node scripts/backfill-overseer-ids.cjs --apply    # commit
 * (Needs `firebase-admin` resolvable, e.g. run from a dir where `npm i firebase-admin` was done.)
 */

const admin = require('firebase-admin');
const fs = require('fs');

const EXPECTED_PROJECT = 'darbo-planavimas';
const APPLY = process.argv.includes('--apply');
const BATCH_LIMIT = 400;

// Owner field per owned collection — mirror of functions/index.js OWNED_COLLECTIONS.
const OWNED_COLLECTIONS = [
    { col: 'tasks', field: 'assignedUserId' },
    { col: 'archived_tasks', field: 'assignedUserId' },
    { col: 'deleted_tasks', field: 'assignedUserId' },
    { col: 'work_sessions', field: 'userId' },
    { col: 'break_sessions', field: 'userId' },
];

admin.initializeApp();
const db = admin.firestore();

// Read project_id straight from the service-account key JSON pointed to by
// GOOGLE_APPLICATION_CREDENTIALS. This is the authoritative source: applicationDefault()
// does NOT populate app.options.projectId from the key file, so without this the guard
// resolves to (unknown) and only warns instead of actually verifying the target project.
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

// Order-insensitive set equality — the arrays are sets, so reordering is not a change.
function sameSet(a, b) {
    if (a.length !== b.length) return false;
    const sb = new Set(b);
    return a.every((x) => sb.has(x));
}

// Mirror of functions/index.js overseersFor(uid). Cached: ~roster-sized number of reads.
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
                'Verify the summary below belongs to WORKZ before running with --apply.'
        );
    }
    console.log(`Mode                : ${APPLY ? 'APPLY (will write)' : 'DRY-RUN (no writes)'}\n`);

    const usersSnap = await db.collection('users').get();
    console.log(`Users scanned       : ${usersSnap.size}\n`);

    let userDocWrites = 0;
    let rowWrites = 0;
    const closureSamples = [];

    let batch = db.batch();
    let inBatch = 0;
    const flush = async (force) => {
        if (APPLY && (inBatch >= BATCH_LIMIT || (force && inBatch > 0))) {
            await batch.commit();
            batch = db.batch();
            inBatch = 0;
        }
    };

    for (const u of usersSnap.docs) {
        const uid = u.id;
        const desired = await overseersFor(uid);
        const cur = Array.isArray(u.data().overseerIds) ? u.data().overseerIds : [];

        // (1) Seed/refresh the user-doc closure.
        if (!sameSet(cur, desired)) {
            if (closureSamples.length < 25) {
                closureSamples.push(
                    `  ${u.data().displayName || uid} (${u.data().role || 'worker'}): ` +
                        `overseerIds [${cur.join(', ') || '∅'}] -> [${desired.join(', ') || '∅'}]`
                );
            }
            userDocWrites += 1;
            if (APPLY) {
                batch.update(u.ref, { overseerIds: desired });
                inBatch += 1;
                await flush(false);
            }
        }

        // (2) Re-stamp this user's owned rows to the same closure (idempotent).
        for (const { col, field } of OWNED_COLLECTIONS) {
            const rows = await db.collection(col).where(field, '==', uid).get();
            for (const r of rows.docs) {
                const rc = Array.isArray(r.data().teamManagerIds) ? r.data().teamManagerIds : [];
                if (sameSet(rc, desired)) continue;
                rowWrites += 1;
                if (APPLY) {
                    batch.update(r.ref, { teamManagerIds: desired });
                    inBatch += 1;
                    await flush(false);
                }
            }
        }
    }
    await flush(true);

    console.log('=== User-doc closure changes (overseerIds) ===');
    if (closureSamples.length) closureSamples.forEach((l) => console.log(l));
    else console.log('  (none — every user-doc closure already correct)');

    console.log(`\nUser docs to write  : ${userDocWrites}`);
    console.log(`Owned rows to write : ${rowWrites}`);

    if (APPLY) {
        console.log(`\n✔ WROTE ${userDocWrites} user docs + ${rowWrites} rows.`);
    } else {
        console.log(
            `\nDRY-RUN complete — would write ${userDocWrites} user docs + ${rowWrites} rows. ` +
                'Re-run with --apply to commit.'
        );
    }
    process.exit(0);
}

run().catch((err) => {
    console.error('FATAL:', err && err.message ? err.message : err);
    process.exit(1);
});
