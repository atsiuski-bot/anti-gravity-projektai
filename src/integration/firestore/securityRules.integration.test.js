import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { readFile } from 'node:fs/promises';

// Exploit-regression oracles for the authorization fixes from the 2026-07-10 full sweep:
//   R-01 — a fresh user may create ONLY a safe, disabled-worker profile (no self-minted admin).
//   R-05 — a worker may not forge the CREATE-ONLY team-visibility stamp on their own session.
//   R-06 — a worker may not re-point their own task to a colleague (horizontal ownership bypass).
//   R-07 — a worker may not self-classify as a test account and vanish from reports.
//   R-08 — a scoped manager may force-end/idle a session ONLY inside their overseer subtree (P1).
// Each fix ships with a FAIL case (the exploit) and a SUCCESS case (the legitimate flow it must
// preserve), so a future rules edit that regresses either boundary breaks this suite.

const PROJECT_ID = 'demo-workz-security-rules';
const WORKER_ID = 'rules-worker';
const OTHER_ID = 'rules-other-worker';
// R-08 principals: a target worker whose live session a manager may force-end, an in-scope scoped
// manager (present in the target's overseerIds), an out-of-scope scoped manager (absent from it),
// and a whole-company admin (must keep reach regardless of subtree).
const TARGET_ID = 'rules-target';
const IN_SCOPE_MGR = 'rules-mgr-in';
const OUT_SCOPE_MGR = 'rules-mgr-out';
const WHOLE_TEAM_ADMIN = 'rules-admin';
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

// An authenticated principal whose users/{uid} document IS seeded (role/scope come from the seed).
function authedDb(uid) {
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

    // ---- R-08: a manager may force-end a session only inside their overseer subtree ----
    describe('R-08: scoped force-end is subtree-bounded', () => {
        // The idle record a manager writes to force-end TARGET's live run. Full-replace (setDoc) so
        // request.resource.data is exactly this — no merge with the seeded 'active' record. It clears
        // the run and advances the revision, satisfying validActiveSessionRecord + the active→idle
        // transition guard; the ONLY thing that varies between fail/success is the CALLER's scope.
        const forceIdleRecord = {
            userId: TARGET_ID,
            status: 'idle',
            run: null,
            revision: 6,
            expectedRevision: 5,
            expectedRunId: 'run-1',
            lastCommandId: 'cmd-force',
            updatedAt: '2026-07-11T01:00:00.000Z',
            engineVersion: 2,
        };
        // A well-formed force-end-session command; actorId must stamp the caller.
        function forceEndCommand(actorUid) {
            return {
                commandId: 'fe-cmd-1',
                userId: TARGET_ID,
                kind: 'force-end-session',
                actorId: actorUid,
                expectedRevision: 5,
                expectedRunId: 'run-1',
                runId: null,
                appliedRevision: 0,
                issuedAt: '2026-07-11T01:00:00.000Z',
                engineVersion: 2,
            };
        }

        beforeEach(async () => {
            if (!emulatorAvailable) return;
            await seed({
                [`users/${TARGET_ID}`]: {
                    id: TARGET_ID,
                    role: 'worker',
                    isDisabled: false,
                    overseerIds: [IN_SCOPE_MGR], // IN_SCOPE_MGR oversees; OUT_SCOPE_MGR does not
                },
                [`users/${IN_SCOPE_MGR}`]: {
                    id: IN_SCOPE_MGR, role: 'manager', scopedManager: true, isDisabled: false,
                },
                [`users/${OUT_SCOPE_MGR}`]: {
                    id: OUT_SCOPE_MGR, role: 'manager', scopedManager: true, isDisabled: false,
                },
                [`users/${WHOLE_TEAM_ADMIN}`]: {
                    id: WHOLE_TEAM_ADMIN, role: 'admin', isDisabled: false,
                },
                // TARGET's live session, mid-run — the row a manager may force-idle.
                [`active_sessions/${TARGET_ID}`]: {
                    userId: TARGET_ID,
                    status: 'active',
                    revision: 5,
                    expectedRevision: 4,
                    expectedRunId: null,
                    lastCommandId: 'cmd-seed',
                    updatedAt: '2026-07-11T00:00:00.000Z',
                    engineVersion: 2,
                    run: { runId: 'run-1', type: 'task', startedAt: '2026-07-11T00:00:00.000Z', revision: 1 },
                },
            });
        }, 30_000);

        it('an OUT-OF-SCOPE scoped manager cannot force-idle the session', async () => {
            await assertFails(
                setDoc(doc(authedDb(OUT_SCOPE_MGR), 'active_sessions', TARGET_ID), forceIdleRecord)
            );
        });

        it('an IN-SCOPE scoped manager may force-idle the session (legit flow preserved)', async () => {
            await assertSucceeds(
                setDoc(doc(authedDb(IN_SCOPE_MGR), 'active_sessions', TARGET_ID), forceIdleRecord)
            );
        });

        it('a whole-company admin may force-idle any session regardless of subtree', async () => {
            await assertSucceeds(
                setDoc(doc(authedDb(WHOLE_TEAM_ADMIN), 'active_sessions', TARGET_ID), forceIdleRecord)
            );
        });

        it('an OUT-OF-SCOPE scoped manager cannot issue a force-end-session command', async () => {
            await assertFails(
                setDoc(
                    doc(authedDb(OUT_SCOPE_MGR), `users/${TARGET_ID}/timer_commands`, 'fe-cmd-1'),
                    forceEndCommand(OUT_SCOPE_MGR)
                )
            );
        });

        it('an IN-SCOPE scoped manager may issue a force-end-session command (legit flow preserved)', async () => {
            await assertSucceeds(
                setDoc(
                    doc(authedDb(IN_SCOPE_MGR), `users/${TARGET_ID}/timer_commands`, 'fe-cmd-1'),
                    forceEndCommand(IN_SCOPE_MGR)
                )
            );
        });
    });
});
