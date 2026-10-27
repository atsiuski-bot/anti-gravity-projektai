/**
 * D11 kill switch: while AI_CALLABLES_ENABLED is false in functions/index.js, BOTH AI callables
 * (parseTaskDraft, suggestTimeCorrection) must refuse before anything leaves Firebase.
 *
 * Each handler is invoked directly (the v2 `run` hook) with a signed-in caller and real-looking
 * text — exactly the request that would reach OpenRouter if the switch were on. Outbound HTTP from
 * the handlers goes through global fetch, which is replaced by a recorder. The refusal must come
 * first: flipping the switch back on makes the handler reach assertActiveCaller (Firestore) and
 * then fetch, so this file fails — the intended signal that the egress is live again.
 *
 * Runs on bare node, no emulator, no network: `node functions/aiCallablesOff.test.cjs`.
 */

const assert = require('assert');

// Same discovery env as discovery.test.cjs: initializeApp() needs a project to infer.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-workz-timer';
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'demo-workz-timer' });

const outbound = [];
global.fetch = async (url) => {
    outbound.push(String(url));
    throw new Error('network is disabled in this test');
};

const mod = require('./index.js');

const request = {
    auth: { uid: 'u1' },
    data: {
        text: 'rytoj Jonui 2 val. tvoros dažymas',
        roster: [{ id: 'u1', name: 'Jonas Jonaitis' }],
        day: '2026-10-27',
        rows: [{ id: 'w1', type: 'work', title: 'Tvora', start: '08:00', end: '09:00' }],
        tasks: [{ id: 't1', title: 'Tvora' }],
    },
};

(async () => {
    for (const name of ['parseTaskDraft', 'suggestTimeCorrection']) {
        await assert.rejects(
            () => mod[name].run(request),
            (err) => err && err.code === 'failed-precondition',
            `${name} did not refuse with failed-precondition — is the AI kill switch still off?`
        );
    }
    assert.deepStrictEqual(outbound, [], `an AI callable called out while switched off: ${outbound.join(', ')}`);
    console.log('aiCallablesOff.test: OK — parseTaskDraft and suggestTimeCorrection refuse with no outbound call');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
