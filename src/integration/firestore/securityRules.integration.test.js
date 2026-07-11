import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { readFile } from 'node:fs/promises';

// Exploit-regression oracles for the P0 authorization fixes from the 2026-07-10 full sweep:
//   R-01 — a fresh user may create ONLY a safe, disabled-worker profile (no self-minted admin).
//   R-05 — a worker may not forge the CREATE-ONLY team-visibility stamp on their own session.
//   R-06 — a worker may not re-point their own task to a colleague (horizontal ownership bypass).
//   R-07 — a worker may not self-classify as a test account and vanish from reports.
// Each fix ships with a FAIL case (the exploit) and a SUCCESS case (the legitimate flow it must
// preserve), so a future rules edit that regresses either boundary breaks this suite.

const PROJECT_ID = 'demo-workz-security-rules';
const WORKER_ID = 'rules-worker';
const OTHER_ID = 'rules-other-worker';
const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describeEmulator = emulatorAvailable ? describe : describe.skip;

let testEnv;

async function seed(documents) {
    await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await Promise.all(
            Object.entries(documents).map(([path, data]) => setDoc(doc(db, path), data))
        );
    });
}

function workerDb() {
    return testEnv.authenticatedContext(WORKER_ID, {
        email: 'rules-worker@example.test',
    }).firestore();
}

// A brand-new principal whose users/{uid} document does NOT exist yet (first-login create path).
function freshDb(uid) {
    return testEnv.authenticatedContext(uid, {
        email: `${uid}@example.test`,
    }).firestore();
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
    await seed({
        [`users/${WORKER_ID}`]: {
            id: WORKER_ID,
            role: 'worker',
            isDisabled: false,
            isTest: false,
            displayName: 'Rules Worker',
        },
        [`users/${OTHER_ID}`]: {
            id: OTHER_ID,
            role: 'worker',
            isDisabled: false,
        },
        // A canonical logged-time row owned by the worker, stamped for one overseer.
        'work_sessions/ws-1': {
            userId: WORKER_ID,
            taskId: 'task-a',
            taskTitle: 'Task A',
            durationMinutes: 60,
            date: '2026-07-10',
            teamManagerIds: ['mgr-legit'],
        },
        // A task the worker owns.
        'tasks/task-a': {
            id: 'task-a',
            title: 'Task A',
            assignedUserId: WORKER_ID,
            assignedUserName: 'Rules Worker',
            status: 'pending',
            teamManagerIds: ['mgr-legit'],
        },
    });
}, 30_000);

afterAll(async () => {
    await testEnv?.cleanup();
});

describeEmulator('firestore.rules — P0 authorization boundaries', () => {
    // ---- R-01: self-provisioned profile must be a safe disabled worker ----
    it('R-01: a fresh user cannot self-provision an admin profile', async () => {
        const db = freshDb('escalator-1');
        await assertFails(
            setDoc(doc(db, 'users', 'escalator-1'), {
                email: 'escalator-1@example.test',
                role: 'admin',
                isDisabled: false,
            })
        );
    });

    it('R-01: a fresh user cannot self-provision an ACTIVE (non-disabled) worker', async () => {
        const db = freshDb('escalator-2');
        await assertFails(
            setDoc(doc(db, 'users', 'escalator-2'), {
                email: 'escalator-2@example.test',
                role: 'worker',
                isDisabled: false,
            })
        );
    });

    it('R-01: a fresh user cannot smuggle a pre-set payRate / scope into the create', async () => {
        const db = freshDb('escalator-3');
        await assertFails(
            setDoc(doc(db, 'users', 'escalator-3'), {
                email: 'escalator-3@example.test',
                role: 'worker',
                isDisabled: true,
                canBackdateTime: true,
            })
        );
    });

    it('R-01: the legitimate pending-worker create shape is accepted', async () => {
        const db = freshDb('newcomer-1');
        await assertSucceeds(
            setDoc(doc(db, 'users', 'newcomer-1'), {
                email: 'newcomer-1@example.test',
                displayName: 'Newcomer',
                photoURL: null,
                role: 'worker',
                createdAt: '2026-07-11T00:00:00.000Z',
                isDisabled: true,
                status: 'pending',
                canBackdateTime: false,
            })
        );
    });

    // ---- R-07: isTest is admin/server-only ----
    it('R-07: a worker cannot self-classify as a test account', async () => {
        await assertFails(updateDoc(doc(workerDb(), 'users', WORKER_ID), { isTest: true }));
    });

    it('R-07: an ordinary self-edit that leaves isTest untouched is allowed', async () => {
        await assertSucceeds(
            updateDoc(doc(workerDb(), 'users', WORKER_ID), { displayName: 'Renamed' })
        );
    });

    // ---- R-05: the team-visibility stamp is immutable on a session update ----
    it('R-05: a worker cannot forge teamManagerIds on their own work_session', async () => {
        await assertFails(
            updateDoc(doc(workerDb(), 'work_sessions', 'ws-1'), {
                teamManagerIds: ['mgr-legit', 'mgr-attacker'],
            })
        );
    });

    it('R-05: a legitimate session edit that leaves teamManagerIds untouched is allowed', async () => {
        await assertSucceeds(
            updateDoc(doc(workerDb(), 'work_sessions', 'ws-1'), { taskTitle: 'Task A (edited)' })
        );
    });

    // ---- R-06: a worker cannot reassign their own task to a colleague ----
    it('R-06: a worker cannot re-point their own task to another user', async () => {
        await assertFails(
            updateDoc(doc(workerDb(), 'tasks', 'task-a'), { assignedUserId: OTHER_ID })
        );
    });

    it('R-06: a worker may edit their own task while keeping the assignee themselves', async () => {
        await assertSucceeds(
            updateDoc(doc(workerDb(), 'tasks', 'task-a'), { status: 'in-progress' })
        );
    });
});
