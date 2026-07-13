import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { readFile } from 'node:fs/promises';

// Triage-sweep finding #3: the interrupted quick-work/call partial log (sessionActions.js
// startSessionImpl) now writes under the SAME deterministic work_sessions id the eventual final
// close (handleLegacyLogging) uses, so a failed critical activeSession switch — which leaves the
// session running from its original start — makes the final write land on and overwrite the
// partial row instead of adding a double-counted second one.
//
// That id-sharing means the final write can now be a genuine Firestore UPDATE of a doc the
// create-only stampTeamOnWorkSessionCreate trigger has already denormalized teamManagerIds onto
// (functions/index.js). The work_sessions update rule pins teamManagerIds unchanged
// (firestore.rules ~line 439); a bare (non-merge) overwrite omits the field entirely and would be
// REJECTED. This is why the final writes in handleLegacyLogging (quickWork + call) were changed
// to setDoc(..., {merge:true}) alongside the id change — this suite proves that against the REAL
// rules file, not a mock.
const PROJECT_ID = 'demo-workz-timer';
const USER_ID = 'timer-worker';
const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describeEmulator = emulatorAvailable ? describe : describe.skip;

let testEnv;

function workerDb() {
    return testEnv.authenticatedContext(USER_ID, { email: 'timer-worker@example.test' }).firestore();
}

async function stampTeamManagerIds(path, teamManagerIds) {
    await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), path), { teamManagerIds }, { merge: true });
    });
}

beforeAll(async () => {
    if (!emulatorAvailable) return;
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
            rules: await readFile(new URL('../../../firestore.rules', import.meta.url), 'utf8'),
        },
    });
}, 30_000);

beforeEach(async () => {
    if (!emulatorAvailable) return;
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), `users/${USER_ID}`), {
            role: 'worker',
            isDisabled: false,
            activeSession: null,
            workStatus: { isWorking: false, status: 'idle', activeTaskId: null },
        });
    });
});

afterAll(async () => {
    await testEnv?.cleanup();
});

describeEmulator('secondary-session partial-log dedup (finding #3) vs the real rules', () => {
    it('merge:true final close succeeds and PRESERVES the CF-stamped teamManagerIds', async () => {
        const db = workerDb();
        const ref = doc(db, 'work_sessions', 'sess_qw_ws_timer-worker_1000');

        // 1. The partial log (interruption) — a plain create, worker-owned.
        await assertSucceeds(setDoc(ref, {
            userId: USER_ID,
            taskId: 'quickWork_partial_1500',
            taskTitle: 'Greita veikla',
            startTime: '2026-07-09T08:00:00.000Z',
            endTime: '2026-07-09T08:30:00.000Z',
            durationMinutes: 30,
            date: '2026-07-09',
            isQuickWork: true,
            isPartial: true,
        }, { merge: true }));

        // 2. The create-only Cloud Function trigger denormalizes team visibility (admin write).
        await stampTeamManagerIds(ref.path, ['mgr1']);

        // 3. The interrupting switch failed, so the worker's later REAL close lands on the SAME
        // id. With merge:true (the fix) this must succeed...
        await assertSucceeds(setDoc(ref, {
            userId: USER_ID,
            taskId: 'quick_9999',
            taskTitle: 'Greita veikla',
            startTime: '2026-07-09T08:00:00.000Z',
            endTime: '2026-07-09T09:00:00.000Z',
            durationMinutes: 60,
            date: '2026-07-09',
            isQuickWork: true,
            isPartial: false,
        }, { merge: true }));

        // ...and the stamped field must have survived the merge untouched.
        let after;
        await testEnv.withSecurityRulesDisabled(async (context) => {
            after = await getDoc(doc(context.firestore(), ref.path));
        });
        expect(after.data().teamManagerIds).toEqual(['mgr1']);
        expect(after.data().durationMinutes).toBe(60);
        expect(after.data().isPartial).toBe(false);
    });

    it('negative control: the SAME final close WITHOUT merge:true is rejected once teamManagerIds is stamped', async () => {
        // Proves the merge:true fix is load-bearing, not cosmetic — a bare overwrite that omits
        // teamManagerIds fails the update-rule pin as soon as the CF has stamped the row.
        const db = workerDb();
        const ref = doc(db, 'work_sessions', 'sess_qw_ws_timer-worker_2000');

        await assertSucceeds(setDoc(ref, {
            userId: USER_ID,
            taskId: 'quickWork_partial_2500',
            startTime: '2026-07-09T10:00:00.000Z',
            endTime: '2026-07-09T10:30:00.000Z',
            durationMinutes: 30,
            date: '2026-07-09',
            isQuickWork: true,
            isPartial: true,
        }, { merge: true }));

        await stampTeamManagerIds(ref.path, ['mgr1']);

        await assertFails(setDoc(ref, {
            userId: USER_ID,
            taskId: 'quick_8888',
            startTime: '2026-07-09T10:00:00.000Z',
            endTime: '2026-07-09T11:00:00.000Z',
            durationMinutes: 60,
            date: '2026-07-09',
            isQuickWork: true,
            isPartial: false,
        })); // no {merge:true} — the pre-fix shape
    });
});
