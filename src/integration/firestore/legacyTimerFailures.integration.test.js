import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
    disableNetwork,
    doc,
    enableNetwork,
    getDoc,
    getDocFromCache,
    onSnapshot,
    setDoc,
    updateDoc,
} from 'firebase/firestore';
import { readFile } from 'node:fs/promises';

const PROJECT_ID = 'demo-workz-timer';
const USER_ID = 'timer-worker';
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
    return testEnv.authenticatedContext(USER_ID, {
        email: 'timer-worker@example.test',
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
        [`users/${USER_ID}`]: {
            role: 'worker',
            isDisabled: false,
            activeSession: null,
            workStatus: { isWorking: false, status: 'idle', activeTaskId: null },
        },
    });
});

afterAll(async () => {
    await testEnv?.cleanup();
});

describeEmulator('legacy timer failure reproductions', () => {
    it('keeps a Firestore mutation promise pending offline after the local cache accepted it', async () => {
        const db = workerDb();
        const userRef = doc(db, 'users', USER_ID);

        let sawPendingSnapshot = false;
        let resolveInitialSnapshot;
        let resolvePendingSnapshot;
        const initialSnapshot = new Promise((resolve) => {
            resolveInitialSnapshot = resolve;
        });
        const pendingSnapshot = new Promise((resolve) => {
            resolvePendingSnapshot = resolve;
        });
        const unsubscribe = onSnapshot(
                userRef,
                { includeMetadataChanges: true },
                (snapshot) => {
                    if (!snapshot.metadata.hasPendingWrites) {
                        resolveInitialSnapshot();
                    }
                    if (
                        snapshot.metadata.hasPendingWrites
                        && snapshot.data()?.activeSession?.runId === 'offline-run'
                    ) {
                        sawPendingSnapshot = true;
                        resolvePendingSnapshot();
                    }
                },
                (error) => {
                    throw error;
                }
            );

        await initialSnapshot;
        await disableNetwork(db);

        let writePromise;
        try {
            writePromise = updateDoc(userRef, {
                activeSession: {
                    type: 'task',
                    taskId: 'task-offline',
                    runId: 'offline-run',
                    startTime: '2026-07-09T08:00:00.000Z',
                },
            });

            const settledBeforeReconnect = await Promise.race([
                writePromise.then(() => true, () => true),
                new Promise((resolve) => setTimeout(() => resolve(false), 150)),
            ]);

            await pendingSnapshot;
            const cached = await getDocFromCache(userRef);

            expect(settledBeforeReconnect).toBe(false);
            expect(sawPendingSnapshot).toBe(true);
            expect(cached.data().activeSession.runId).toBe('offline-run');
        } finally {
            await enableNetwork(db);
            unsubscribe();
        }
        await assertSucceeds(writePromise);
    }, 10_000);

    it('allows two stale devices to overwrite the same active session with no visible loser', async () => {
        const firstDevice = workerDb();
        const secondDevice = workerDb();
        const firstRef = doc(firstDevice, 'users', USER_ID);
        const secondRef = doc(secondDevice, 'users', USER_ID);

        const [firstBase, secondBase] = await Promise.all([
            getDoc(firstRef),
            getDoc(secondRef),
        ]);
        expect(firstBase.data().activeSession).toBeNull();
        expect(secondBase.data().activeSession).toBeNull();

        await assertSucceeds(updateDoc(firstRef, {
            activeSession: {
                type: 'task',
                taskId: 'task-a',
                runId: 'run-a',
                startTime: '2026-07-09T08:00:00.000Z',
            },
        }));
        await assertSucceeds(updateDoc(secondRef, {
            activeSession: {
                type: 'task',
                taskId: 'task-b',
                runId: 'run-b',
                startTime: '2026-07-09T08:00:01.000Z',
            },
        }));

        const final = await getDoc(firstRef);
        expect(final.data().activeSession.runId).toBe('run-b');
    });

    it('can clear the active session even when the matching ledger write is rejected', async () => {
        await seed({
            [`users/${USER_ID}`]: {
                role: 'worker',
                isDisabled: false,
                activeSession: {
                    type: 'task',
                    taskId: 'task-a',
                    runId: 'run-a',
                    startTime: '2026-07-09T08:00:00.000Z',
                },
                workStatus: {
                    isWorking: true,
                    status: 'running',
                    activeTaskId: 'task-a',
                },
            },
        });

        const db = workerDb();
        const userRef = doc(db, 'users', USER_ID);
        const ledgerRef = doc(db, 'work_sessions', 'legacy-partial-failure');

        await assertSucceeds(updateDoc(userRef, {
            activeSession: null,
            workStatus: {
                isWorking: false,
                status: 'paused',
                activeTaskId: 'task-a',
            },
        }));
        await assertFails(setDoc(ledgerRef, {
            userId: USER_ID,
            taskId: 'task-a',
            startTime: '2026-07-09T08:00:00.000Z',
            endTime: '2026-07-10T18:00:00.000Z',
            durationMinutes: 2040,
            date: '2026-07-10',
        }));

        const userAfter = await getDoc(userRef);
        let ledgerExists;
        await testEnv.withSecurityRulesDisabled(async (context) => {
            ledgerExists = (await getDoc(doc(context.firestore(), ledgerRef.path))).exists();
        });
        expect(userAfter.data().activeSession).toBeNull();
        expect(ledgerExists).toBe(false);
    });
});
