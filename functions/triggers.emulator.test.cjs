/**
 * Emulator ROUND-TRIP of two Admin-SDK authority boundaries in functions/index.js (audit 2026-09-07).
 *
 * discovery.test.cjs proves index.js still LOADS; adminSdk.emulator.test.cjs proves the SDK
 * behaviours it leans on; neither invokes a trigger. The two findings below are about what a
 * trigger DOES with the authority it holds, so they are exercised here through the v2 `run()`
 * handle every exported function carries — against the real Firestore emulator, not a mock:
 *
 *   S3 — stampTeamOnTaskWrite is delivered out of order. A task reassigned A→B then B→C fires two
 *        invocations; if the A→B one finishes LAST it used to stamp B's team onto a task now owned
 *        by C, permanently (the next routine edit sees "owner unchanged + stamp present" and skips).
 *        The stamp write is now owner-guarded inside a transaction.
 *   S2 — the recurring materializer creates tasks with Admin SDK authority from ANY template, so a
 *        worker's personal template naming a colleague injected a task into that colleague's queue.
 *        generateOneRecurring now re-checks the creator's assignment scope (mirrors the tasks create
 *        rule) before it writes.
 *
 * Run (the test:firestore script does this):
 *   firebase emulators:exec --project demo-workz-timer --only firestore "node functions/triggers.emulator.test.cjs"
 */

const assert = require('assert');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('triggers.emulator.test: FIRESTORE_EMULATOR_HOST is not set — run this through `firebase emulators:exec`, not bare node.');
    process.exit(1);
}

// Same discovery-style environment as discovery.test.cjs: index.js calls initializeApp() at module
// scope and needs a project id; with FIRESTORE_EMULATOR_HOST set, its getFirestore() targets the
// emulator, so every write below lands in the emulator and nowhere else.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-workz-timer';
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'demo-workz-timer' });

const mod = require('./index.js');
const { getFirestore } = require('firebase-admin/firestore');
const db = getFirestore();

const P = '_trig_'; // id prefix so a leftover row is recognizable
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function seedUsers(users) {
    await Promise.all(Object.entries(users).map(([id, data]) => db.collection('users').doc(id).set(data)));
}

// --- S3: a stale reassignment event must not overwrite a newer owner's stamp ----------------------
check('S3: a delayed A→B stamp event does NOT overwrite the stamp of a task since reassigned to C', async () => {
    await seedUsers({
        [`${P}team-B`]: { role: 'manager', scopedManager: true },
        [`${P}team-C`]: { role: 'manager', scopedManager: true },
        [`${P}B`]: { role: 'worker', teamManagerIds: [`${P}team-B`] },
        [`${P}C`]: { role: 'worker', teamManagerIds: [`${P}team-C`] },
    });
    const ref = db.collection('tasks').doc(`${P}race`);
    await ref.set({ title: 'Race', assignedUserId: `${P}B`, status: 'pending' });
    const snapB = await ref.get(); // the "after" snapshot of the A→B event
    await ref.update({ assignedUserId: `${P}C` });
    const snapC = await ref.get(); // the "after" snapshot of the B→C event

    // The newer event runs first and lands C's team.
    await mod.stampTeamOnTaskWrite.run({ data: { before: snapB, after: snapC }, params: { id: ref.id } });
    assert.deepStrictEqual((await ref.get()).data().teamManagerIds, [`${P}team-C`], 'the B→C event did not stamp C\'s team');

    // Then the OLDER event (its snapshot still says B) finishes last.
    await mod.stampTeamOnTaskWrite.run({ data: { before: { exists: false }, after: snapB }, params: { id: ref.id } });
    assert.deepStrictEqual(
        (await ref.get()).data().teamManagerIds, [`${P}team-C`],
        'the stale A→B event overwrote the newer owner\'s stamp — the owner guard in writeStamp is not holding',
    );
});

check('S3 control: an in-order reassignment event still stamps the new owner\'s team', async () => {
    const ref = db.collection('tasks').doc(`${P}inorder`);
    await ref.set({ title: 'In order', assignedUserId: `${P}B`, status: 'pending', teamManagerIds: [`${P}team-B`] });
    const before = await ref.get();
    await ref.update({ assignedUserId: `${P}C` });
    const after = await ref.get();
    await mod.stampTeamOnTaskWrite.run({ data: { before, after }, params: { id: ref.id } });
    assert.deepStrictEqual((await ref.get()).data().teamManagerIds, [`${P}team-C`]);
});

// --- S2: the materializer enforces the creator's assignment scope ---------------------------------
const MGR = `${P}mgr-unscoped`;
const SCOPED = `${P}mgr-scoped`;
const WORKER = `${P}worker`;
const COLLEAGUE = `${P}colleague`;

