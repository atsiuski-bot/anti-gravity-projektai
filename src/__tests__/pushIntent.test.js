/**
 * PUSH INTENT — the app side of a tapped background notification (ADR 0024).
 *
 * Why this is worth its own suite: the module decides, at import time, whether a decision the user
 * pressed on a lockscreen gets executed. Both of its failure modes are SILENT.
 *   - Capture too late (or not at all) and the button does nothing — indistinguishable from a bug in
 *     the notification itself.
 *   - Fail to STRIP the intent out of the URL and it replays: a reload, a restored tab or a shared
 *     link re-approves a task the manager approved once. That is a real double write, and nothing in
 *     the UI would ever hint at it.
 *
 * The suite runs on bare node (this repo has no jsdom) with `window`/`navigator` stubbed, which is
 * also the honest shape of the contract: the module must tolerate a missing browser rather than
 * throw during module evaluation and take the whole app's boot down with it.
 *
 * Because the capture is a module-level side effect, every case resets the module registry and
 * re-imports AFTER installing its own stubs.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const ORIGIN = 'https://app.test';

/** Minimal window stub whose href actually MOVES when history.replaceState is called. */
function stubWindow(href) {
    const state = { href, replaceCalls: [] };
    vi.stubGlobal('window', {
        location: {
            get href() { return state.href; },
            origin: ORIGIN,
        },
        history: {
            state: { some: 'router-state' },
            replaceState(historyState, title, url) {
                state.replaceCalls.push({ historyState, url });
                state.href = new URL(url, ORIGIN).href;
            },
        },
    });
    return state;
}

/** Minimal navigator.serviceWorker stub that records listeners so a message can be delivered. */
function stubServiceWorker() {
    const listeners = new Set();
    vi.stubGlobal('navigator', {
        serviceWorker: {
            addEventListener: (type, handler) => { if (type === 'message') listeners.add(handler); },
            removeEventListener: (type, handler) => { if (type === 'message') listeners.delete(handler); },
        },
    });
    return {
        get count() { return listeners.size; },
        deliver: (data) => listeners.forEach((h) => h({ data })),
    };
}

