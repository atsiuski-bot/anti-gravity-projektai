#!/usr/bin/env node
/*
 * One-off cleanup: delete corrupt `break_sessions` whose durationMinutes exceeds the 16h
 * ceiling (MAX_SESSION_MINUTES = 960). These are runaway-loop orphan re-logs — e.g. one worker
 * on 2026-01-28 has 246 duplicate rows of ONE never-stopped break (all share
 * startTime 2026-01-27T13:59:51.361Z) that summed to 4562h in the report; plus 2 analogous
 * rows for another user. A break longer than 16h is physically impossible, so every matching
 * row is garbage; real breaks (<= 960) are never touched. Idempotent and safe to re-run.
 *
 * The app already clamps each session to 16h on read, but the report dedups only by document
 * id, so ~248 distinct corrupt docs still compound (248 x 960 ~= 3968h). Deleting them is the
 * only fix. work_sessions are intentionally NOT touched: they are single rows per task (no
 * flood), the read-side clamp already caps them, and one is a legitimate manual adjustment.
 *
 * RUN (needs `firebase-admin` resolvable — e.g. run from `functions/`, where it is installed —
 * and credentials):
 *   1. Authenticate as audrius@medievalclub.org, ONE of:
 *        gcloud auth application-default login            # easiest if gcloud is installed
 *        # or:  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json
 *        #      (download from Firebase console > Project settings > Service accounts)
 *   2. node ../scripts/cleanup-corrupt-break-sessions.cjs --dry-run   # preview, deletes nothing
 *   3. node ../scripts/cleanup-corrupt-break-sessions.cjs             # actually delete
 *
 * ALREADY RUN once (2026-06-23, see ADR 0011) — kept as the audit trail of that incident.
 * Lives in scripts/ deliberately: anything under functions/ is uploaded verbatim by
 * `firebase deploy`, and a one-off admin script has no business in the deployed bundle.
 */

const admin = require('firebase-admin');

const PROJECT = 'darbo-planavimas';
const CEILING_MINUTES = 16 * 60; // 960 — MAX_SESSION_MINUTES; a break can never exceed this
const dryRun = process.argv.includes('--dry-run');

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

(async () => {
    const snap = await db
        .collection('break_sessions')
        .where('durationMinutes', '>', CEILING_MINUTES)
        .get();

    // Defensive re-check: never delete a row that is not actually over the ceiling.
    const corrupt = snap.docs.filter((d) => Number(d.get('durationMinutes')) > CEILING_MINUTES);

    console.log(`Found ${corrupt.length} corrupt break_sessions (durationMinutes > ${CEILING_MINUTES}).`);
    if (corrupt.length === 0) {
        console.log('Nothing to do — already clean.');
        process.exit(0);
    }

    // Show a small sample so you can eyeball it before committing.
    corrupt.slice(0, 6).forEach((d) =>
        console.log(`  ${d.id}  ${d.get('userName')}  ${d.get('date')}  ${Math.round(Number(d.get('durationMinutes')))}min`)
    );
    if (corrupt.length > 6) console.log(`  ... and ${corrupt.length - 6} more`);

    if (dryRun) {
        console.log('\n--dry-run: no documents deleted. Re-run without --dry-run to apply.');
        process.exit(0);
    }

    let deleted = 0;
    for (let i = 0; i < corrupt.length; i += 400) {
        const batch = db.batch();
        const chunk = corrupt.slice(i, i + 400);
        chunk.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        deleted += chunk.length;
        console.log(`  committed ${deleted}/${corrupt.length}`);
    }

    console.log(`\nDone. Deleted ${deleted} corrupt break_sessions. Reports will now show real break time only.`);
    process.exit(0);
})().catch((e) => {
    console.error('FAILED:', e && e.message ? e.message : e);
    console.error('If this is a credentials error, run `gcloud auth application-default login` (as audrius@medievalclub.org) or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key, then retry.');
    process.exit(1);
});