async function runNow(templateId) {
    // The callable's own gate (an ACTIVE manager+ caller) is satisfied by MGR; what is under test is
    // the boundary AFTER it — whose template, and whom it may assign.
    return mod.runRecurringTasksNow.run({ auth: { uid: MGR, token: {} }, data: { templateId }, rawRequest: {} });
}

check('S2: a worker\'s template naming a colleague is refused by the materializer', async () => {
    await seedUsers({
        [MGR]: { role: 'manager', isDisabled: false },
        [SCOPED]: { role: 'manager', scopedManager: true, isDisabled: false },
        [WORKER]: { role: 'worker', isDisabled: false },
        [COLLEAGUE]: { role: 'worker', isDisabled: false, overseerIds: [] },
    });
    const id = `${P}tmpl-worker`;
    await db.collection('task_templates').doc(id).set({
        scope: 'personal', createdBy: WORKER, templateName: 'Injected',
        recurrence: { freq: 'daily', active: true },
        data: { title: 'Injected colleague task', assignedUserId: COLLEAGUE },
    });
    const r = await runNow(id);
    assert.strictEqual(r.created, false, `expected created:false, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.reason, 'creator-not-overseer');
    const leaked = await db.collection('tasks').where('sourceTemplateId', '==', id).get();
    assert.strictEqual(leaked.size, 0, 'a task was materialized from the worker\'s template');
});

check('S2: a worker\'s SELF-assigned template still materializes', async () => {
    const id = `${P}tmpl-self`;
    await db.collection('task_templates').doc(id).set({
        scope: 'personal', createdBy: WORKER, templateName: 'Mine',
        recurrence: { freq: 'daily', active: true },
        data: { title: 'My own recurring task', assignedUserId: WORKER },
    });
    const r = await runNow(id);
    assert.strictEqual(r.created, true, `expected created:true, got ${JSON.stringify(r)}`);
    assert.strictEqual((await db.collection('tasks').doc(r.taskId).get()).data().assignedUserId, WORKER);
});

check('S2: a SCOPED manager\'s template may only assign inside their closure', async () => {
    const id = `${P}tmpl-scoped`;
    const tref = db.collection('task_templates').doc(id);
    await tref.set({
        scope: 'personal', createdBy: SCOPED, templateName: 'Scoped',
        recurrence: { freq: 'daily', active: true },
        data: { title: 'Scoped task', assignedUserId: COLLEAGUE },
    });
    const refused = await runNow(id);
    assert.strictEqual(refused.created, false, `expected created:false, got ${JSON.stringify(refused)}`);
    assert.strictEqual(refused.reason, 'assignee-out-of-scope');

    // Put the colleague inside the scoped manager's subtree — now it is a legitimate assignment.
    await db.collection('users').doc(COLLEAGUE).update({ overseerIds: [SCOPED] });
    const ok = await runNow(id);
    assert.strictEqual(ok.created, true, `expected created:true, got ${JSON.stringify(ok)}`);
});

check('S2: an UNSCOPED manager keeps whole-company reach', async () => {
    const id = `${P}tmpl-mgr`;
    await db.collection('task_templates').doc(id).set({
        scope: 'team', createdBy: MGR, templateName: 'Team',
        recurrence: { freq: 'daily', active: true },
        data: { title: 'Team task', assignedUserId: COLLEAGUE },
    });
    const r = await runNow(id);
    assert.strictEqual(r.created, true, `expected created:true, got ${JSON.stringify(r)}`);
});

check('S2: a DISABLED creator\'s template no longer fires', async () => {
    await db.collection('users').doc(MGR).update({ isDisabled: true });
    const id = `${P}tmpl-disabled`;
    await db.collection('task_templates').doc(id).set({
        scope: 'team', createdBy: MGR, templateName: 'Ex-manager',
        recurrence: { freq: 'daily', active: true },
        data: { title: 'Ghost task', assignedUserId: COLLEAGUE },
    });
    // Run through a still-active caller (SCOPED) — the CREATOR is the one being blocked.
    const r = await mod.runRecurringTasksNow.run({ auth: { uid: SCOPED, token: {} }, data: { templateId: id }, rawRequest: {} });
    assert.strictEqual(r.created, false, `expected created:false, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.reason, 'creator-disabled');
});

// --- runner ---------------------------------------------------------------------------------------
(async () => {
    let failed = 0;
    for (const { name, fn } of checks) {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            failed += 1;
            console.error(`  FAIL ${name}\n       ${err.stack || err.message}`);
        }
    }
    if (failed) {
        console.error(`triggers.emulator.test: ${failed} of ${checks.length} checks FAILED`);
        process.exit(1);
    }
    console.log(`triggers.emulator.test: OK — ${checks.length} trigger round-trips against the emulator`);
    process.exit(0);
})();