async function loadModule() {
    vi.resetModules();
    return import('../notifications/pushIntent.js');
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('cold-start intent (the app was closed, so the worker put the intent in the URL)', () => {
    it('captures the intent and reports where to land', async () => {
        stubWindow(`${ORIGIN}/?tab=tasks&na=approve&nid=notif-1&nt=task_approval`);
        const { takeUrlPushIntent } = await loadModule();

        const intent = takeUrlPushIntent();
        expect(intent).toMatchObject({
            action: 'approve',
            notifId: 'notif-1',
            notifType: 'task_approval',
            link: '/?tab=tasks',
        });
        expect(intent.seq).toBeGreaterThan(0);
    });

    it('strips the intent out of the address bar, keeping the rest of the query', async () => {
        const win = stubWindow(`${ORIGIN}/?tab=tasks&na=approve&nid=notif-1&nt=task_approval`);
        await loadModule();

        // The strip must happen at MODULE LOAD — before react-router reads the URL — because
        // NavigationContext later rewrites the query from its own copy of the search params and
        // would resurrect anything still there.
        expect(win.replaceCalls).toHaveLength(1);
        expect(win.replaceCalls[0].url).toBe('/?tab=tasks');
        expect(win.href).toBe(`${ORIGIN}/?tab=tasks`);
        // The router's own history state is preserved, not clobbered.
        expect(win.replaceCalls[0].historyState).toEqual({ some: 'router-state' });
    });

    it('hands the intent to ONE consumer — a second read gets nothing', async () => {
        stubWindow(`${ORIGIN}/?tab=tasks&na=confirm&nid=notif-2&nt=task_completion`);
        const { takeUrlPushIntent } = await loadModule();

        expect(takeUrlPushIntent()).not.toBeNull();
        // The decisive property: were this replayable, two mounts (or React StrictMode) would run
        // the same decision twice.
        expect(takeUrlPushIntent()).toBeNull();
        expect(takeUrlPushIntent()).toBeNull();
    });

    it('a normal visit carries no intent and the URL is left untouched', async () => {
        const win = stubWindow(`${ORIGIN}/?tab=tasks`);
        const { takeUrlPushIntent } = await loadModule();

        expect(takeUrlPushIntent()).toBeNull();
        expect(win.replaceCalls).toHaveLength(0);
    });

    it('an intent naming no notification still resolves — with empty, not undefined, fields', async () => {
        stubWindow(`${ORIGIN}/?na=open`);
        const { takeUrlPushIntent } = await loadModule();

        expect(takeUrlPushIntent()).toMatchObject({ action: 'open', notifId: '', notifType: '', link: '/' });
    });

    it('evaluates without a browser at all instead of throwing during boot', async () => {
        vi.stubGlobal('window', undefined);
        const { takeUrlPushIntent } = await loadModule();
        expect(takeUrlPushIntent()).toBeNull();
    });
});

describe('live intent (the app was already running, so the worker posted a message)', () => {
    it('delivers a worker message as an intent', async () => {
        stubWindow(`${ORIGIN}/?tab=tasks`);
        const sw = stubServiceWorker();
        const { subscribePushIntent, PUSH_INTENT_MESSAGE } = await loadModule();

        const seen = [];
        subscribePushIntent((i) => seen.push(i));
        sw.deliver({
            type: PUSH_INTENT_MESSAGE,
            action: 'extend30',
            notifId: 'notif-3',
            notifType: 'time_extension_request',
            link: '/?tab=tasks',
        });

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ action: 'extend30', notifId: 'notif-3', notifType: 'time_extension_request' });
    });

    it('ignores messages that are not ours', async () => {
        stubWindow(`${ORIGIN}/`);
        const sw = stubServiceWorker();
        const { subscribePushIntent } = await loadModule();

        const seen = [];
        subscribePushIntent((i) => seen.push(i));
        // Workbox, the FCM SDK and any other worker share this one channel.
        sw.deliver({ type: 'SKIP_WAITING' });
        sw.deliver({ type: 'workbox-broadcast-update' });
        sw.deliver(undefined);
        sw.deliver('a string');

        expect(seen).toEqual([]);
    });

    it('normalizes a malformed payload rather than passing junk to a decision handler', async () => {
        stubWindow(`${ORIGIN}/`);
        const sw = stubServiceWorker();
        const { subscribePushIntent, PUSH_INTENT_MESSAGE } = await loadModule();

        const seen = [];
        subscribePushIntent((i) => seen.push(i));
        sw.deliver({ type: PUSH_INTENT_MESSAGE, action: 42, notifId: null, link: { nope: true } });

        expect(seen[0]).toMatchObject({ action: '', notifId: '', notifType: '', link: '/' });
    });

    it('gives every intent a fresh seq, so a repeat of the same tap is still a NEW intent', async () => {
        stubWindow(`${ORIGIN}/`);
        const sw = stubServiceWorker();
        const { subscribePushIntent, PUSH_INTENT_MESSAGE } = await loadModule();

        const seen = [];
        subscribePushIntent((i) => seen.push(i));
        const msg = { type: PUSH_INTENT_MESSAGE, action: 'open', notifId: 'n', notifType: 't', link: '/' };
        sw.deliver(msg);
        sw.deliver(msg);

        // Identical payloads must not collapse: the consumer de-duplicates on seq, so equal seqs
        // would make a legitimate second tap silently do nothing.
        expect(seen).toHaveLength(2);
        expect(seen[1].seq).toBeGreaterThan(seen[0].seq);
    });

    it('unsubscribing detaches the listener', async () => {
        stubWindow(`${ORIGIN}/`);
        const sw = stubServiceWorker();
        const { subscribePushIntent } = await loadModule();

        const off = subscribePushIntent(() => {});
        expect(sw.count).toBe(1);
        off();
        expect(sw.count).toBe(0);
    });

    it('is a no-op where service workers do not exist', async () => {
        stubWindow(`${ORIGIN}/`);
        vi.stubGlobal('navigator', {});
        const { subscribePushIntent } = await loadModule();

        const off = subscribePushIntent(() => {});
        expect(() => off()).not.toThrow();
    });
});

describe('tabFromLink', () => {
    it('reads the tab a notification points at', async () => {
        stubWindow(`${ORIGIN}/`);
        const { tabFromLink } = await loadModule();

        expect(tabFromLink('/?tab=tasks')).toBe('tasks');
        expect(tabFromLink('/?tab=calendar')).toBe('calendar');
        expect(tabFromLink('/?tab=profile')).toBe('profile');
        expect(tabFromLink('/?tab=team-calendar')).toBe('team-calendar');
    });

    it('returns null when no tab is named, so the caller leaves the current one alone', async () => {
        stubWindow(`${ORIGIN}/`);
        const { tabFromLink } = await loadModule();

        expect(tabFromLink('/')).toBeNull();
        expect(tabFromLink('')).toBeNull();
        expect(tabFromLink(undefined)).toBeNull();
    });
});
