import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { addDoc, collection, doc, getDoc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { readFile } from 'node:fs/promises';

// Exploit-regression oracles for the authorization fixes from the 2026-07-10 full sweep:
//   R-01 — a fresh user may create ONLY a safe, disabled-worker profile (no self-minted admin).
//   R-05 — a worker may not forge the CREATE-ONLY team-visibility stamp on their own session,
//          nor on a task / archived task UPDATE (the stamp trigger skips owner-unchanged stamped
//          edits, so a forged stamp would persist), nor pre-stamp a session at CREATE (the
//          create-only stamp trigger skips closure-less owners, so that forgery would persist too).
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
                canEditOwnStartTime: true,
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
                canEditOwnStartTime: false,
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

    // ---- canEditOwnStartTime is admin-only, exactly like canBackdateTime ----
    it('a worker cannot self-grant the own-start-time-correction permission', async () => {
        await assertFails(updateDoc(doc(workerDb(), 'users', WORKER_ID), { canEditOwnStartTime: true }));
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

    // ---- Worker self-service reduction is ONE-WAY ----
    // A worker may shorten their own credited time without approval, but never lengthen it: an
    // increase has to go through the manager. The guard is keyed on the `selfAdjusted` marker the
    // self-service write sets, so it constrains only that path — the live timer, which legitimately
    // GROWS a session's duration as work continues, must stay unaffected.
    it('one-way: a worker may shorten their own session when it carries the self-adjust marker', async () => {
        await assertSucceeds(
            updateDoc(doc(workerDb(), 'work_sessions', 'ws-1'), {
                durationMinutes: 40, // 60 → 40
                endTime: '2026-07-10T09:40:00.000Z',
                selfAdjusted: true,
            })
        );
    });

    it('one-way: the same worker may NOT lengthen it', async () => {
        await assertFails(
            updateDoc(doc(workerDb(), 'work_sessions', 'ws-1'), {
                durationMinutes: 90, // 60 → 90
                selfAdjusted: true,
            })
        );
    });

    it('one-way: an unchanged duration still passes, so a soft-delete of a self-adjusted row works', async () => {
        await assertSucceeds(
            updateDoc(doc(workerDb(), 'work_sessions', 'ws-1'), { selfAdjusted: true, isDeleted: true })
        );
    });

    it('one-way: a write WITHOUT the marker is untouched — the live timer may still grow a session', async () => {
        await assertSucceeds(
            updateDoc(doc(workerDb(), 'work_sessions', 'ws-1'), {
                durationMinutes: 120, // the partial → final growth every quick-work/call close does
            })
        );
    });

    // ---- R-05 (task half): the stamp is immutable on task / archived-task updates, and ----
    // ---- (create half) unforgeable at session create. The stamp is CF-owned everywhere: ----
    // stampTeamOnTaskWrite/stampTeamOnArchivedTaskWrite skip an owner-unchanged edit that already
    // has a stamp, and stampTeamOn*SessionCreate skips a closure-less owner — so each of these
    // forgeries would PERSIST without the rule pin, re-scoping who may see/act on the row.
    describe('R-05: the team-visibility stamp is CF-owned on tasks and at session create', () => {
        beforeEach(async () => {
            if (!emulatorAvailable) return;
            await seed({
                [`users/${WHOLE_TEAM_ADMIN}`]: {
                    id: WHOLE_TEAM_ADMIN, role: 'admin', isDisabled: false,
                },
                // An archived task the worker owns, stamped for one overseer.
                'archived_tasks/arch-a': {
                    id: 'arch-a',
                    title: 'Archived task',
                    assignedUserId: WORKER_ID,
                    status: 'completed',
                    archivedAt: '2026-07-01T00:00:00.000Z',
                    teamManagerIds: ['mgr-legit'],
                },
            });
        }, 30_000);

        it('a worker cannot strip the stamp from their own task (oversight evasion)', async () => {
            await assertFails(
                updateDoc(doc(workerDb(), 'tasks', 'task-a'), { teamManagerIds: [] })
            );
        });

        it('a worker cannot graft an unrelated manager onto their own task stamp', async () => {
            await assertFails(
                updateDoc(doc(workerDb(), 'tasks', 'task-a'), {
                    teamManagerIds: ['mgr-legit', 'mgr-attacker'],
                })
            );
        });

        it('even an admin cannot hand-edit a task stamp (CF-owned by design)', async () => {
            await assertFails(
                updateDoc(doc(authedDb(WHOLE_TEAM_ADMIN), 'tasks', 'task-a'), {
                    teamManagerIds: ['mgr-attacker'],
                })
            );
        });

        it('a worker cannot forge the stamp on their own archived task', async () => {
            await assertFails(
                updateDoc(doc(workerDb(), 'archived_tasks', 'arch-a'), { teamManagerIds: [] })
            );
        });

        it('a worker may still edit their own archived task when the stamp is untouched', async () => {
            await assertSucceeds(
                updateDoc(doc(workerDb(), 'archived_tasks', 'arch-a'), { title: 'Renamed' })
            );
        });

        it('a worker cannot pre-stamp teamManagerIds when creating a work_session', async () => {
            await assertFails(
                setDoc(doc(workerDb(), 'work_sessions', 'ws-forged'), {
                    userId: WORKER_ID,
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    durationMinutes: 60,
                    date: '2026-07-11',
                    teamManagerIds: ['mgr-attacker'],
                })
            );
        });

        it('a worker cannot pre-stamp teamManagerIds when creating a break_session', async () => {
            await assertFails(
                setDoc(doc(workerDb(), 'break_sessions', 'bs-forged'), {
                    userId: WORKER_ID,
                    durationMinutes: 30,
                    date: '2026-07-11',
                    teamManagerIds: ['mgr-attacker'],
                })
            );
        });

        it('an un-stamped self-logged work_session create still succeeds', async () => {
            await assertSucceeds(
                setDoc(doc(workerDb(), 'work_sessions', 'ws-legit'), {
                    userId: WORKER_ID,
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    durationMinutes: 60,
                    date: '2026-07-11',
                })
            );
        });

        it('an un-stamped self-logged break_session create still succeeds', async () => {
            await assertSucceeds(
                setDoc(doc(workerDb(), 'break_sessions', 'bs-legit'), {
                    userId: WORKER_ID,
                    durationMinutes: 30,
                    date: '2026-07-11',
                })
            );
        });
    });

    // ---- R-04: a non-manager may not forge admin provenance on a self-logged session ----
    // createdByAdmin is the manager correction stamp; a worker forging it disguises a self-minted
    // row as an approved correction. The pin forbids it ONLY on the non-manager self-owned branch.
    it('R-04: a worker cannot stamp createdByAdmin on their own work_session create', async () => {
        await assertFails(
            setDoc(doc(workerDb(), 'work_sessions', 'ws-forge'), {
                userId: WORKER_ID,
                taskId: 'manual_1',
                taskTitle: 'Forged correction',
                durationMinutes: 120,
                date: '2026-07-11',
                createdByAdmin: WHOLE_TEAM_ADMIN, // forged admin authorship
            })
        );
    });

    it('R-04: a worker may self-log a session that does not claim admin authorship', async () => {
        await assertSucceeds(
            setDoc(doc(workerDb(), 'work_sessions', 'ws-self'), {
                userId: WORKER_ID,
                taskId: 'task-a',
                taskTitle: 'Task A',
                durationMinutes: 90,
                date: '2026-07-11',
            })
        );
    });

    it('R-04: a whole-team manager may still author a cross-user correction with createdByAdmin', async () => {
        await seed({
            [`users/${WHOLE_TEAM_ADMIN}`]: { id: WHOLE_TEAM_ADMIN, role: 'admin', isDisabled: false },
        });
        await assertSucceeds(
            setDoc(doc(authedDb(WHOLE_TEAM_ADMIN), 'work_sessions', 'ws-mgr'), {
                userId: OTHER_ID, // authored for another worker
                taskId: 'manual_2',
                taskTitle: 'Manager correction',
                durationMinutes: 60,
                date: '2026-07-11',
                createdByAdmin: WHOLE_TEAM_ADMIN,
                isManualSession: true,
            })
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

    // ---- Triage sweep 2026-07-13: authz gaps found by read-only finders + 3-skeptic verify ----
    // TS-1 (HIGH): teamManagerIds is immutable on a TASK update too (it was pinned only on
    // work_sessions/break_sessions). A worker cannot unstamp their own task to escape scoped/senior
    // oversight, nor inject a colleague to grant them read.
    it('TS-1: a worker cannot clear teamManagerIds on their own task', async () => {
        await assertFails(
            updateDoc(doc(workerDb(), 'tasks', 'task-a'), { teamManagerIds: [] })
        );
    });

    it('TS-1: a worker cannot inject a colleague into their task teamManagerIds', async () => {
        await assertFails(
            updateDoc(doc(workerDb(), 'tasks', 'task-a'), { teamManagerIds: ['mgr-legit', OTHER_ID] })
        );
    });

    it('TS-1: the same immutability pin guards archived_tasks', async () => {
        await seed({
            'archived_tasks/arc-a': {
                id: 'arc-a',
                title: 'Archived A',
                assignedUserId: WORKER_ID,
                status: 'confirmed',
                teamManagerIds: ['mgr-legit'],
            },
        });
        await assertFails(
            updateDoc(doc(workerDb(), 'archived_tasks', 'arc-a'), { teamManagerIds: [] })
        );
    });

    it('TS-1: a legitimate task edit that leaves teamManagerIds untouched is allowed', async () => {
        await assertSucceeds(
            updateDoc(doc(workerDb(), 'tasks', 'task-a'), { title: 'Task A (edited)' })
        );
    });

    // TS-5 (MED): a (non-admin) manager may disable a worker but NOT an admin — otherwise one manager
    // credential could disable every admin, and a disabled admin has no in-app path to re-enable.
    it('TS-5: an unscoped manager cannot disable an admin account', async () => {
        await seed({
            'users/ts-mgr': { id: 'ts-mgr', role: 'manager', isDisabled: false },
            'users/ts-admin': { id: 'ts-admin', role: 'admin', isDisabled: false },
        });
        await assertFails(
            updateDoc(doc(authedDb('ts-mgr'), 'users', 'ts-admin'), { isDisabled: true })
        );
    });

    it('TS-5: an unscoped manager may still disable an ordinary worker', async () => {
        await seed({
            'users/ts-mgr': { id: 'ts-mgr', role: 'manager', isDisabled: false },
        });
        await assertSucceeds(
            updateDoc(doc(authedDb('ts-mgr'), 'users', WORKER_ID), { isDisabled: true })
        );
    });

    // TS-6 (MED): a worker cannot self-approve their own calendar_request nor forge approvedBy; the
    // manager approval path and a worker's own non-approval edit both still work.
    it('TS-6: a worker cannot self-approve their own calendar_request', async () => {
        await seed({
            'calendar_requests/cr-1': { userId: WORKER_ID, status: 'pending', type: 'add' },
        });
        await assertFails(
            updateDoc(doc(workerDb(), 'calendar_requests', 'cr-1'), {
                status: 'approved', approvedBy: 'ts-mgr', approvedAt: '2026-07-13T00:00:00.000Z',
            })
        );
    });

    it('TS-6: a worker may still edit a non-approval field on their own request', async () => {
        await seed({
            'calendar_requests/cr-2': { userId: WORKER_ID, status: 'pending', type: 'add' },
        });
        await assertSucceeds(
            updateDoc(doc(workerDb(), 'calendar_requests', 'cr-2'), { reason: 'updated note' })
        );
    });

    it('TS-6: a whole-team manager may still approve the request', async () => {
        await seed({
            'users/ts-mgr': { id: 'ts-mgr', role: 'manager', isDisabled: false },
            'calendar_requests/cr-3': { userId: WORKER_ID, status: 'pending', type: 'add' },
        });
        await assertSucceeds(
            updateDoc(doc(authedDb('ts-mgr'), 'calendar_requests', 'cr-3'), {
                status: 'approved', approvedBy: 'ts-mgr', approvedAt: '2026-07-13T00:00:00.000Z',
            })
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
                // The credited-work ledger for run-1, pre-seeded so the R-12 atomicity binding
                // (taskCloseLedgerBound) is satisfied by getAfter regardless of the batch — these R-08
                // cases force-idle a TASK run and must vary ONLY on the caller's SCOPE, not on whether
                // the ledger is present (the real planManagerForceEnd writes this row in the same batch;
                // pre-seeding it keeps this suite focused on scope, orthogonal to R-12).
                'work_sessions/sess_run_run-1': {
                    userId: TARGET_ID, taskId: 'task-t', taskTitle: 'Target task', runId: 'run-1',
                    startTime: '2026-07-11T00:00:00.000Z', endTime: '2026-07-11T00:30:00.000Z',
                    durationMinutes: 30, date: '2026-07-11', engineVersion: 2,
                },
                // A settled command in TARGET's log — the READ-arm fixture. Shape is irrelevant to the
                // read rule; only the CALLER's scope decides.
                [`users/${TARGET_ID}/timer_commands/seed-cmd`]: {
                    commandId: 'seed-cmd',
                    userId: TARGET_ID,
                    kind: 'start-task',
                    expectedRevision: 4,
                    expectedRunId: null,
                    runId: 'run-1',
                    appliedRevision: 5,
                    issuedAt: '2026-07-11T00:00:00.000Z',
                    engineVersion: 2,
                },
                // TARGET's pending calendar request. managerIds addresses BOTH scoped managers
                // (client-supplied, so it is NOT a security boundary) — the rule must scope by the
                // owner's overseer closure regardless, so only the in-scope manager may act.
                'calendar_requests/cr-1': {
                    userId: TARGET_ID,
                    type: 'add',
                    status: 'pending',
                    managerIds: [IN_SCOPE_MGR, OUT_SCOPE_MGR],
                },
                // TARGET's weekly calendar-change notification — a manager may dismiss it (dismissedBy)
                // only within scope.
                'calendar_notifications/cn-1': {
                    userId: TARGET_ID,
                    weekStart: '2026-W28',
                    changes: [],
                    dismissedBy: [],
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

        // ---- R-08 (read arm): live-timer READS are bounded by the same subtree as the writes -----
        // The force-idle WRITE was scoped, but READ stayed bare isManagerOrAdmin(), so a scoped manager
        // could still watch ANOTHER team's live run and command log. Both reads are by document id, so
        // narrowing them cannot break a collection query (the broad-READ doctrine does not apply).
        it('an OUT-OF-SCOPE scoped manager cannot read the live session', async () => {
            await assertFails(getDoc(doc(authedDb(OUT_SCOPE_MGR), 'active_sessions', TARGET_ID)));
        });

        it('an IN-SCOPE scoped manager may read the live session (force-end flow preserved)', async () => {
            await assertSucceeds(getDoc(doc(authedDb(IN_SCOPE_MGR), 'active_sessions', TARGET_ID)));
        });

        it('a whole-company admin may read any live session regardless of subtree', async () => {
            await assertSucceeds(getDoc(doc(authedDb(WHOLE_TEAM_ADMIN), 'active_sessions', TARGET_ID)));
        });

        it('the worker may still read their OWN live session (hot listener path)', async () => {
            await assertSucceeds(getDoc(doc(authedDb(TARGET_ID), 'active_sessions', TARGET_ID)));
        });

        it('an OUT-OF-SCOPE scoped manager cannot read the command log', async () => {
            await assertFails(
                getDoc(doc(authedDb(OUT_SCOPE_MGR), `users/${TARGET_ID}/timer_commands`, 'seed-cmd'))
            );
        });

        it('an IN-SCOPE scoped manager may read the command log (replay check preserved)', async () => {
            await assertSucceeds(
                getDoc(doc(authedDb(IN_SCOPE_MGR), `users/${TARGET_ID}/timer_commands`, 'seed-cmd'))
            );
        });

        it('the worker may still read their OWN command log', async () => {
            await assertSucceeds(
                getDoc(doc(authedDb(TARGET_ID), `users/${TARGET_ID}/timer_commands`, 'seed-cmd'))
            );
        });

        // ---- T-18 (break arm): the force-end's break_sessions tail ------------------------------
        // A force-end commits as ONE batch, so an owner-only create on break_sessions denied the WHOLE
        // settle and left the worker stuck live. The manager branch is scoped exactly like
        // work_sessions — and must NOT become a general cross-user write door.
        const breakRow = {
            userId: TARGET_ID,
            userName: 'Target',
            runId: 'run-1',
            startTime: '2026-07-11T00:00:00.000Z',
            endTime: '2026-07-11T00:20:00.000Z',
            durationMinutes: 20,
            date: '2026-07-11',
            isBreak: true,
            engineVersion: 2,
        };

        it('an OUT-OF-SCOPE scoped manager cannot author a break row for the worker', async () => {
            await assertFails(
                setDoc(doc(authedDb(OUT_SCOPE_MGR), 'break_sessions', 'sess_break_run_run-1'), breakRow)
            );
        });

        it('an IN-SCOPE scoped manager may author the force-ended break row', async () => {
            await assertSucceeds(
                setDoc(doc(authedDb(IN_SCOPE_MGR), 'break_sessions', 'sess_break_run_run-1'), breakRow)
            );
        });

        it('a whole-company admin may author the force-ended break row', async () => {
            await assertSucceeds(
                setDoc(doc(authedDb(WHOLE_TEAM_ADMIN), 'break_sessions', 'sess_break_run_run-1'), breakRow)
            );
        });

        it('the duration guard still applies to a manager-authored break row', async () => {
            await assertFails(
                setDoc(doc(authedDb(WHOLE_TEAM_ADMIN), 'break_sessions', 'sess_break_run_run-1'), {
                    ...breakRow,
                    durationMinutes: 5000,
                })
            );
        });

        it('a plain WORKER still cannot author a break row for a colleague', async () => {
            await assertFails(
                setDoc(doc(workerDb(), 'break_sessions', 'sess_break_run_run-1'), breakRow)
            );
        });

        // Calendar-request approval workflow (decline is the acute gap: it bypasses the already-scoped
        // work_hours write that approve performs). The userId pin is preserved by the merge update.
        const declinePatch = { status: 'declined', declinedBy: 'x', declinedAt: '2026-07-11T02:00:00.000Z' };

        it('an OUT-OF-SCOPE scoped manager cannot decline the request', async () => {
            await assertFails(
                updateDoc(doc(authedDb(OUT_SCOPE_MGR), 'calendar_requests', 'cr-1'), declinePatch)
            );
        });

        it('an IN-SCOPE scoped manager may decline the request (legit flow preserved)', async () => {
            await assertSucceeds(
                updateDoc(doc(authedDb(IN_SCOPE_MGR), 'calendar_requests', 'cr-1'), declinePatch)
            );
        });

        it('a whole-company admin may decline any request regardless of subtree', async () => {
            await assertSucceeds(
                updateDoc(doc(authedDb(WHOLE_TEAM_ADMIN), 'calendar_requests', 'cr-1'), declinePatch)
            );
        });

        // users/{userId} update: a manager may act on another user's doc only within scope. The one
        // legit scoped-manager cross-user write is the force-end (activeSession:null on the target);
        // all management writes (isDisabled/role/pay/membership) are admin-only in the client UI.
        it('an OUT-OF-SCOPE scoped manager cannot write another team member user doc', async () => {
            await assertFails(
                updateDoc(doc(authedDb(OUT_SCOPE_MGR), 'users', TARGET_ID), { activeSession: null })
            );
        });

        it('an IN-SCOPE scoped manager may write a subtree member user doc (force-end path)', async () => {
            await assertSucceeds(
                updateDoc(doc(authedDb(IN_SCOPE_MGR), 'users', TARGET_ID), { activeSession: null })
            );
        });

        it('an OUT-OF-SCOPE scoped manager cannot disable a worker outside their subtree', async () => {
            await assertFails(
                updateDoc(doc(authedDb(OUT_SCOPE_MGR), 'users', TARGET_ID), { isDisabled: true })
            );
        });

        it('a whole-company admin may still disable any worker (management preserved)', async () => {
            await assertSucceeds(
                updateDoc(doc(authedDb(WHOLE_TEAM_ADMIN), 'users', TARGET_ID), { isDisabled: true })
            );
        });

        // The R-08 gate now lets a scoped manager write a SUBTREE member's user doc — prove the
        // admin-only field pins still block privilege escalation through that opening. Changing
        // payRate is admin-only, so even an in-scope manager (whose gate passes) must be denied.
        it('an IN-SCOPE scoped manager still cannot change an admin-only field (payRate)', async () => {
            await assertFails(
                updateDoc(doc(authedDb(IN_SCOPE_MGR), 'users', TARGET_ID), { payRate: { tier1: 10 } })
            );
        });

        // calendar_notifications: a manager may dismiss (dismissedBy) only a subtree worker's notice.
        // The client already lists only subtree rows for a scoped manager (scopedCalendarNotifications),
        // so this rule just backstops that boundary server-side.
        it('an OUT-OF-SCOPE scoped manager cannot dismiss the calendar notification', async () => {
            await assertFails(
                updateDoc(doc(authedDb(OUT_SCOPE_MGR), 'calendar_notifications', 'cn-1'),
                    { dismissedBy: [OUT_SCOPE_MGR] })
            );
        });

        it('an IN-SCOPE scoped manager may dismiss a subtree calendar notification', async () => {
            await assertSucceeds(
                updateDoc(doc(authedDb(IN_SCOPE_MGR), 'calendar_notifications', 'cn-1'),
                    { dismissedBy: [IN_SCOPE_MGR] })
            );
        });

        it('a whole-company admin may dismiss any calendar notification', async () => {
            await assertSucceeds(
                updateDoc(doc(authedDb(WHOLE_TEAM_ADMIN), 'calendar_notifications', 'cn-1'),
                    { dismissedBy: [WHOLE_TEAM_ADMIN] })
            );
        });
    });

    // ---- R-12: a task-run close must carry its ledger row in the SAME batch (ADR 0021, Option A) ----
    // ADR-0020 invariant #6 (revision bump + credited-work ledger commit atomically) was only a
    // client-batch convention; the rule clauses were independent. The active_sessions binding
    // (taskCloseLedgerBound) now enforces it for the TASK path: advancing the revision to close an
    // active task run REQUIRES work_sessions/sess_run_{runId} in the same batch with a matching runId.
    // FAIL cases = the R-12 exploit (revision advanced, ledger omitted / decoyed / content-mismatched);
    // SUCCESS cases = the legit close bundle, and a non-task (break) close which must stay unaffected.
    describe('R-12: task-close atomicity is rule-bound', () => {
        const RUN_ID = 'run-1';
        // The seeded pre-image: WORKER_ID mid-run on a task, revision 5.
        const activeTaskRun = {
            userId: WORKER_ID, status: 'active', revision: 5, expectedRevision: 4, expectedRunId: null,
            lastCommandId: 'cmd-seed', updatedAt: '2026-07-11T00:00:00.000Z', engineVersion: 2,
            run: { runId: RUN_ID, type: 'task', startedAt: '2026-07-11T00:00:00.000Z', revision: 1 },
        };
        // The idle record that closes run-1 and advances the revision (a legit pause/end/force).
        const closeToIdle = {
            userId: WORKER_ID, status: 'idle', run: null, revision: 6, expectedRevision: 5,
            expectedRunId: RUN_ID, lastCommandId: 'cmd-close', updatedAt: '2026-07-11T01:00:00.000Z',
            engineVersion: 2,
        };
        // A durationInRange-valid ledger row; runIdField lets a test forge a content mismatch.
        const ledgerRow = (runIdField = RUN_ID) => ({
            taskId: 'task-a', taskTitle: 'Task A', userId: WORKER_ID, userName: 'Rules Worker',
            runId: runIdField, startTime: '2026-07-11T00:00:00.000Z', endTime: '2026-07-11T01:00:00.000Z',
            durationMinutes: 60, date: '2026-07-11', createdAt: '2026-07-11T01:00:00.000Z', engineVersion: 2,
        });

        beforeEach(async () => {
            if (!emulatorAvailable) return;
            await seed({ [`active_sessions/${WORKER_ID}`]: activeTaskRun });
        }, 30_000);

        // A batch that closes the task run; pass a ledger id (+ optional forged runId) to include the
        // ledger sibling, or omit it entirely for the ledger-less exploit.
        function closeBatch(db, { ledgerId, ledgerRunId } = {}) {
            const b = writeBatch(db);
            b.set(doc(db, 'active_sessions', WORKER_ID), closeToIdle);
            if (ledgerId) b.set(doc(db, 'work_sessions', ledgerId), ledgerRow(ledgerRunId), { merge: true });
            return b.commit();
        }

        it('R-12 exploit: advancing the revision with NO ledger row is denied', async () => {
            await assertFails(closeBatch(workerDb()));
        });

        it('R-12 exploit: a decoy ledger at the wrong id does not satisfy the binding', async () => {
            await assertFails(closeBatch(workerDb(), { ledgerId: 'sess_run_decoy' }));
        });

        it('R-12 exploit: the right ledger id but a mismatched runId body is denied', async () => {
            await assertFails(closeBatch(workerDb(), { ledgerId: `sess_run_${RUN_ID}`, ledgerRunId: 'evil' }));
        });

        it('the legitimate close bundle (revision bump + matching ledger) succeeds', async () => {
            await assertSucceeds(closeBatch(workerDb(), { ledgerId: `sess_run_${RUN_ID}` }));
        });

        it('a NON-task (break) close is unaffected — succeeds with no sess_run ledger', async () => {
            // Reseat the pre-image as an active BREAK run; the binding is task-only, so the break end
            // (which writes to break_sessions, not sess_run_) must still be allowed.
            await seed({
                [`active_sessions/${WORKER_ID}`]: {
                    ...activeTaskRun,
                    run: { runId: 'brun-1', type: 'break', startedAt: '2026-07-11T00:00:00.000Z', revision: 1 },
                },
            });
            const db = workerDb();
            const b = writeBatch(db);
            b.set(doc(db, 'active_sessions', WORKER_ID), { ...closeToIdle, expectedRunId: 'brun-1' });
            await assertSucceeds(b.commit());
        });
    });
});

// ---------------------------------------------------------------------------------------------
// 2026-07-22 audit remediation. Two exploit oracles from the 96-finding deep audit:
//   * request_notifications: a worker forging a SERVER-authored notification type.
//   * calendar_notifications: a worker re-pointing their own audit row at a colleague.
// ---------------------------------------------------------------------------------------------
describeEmulator('audit 2026-07-22 — notification forgery + audit-trail re-pointing', () => {
    describe('request_notifications: server-authored types are not client-writable', () => {
        // The doc a worker would plant to make an admin re-enable ANY account: provenance is honest
        // (createdBy is really them), so every other clause in the create rule passes. Only the
        // type deny-list stands between this and an admin tapping a pixel-identical approval card.
        const forged = (over = {}) => ({
            recipientId: WHOLE_TEAM_ADMIN,
            type: 'account_approval',
            category: 'action',
            targetUserId: OTHER_ID,
            targetUserName: 'Jonas Jonaitis',
            isRead: false,
            createdBy: WORKER_ID,
            createdAt: '2026-07-22T08:00:00.000Z',
            ...over,
        });

        it('exploit: a worker may NOT forge an account_approval card', async () => {
            const db = workerDb();
            await assertFails(addDoc(collection(db, 'request_notifications'), forged()));
        });

        it('exploit: the other seven server-only types are refused too', async () => {
            const db = workerDb();
            for (const type of [
                'achievement', 'task_priority_escalated', 'task_overdue',
                'session_auto_closed', 'timer_running_check', 'recurring_reassign',
                'task_over_estimate',
            ]) {
                await assertFails(addDoc(collection(db, 'request_notifications'), forged({ type })));
            }
        });

        it('the legitimate worker→manager notification still succeeds', async () => {
            // task_completion is the everyday case: the worker finishes work and the manager is told.
            // If this ever fails, the deny-list has over-reached and a real flow is broken.
            const db = workerDb();
            await assertSucceeds(addDoc(collection(db, 'request_notifications'), {
                recipientId: IN_SCOPE_MGR,
                type: 'task_completion',
                category: 'action',
                taskId: 'task-1',
                taskTitle: 'Pakeisti siurblį',
                isRead: false,
                createdBy: WORKER_ID,
                createdAt: '2026-07-22T08:00:00.000Z',
            }));
        });

        it('a comment notification (the other client funnel) still succeeds', async () => {
            const db = workerDb();
            await assertSucceeds(addDoc(collection(db, 'request_notifications'), {
                recipientId: IN_SCOPE_MGR,
                type: 'new_comment',
                category: 'info',
                taskId: 'task-1',
                commentText: 'Reikia daugiau medžiagų',
                isRead: false,
                userId: WORKER_ID,
                createdAt: '2026-07-22T08:00:00.000Z',
            }));
        });
    });

    describe('calendar_notifications: the owner is pinned on update', () => {
        beforeEach(async () => {
            await seed({
                [`calendar_notifications/${WORKER_ID}_2026-W30`]: {
                    userId: WORKER_ID,
                    userName: 'Rules Worker',
                    weekStart: '2026-07-20',
                    changes: [{ type: 'edit', at: '2026-07-22T07:00:00.000Z' }],
                },
            });
        });

        it('exploit: the owner may NOT re-point their calendar-change record at a colleague', async () => {
            const db = workerDb();
            await assertFails(updateDoc(doc(db, 'calendar_notifications', `${WORKER_ID}_2026-W30`), {
                userId: OTHER_ID,
                userName: 'Colleague',
            }));
        });

        it('the legitimate append (changes only, owner untouched) still succeeds', async () => {
            const db = workerDb();
            await assertSucceeds(updateDoc(doc(db, 'calendar_notifications', `${WORKER_ID}_2026-W30`), {
                userId: WORKER_ID,
                changes: [
                    { type: 'edit', at: '2026-07-22T07:00:00.000Z' },
                    { type: 'add', at: '2026-07-22T09:00:00.000Z' },
                ],
            }));
        });
    });

    // ---- P2 #10: bounded client-clock skew -------------------------------------------------
    // The invariant is ASYMMETRIC on purpose: a session records work that already happened, so its
    // end may be arbitrarily EARLIER than server time (an offline worker syncing hours later) but
    // never LATER. These cases pin both directions — the tolerance is what stops an honest fast
    // clock from costing someone their pay, and the deny is what stops a rolled-forward clock from
    // minting paid time. All times are computed from the real clock, because the rule compares
    // against `request.time`, which the emulator serves as genuine server-now.
    describe('P2 #10: a session may not END in the server future', () => {
        const MIN = 60 * 1000;
        const HOUR = 60 * MIN;
        // A minimal, otherwise-valid own row: passes ownership, durationInRange and the R-04
        // provenance pin, so the ONLY thing under test is where endTime sits relative to now.
        function ownSession(endMs, startMs) {
            return {
                userId: WORKER_ID,
                taskId: 'task-a',
                taskTitle: 'Task A',
                startTime: new Date(startMs ?? endMs - 30 * MIN).toISOString(),
                endTime: new Date(endMs).toISOString(),
                durationMinutes: 30,
                date: '2026-07-28',
            };
        }

        it('a session closing right now is accepted (the ordinary online close)', async () => {
            await assertSucceeds(
                setDoc(doc(workerDb(), 'work_sessions', 'skew-now'), ownSession(Date.now()))
            );
        });

        it('a session that ended 6h ago is accepted — the offline-sync case must never be punished', async () => {
            await assertSucceeds(
                setDoc(doc(workerDb(), 'work_sessions', 'skew-past'), ownSession(Date.now() - 6 * HOUR))
            );
        });

        it('a session that ended 30 DAYS ago is accepted — there is deliberately no lower bound', async () => {
            await assertSucceeds(
                setDoc(doc(workerDb(), 'work_sessions', 'skew-old'), ownSession(Date.now() - 30 * 24 * HOUR))
            );
        });

        it('a clock pushed 8h forward is REJECTED (the whole-extra-shift attack)', async () => {
            await assertFails(
                setDoc(doc(workerDb(), 'work_sessions', 'skew-fwd8'), ownSession(Date.now() + 8 * HOUR))
            );
        });

        it('a clock pushed a full day forward is REJECTED', async () => {
            await assertFails(
                setDoc(doc(workerDb(), 'work_sessions', 'skew-fwd1d'), ownSession(Date.now() + 24 * HOUR))
            );
        });

        // The tolerance was tightened from 1h to 2min (2026-07-28). These two pin the new boundary
        // from both sides: an auto-synced phone (drift measured in seconds) is still safely inside,
        // while the mid-session clock-shift manoeuvre is now capped at 2 minutes instead of an hour.
        it('a device seconds fast is still accepted — no honest pay is lost to ordinary drift', async () => {
            await assertSucceeds(
                setDoc(doc(workerDb(), 'work_sessions', 'skew-fast-secs'), ownSession(Date.now() + 30 * 1000))
            );
        });

        it('a device 10 min fast is now REJECTED — outside the tightened 2min tolerance', async () => {
            await assertFails(
                setDoc(doc(workerDb(), 'work_sessions', 'skew-fast10'), ownSession(Date.now() + 10 * MIN))
            );
        });

        it('a break that ends 8h in the future is REJECTED too', async () => {
            await assertFails(
                setDoc(doc(workerDb(), 'break_sessions', 'skew-break-fwd'), {
                    userId: WORKER_ID,
                    startTime: new Date(Date.now() + 7 * HOUR).toISOString(),
                    endTime: new Date(Date.now() + 8 * HOUR).toISOString(),
                    durationMinutes: 60,
                    date: '2026-07-28',
                    isBreak: true,
                })
            );
        });

        it('a break closing now is accepted (the legitimate flow is preserved)', async () => {
            await assertSucceeds(
                setDoc(doc(workerDb(), 'break_sessions', 'skew-break-now'), {
                    userId: WORKER_ID,
                    startTime: new Date(Date.now() - 20 * MIN).toISOString(),
                    endTime: new Date().toISOString(),
                    durationMinutes: 20,
                    date: '2026-07-28',
                    isBreak: true,
                })
            );
        });

        // Permissiveness — the guard must never brick a row whose shape it was not built to judge.
        it('a row with NO endTime at all is accepted (absent field passes unjudged)', async () => {
            await assertSucceeds(
                setDoc(doc(workerDb(), 'work_sessions', 'skew-noend'), {
                    userId: WORKER_ID,
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    durationMinutes: 15,
                    date: '2026-07-28',
                })
            );
        });

        it('a row with a non-ISO endTime is accepted (legacy shapes pass unjudged, never error-denied)', async () => {
            await assertSucceeds(
                setDoc(doc(workerDb(), 'work_sessions', 'skew-legacy'), {
                    userId: WORKER_ID,
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    endTime: '2026/07/28 14:00',
                    durationMinutes: 15,
                    date: '2026-07-28',
                })
            );
        });

        // UPDATE arm: judged only when the write actually CHANGES endTime, so an already-stored bad
        // row stays remediable and unrelated edits are never re-litigated.
        it('an update that leaves endTime untouched is accepted even on a future-dated row', async () => {
            await seed({
                'work_sessions/skew-stored-bad': {
                    userId: WORKER_ID,
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    startTime: new Date(Date.now() + 9 * HOUR).toISOString(),
                    endTime: new Date(Date.now() + 10 * HOUR).toISOString(),
                    durationMinutes: 60,
                    date: '2026-07-28',
                    teamManagerIds: [],
                },
            });
            await assertSucceeds(
                updateDoc(doc(workerDb(), 'work_sessions', 'skew-stored-bad'), {
                    isDeleted: true,
                    deletedAt: new Date().toISOString(),
                })
            );
        });

        it('an update that PUSHES endTime into the server future is rejected', async () => {
            await seed({
                'work_sessions/skew-stored-ok': {
                    userId: WORKER_ID,
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    startTime: new Date(Date.now() - 60 * MIN).toISOString(),
                    endTime: new Date(Date.now() - 30 * MIN).toISOString(),
                    durationMinutes: 30,
                    date: '2026-07-28',
                    teamManagerIds: [],
                },
            });
            await assertFails(
                updateDoc(doc(workerDb(), 'work_sessions', 'skew-stored-ok'), {
                    endTime: new Date(Date.now() + 8 * HOUR).toISOString(),
                })
            );
        });

        it('an update that CORRECTS a future-dated row back to a sane end is accepted (remediation)', async () => {
            await seed({
                'work_sessions/skew-fixme': {
                    userId: WORKER_ID,
                    taskId: 'task-a',
                    taskTitle: 'Task A',
                    startTime: new Date(Date.now() + 9 * HOUR).toISOString(),
                    endTime: new Date(Date.now() + 10 * HOUR).toISOString(),
                    durationMinutes: 60,
                    date: '2026-07-28',
                    teamManagerIds: [],
                },
            });
            await assertSucceeds(
                updateDoc(doc(workerDb(), 'work_sessions', 'skew-fixme'), {
                    endTime: new Date(Date.now() - 5 * MIN).toISOString(),
                })
            );
        });
    });
});

// ---- error_logs: the enriched crash record ------------------------------------------------
// errorLog.js now carries the caller's remaining keys (taskId/commandId/outcome/code) under a
// nested `context` map — the fields that tell a manager reading the log whether a settle failure
// was a `rejected` (nothing happened, the stretch is lost) or a `conflicted` (another device
// already recorded it). A crash report that the rules refuse is a report nobody ever sees, so the
// admitted shape is pinned here: the enriched append must SUCCEED, and the two boundaries that
// protect the manager-visible log — the userId pin and the map bound — must still bite.
describeEmulator('error_logs: the durable crash record admits its diagnostic context', () => {
    const errorRecord = (overrides = {}) => ({
        message: 'FirebaseError: Missing or insufficient permissions.',
        stack: 'Error\n    at settle',
        componentStack: '',
        source: 'timerCommandEngine.settle',
        userId: WORKER_ID,
        url: 'https://workz.test/',
        userAgent: 'vitest-UA',
        online: true,
        timestamp: new Date().toISOString(),
        ...overrides,
    });

    it('accepts the enriched append (context map alongside the top-level fields)', async () => {
        await assertSucceeds(addDoc(collection(workerDb(), 'error_logs'), errorRecord({
            context: { commandId: 'cmd-7', commandKind: 'end', outcome: 'conflicted', taskId: 'task-a' },
        })));
    });

    it('still accepts the pre-auth record (userId null, no context) — the earliest-crash case', async () => {
        await assertSucceeds(addDoc(collection(workerDb(), 'error_logs'), errorRecord({ userId: null })));
    });

    it('the userId pin still holds: a record stamped for a colleague is denied', async () => {
        // Nesting the caller's keys is what keeps this pin reachable — a context userId must not
        // become the record's userId, or this denial would fire on an honest crash report.
        await assertFails(addDoc(collection(workerDb(), 'error_logs'), errorRecord({
            userId: OTHER_ID,
            context: { userId: OTHER_ID },
        })));
    });

    it('a context map past the 20-key bound is denied', async () => {
        const context = {};
        for (let i = 0; i < 21; i++) context[`k${i}`] = i;
        await assertFails(addDoc(collection(workerDb(), 'error_logs'), errorRecord({ context })));
    });

    it('a context that is not a map is denied', async () => {
        await assertFails(addDoc(collection(workerDb(), 'error_logs'), errorRecord({
            context: 'not-a-map',
        })));
    });
});
