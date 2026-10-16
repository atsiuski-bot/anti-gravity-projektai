import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
    collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { readFile } from 'node:fs/promises';

// Standing duties ("Savaitiniai darbai"): each person sees and edits only their OWN duties, an admin
// sees and manages all; a worker cannot create one; ownership is immutable for a non-admin; nothing
// is ever hard-deleted and the mark history is append-only.

const PROJECT_ID = 'demo-workz-duties-rules';
const ADMIN = 'duty-admin';
const COORD = 'duty-coord';
const OTHER_COORD = 'duty-coord-2';
const WORKER = 'duty-worker';
const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const describeEmulator = emulatorAvailable ? describe : describe.skip;

let testEnv;

const dbFor = (uid) => testEnv.authenticatedContext(uid, { email: `${uid}@example.test` }).firestore();

const duty = (overrides = {}) => ({
    title: 'Išsiųsti atsiliepimai',
    intervalDays: 7,
    ownerId: COORD,
    coveredThrough: null,
    lastNote: null,
    lastMarkedAt: null,
    lastMarkedBy: null,
    archived: false,
    createdBy: COORD,
    ...overrides,
});

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
        const db = context.firestore();
        await Promise.all([
            setDoc(doc(db, `users/${ADMIN}`), { role: 'admin', isDisabled: false }),
            setDoc(doc(db, `users/${COORD}`), { role: 'manager', isDisabled: false }),
            setDoc(doc(db, `users/${OTHER_COORD}`), { role: 'manager', isDisabled: false }),
            setDoc(doc(db, `users/${WORKER}`), { role: 'worker', isDisabled: false }),
            setDoc(doc(db, 'duties/d-coord'), duty()),
            setDoc(doc(db, 'duties/d-coord/marks/m1'), { coveredThrough: '2026-10-08', note: null, markedBy: COORD }),
        ]);
    });
}, 30_000);

afterAll(async () => {
    await testEnv?.cleanup();
});

describeEmulator('firestore.rules — duties', () => {
    it('the owner and an admin read a duty; another coordinator and a worker cannot', async () => {
        await assertSucceeds(getDoc(doc(dbFor(COORD), 'duties/d-coord')));
        await assertSucceeds(getDoc(doc(dbFor(ADMIN), 'duties/d-coord')));
        await assertFails(getDoc(doc(dbFor(OTHER_COORD), 'duties/d-coord')));
        await assertFails(getDoc(doc(dbFor(WORKER), 'duties/d-coord')));
    });

    it('a coordinator lists only by their own ownerId; an admin lists everything', async () => {
        await assertSucceeds(getDocs(query(collection(dbFor(COORD), 'duties'), where('ownerId', '==', COORD))));
        await assertFails(getDocs(collection(dbFor(COORD), 'duties')));
        await assertSucceeds(getDocs(collection(dbFor(ADMIN), 'duties')));
    });

    it('a coordinator creates their own duty, not one for someone else', async () => {
        const db = dbFor(OTHER_COORD);
        await assertSucceeds(setDoc(doc(db, 'duties/new-own'), duty({ ownerId: OTHER_COORD, createdBy: OTHER_COORD })));
        await assertFails(setDoc(doc(db, 'duties/new-foreign'), duty({ ownerId: COORD, createdBy: OTHER_COORD })));
    });

    it('an admin creates a duty for a coordinator', async () => {
        await assertSucceeds(setDoc(doc(dbFor(ADMIN), 'duties/by-admin'), duty({ createdBy: ADMIN })));
    });

    it('a worker cannot create a duty, even their own', async () => {
        await assertFails(setDoc(doc(dbFor(WORKER), 'duties/w'), duty({ ownerId: WORKER, createdBy: WORKER })));
    });

    it('rejects a bad shape: unknown cadence, malformed date, empty title, forged createdBy', async () => {
        const db = dbFor(COORD);
        await assertFails(setDoc(doc(db, 'duties/x1'), duty({ intervalDays: 5 })));
        await assertFails(setDoc(doc(db, 'duties/x2'), duty({ coveredThrough: '15.10.2026' })));
        await assertFails(setDoc(doc(db, 'duties/x3'), duty({ title: '' })));
        await assertFails(setDoc(doc(db, 'duties/x4'), duty({ createdBy: ADMIN })));
    });

    it('the owner marks a duty (watermark + history in one batch)', async () => {
        const db = dbFor(COORD);
        const batch = writeBatch(db);
        batch.update(doc(db, 'duties/d-coord'), { coveredThrough: '2026-10-15', lastNote: 'Visi išsiųsti', lastMarkedBy: COORD });
        batch.set(doc(db, 'duties/d-coord/marks/m2'), { coveredThrough: '2026-10-15', note: 'Visi išsiųsti', markedBy: COORD });
        await assertSucceeds(batch.commit());
    });

    it('another coordinator cannot mark, edit or read the history of a duty they do not own', async () => {
        const db = dbFor(OTHER_COORD);
        await assertFails(updateDoc(doc(db, 'duties/d-coord'), { coveredThrough: '2026-10-15' }));
        await assertFails(setDoc(doc(db, 'duties/d-coord/marks/mx'), { coveredThrough: '2026-10-15', note: null, markedBy: OTHER_COORD }));
        await assertFails(getDocs(collection(db, 'duties/d-coord/marks')));
    });

    it('a mark must be signed by its writer', async () => {
        await assertFails(setDoc(doc(dbFor(COORD), 'duties/d-coord/marks/forged'), { coveredThrough: '2026-10-15', note: null, markedBy: ADMIN }));
    });

    it('the owner cannot hand a duty to someone else; an admin can re-assign it', async () => {
        await assertFails(updateDoc(doc(dbFor(COORD), 'duties/d-coord'), { ownerId: OTHER_COORD }));
        await assertSucceeds(updateDoc(doc(dbFor(ADMIN), 'duties/d-coord'), { ownerId: OTHER_COORD }));
    });

    it('the owner archives a duty; nobody hard-deletes one', async () => {
        await assertSucceeds(updateDoc(doc(dbFor(COORD), 'duties/d-coord'), { archived: true }));
        await assertFails(deleteDoc(doc(dbFor(ADMIN), 'duties/d-coord')));
    });

    it('history is append-only, even for the owner and an admin', async () => {
        await assertSucceeds(getDocs(collection(dbFor(COORD), 'duties/d-coord/marks')));
        await assertSucceeds(getDocs(collection(dbFor(ADMIN), 'duties/d-coord/marks')));
        await assertFails(updateDoc(doc(dbFor(COORD), 'duties/d-coord/marks/m1'), { note: 'pakeista' }));
        await assertFails(deleteDoc(doc(dbFor(ADMIN), 'duties/d-coord/marks/m1')));
    });
});
