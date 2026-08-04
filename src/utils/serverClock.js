/**
 * Server-anchored wall clock.
 *
 * WHY THIS EXISTS. Every credited minute in this app is stamped by the DEVICE (ADR 0021), and
 * firestore.rules refuses any session row whose endTime sits more than 2 minutes in the server's
 * future (the bounded client-skew guard, `endTimeNotInServerFuture`). Those two facts collide on a
 * machine whose clock simply runs fast: the stop is denied at the door, and because a transition
 * commits as ONE atomic batch, the denial takes the active-session revision bump and the task
 * projection with it. The worker's stop does not happen at all — they stay canonically live and the
 * stretch is never credited. A device-configuration problem thus presents as lost pay, on that
 * device only, forever, while the same account works fine from a phone whose clock is NTP-synced.
 *
 * The fix belongs HERE and not in the rule. Loosening the tolerance would only move the cliff: a
 * clock is either trusted or it is not, and "trusted within N minutes" still rejects the worker
 * whose PC is N+1 minutes off. What the app can do instead is stop asserting a time it has no
 * business asserting — ask the server what time it is, and stamp sessions in THAT frame.
 *
 * WHY DURATIONS SURVIVE. The offset is applied uniformly to both ends of a run, so `end - start` is
 * unchanged: a device 5 minutes fast credits exactly the same number of minutes as a correct one,
 * it just records them at the instant they really happened. The one case that does shift is a run
 * whose START was stamped before this anchor was known (or on another device) and whose END is
 * anchored — that close under-credits by the skew. It is still strictly better than today, where
 * the same close is REFUSED and credits nothing.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not make client-authored time trustworthy — a rolled
 * clock still shifts start and end together, which is exactly why the rule's tolerance stays where
 * the founder set it (2 min) and why ADR 0021's server-anchored-start rework is still the real
 * answer to forged durations. This only stops an HONEST wrong clock from destroying honest work.
 */

// How far the device clock may be off before we stop believing it. Below this band the offset is
// forced to exactly zero, so a healthy device behaves EXACTLY as it did before this module existed
// — no sub-second jitter injected into a path where every stamped instant is compared, deduped and
// credited. Above it, the measurement is real skew worth correcting. 5s is ~2 orders of magnitude
// below the rule's 2-minute ceiling (so a corrected device is never near the cliff) and ~1 order
// above the probe's own accuracy (see MAX_SAMPLE_RTT_MS), so the band can never chase noise.
export const CLOCK_TRUST_BAND_MS = 5000;

// A sample is only as good as the round trip it was measured across: we know the response was
// produced somewhere inside [t0, t1] and take the midpoint, so the estimate carries up to rtt/2 of
// error. A slow link would make that error larger than the band we are trying to resolve, so such a
// sample is discarded rather than believed — an unmeasured clock keeps the previous anchor, which is
// the safe direction.
const MAX_SAMPLE_RTT_MS = 15000;

// Re-measure when the tab comes back after being away this long. A PWA left open for days is this
// app's norm, not its exception (that is precisely the desktop shape this bug appeared on), and a
// machine that suspends and resumes is the commonest way a clock moves mid-session.
const RESYNC_AFTER_MS = 30 * 60 * 1000;

let offsetMs = 0;
let lastSyncedAt = 0;
let inFlight = null;
let installed = false;
let probeCounter = 0;

/** Milliseconds to ADD to the device clock to land on server time (0 when the device is trusted). */
export const serverClockOffsetMs = () => offsetMs;

/** True once a probe has actually landed — the app is stamping in the server's frame, not a guess. */
export const isServerClockSynced = () => lastSyncedAt > 0;

/** Server-anchored `Date.now()`. Falls back to the device clock until (and unless) a probe lands. */
export const serverNowMs = () => Date.now() + offsetMs;

/** Server-anchored `new Date()`. */
export const serverNow = () => new Date(serverNowMs());

/** Server-anchored `new Date().toISOString()` — the stamp every session write should carry. */
export const serverNowISO = () => serverNow().toISOString();

/**
 * Re-express a DEVICE-clock instant (a raw `Date.now()`) in the server's frame.
 *
 * Needed because one class of instant cannot be server-anchored at the moment it is taken: the
 * app's boot time, captured at module evaluation, before any probe could possibly have landed.
 * Recovery compares that boot instant against values that ARE server-anchored — a run's start, its
 * heartbeat — to answer "did this run begin before I booted" and "how long has it been unproven".
 * Mixing the two frames makes those answers wrong by exactly the device's error: on a machine a few
 * minutes fast, a beat written seconds ago reads as being in the future, so a perfectly healthy run
 * reads as having no proof of life at all and every boot stops it. Converting the boot instant is
 * the cheap direction — it is one number, and it is the only one in the comparison that is stale.
 */
export const toServerFrame = (deviceMs) => deviceMs + offsetMs;

/**
 * A URL that has NEVER been requested before.
 *
 * The whole measurement hinges on the `Date` header coming from the network right now. A response
 * replayed out of the service worker's precache carries the header from whenever it was STORED —
 * possibly hours stale — which would compute a large negative offset and silently back-date every
 * session this app writes. Workbox matches its precache by exact URL, so a unique query string can
 * never hit an existing entry, and the request is not a navigation, so the SPA navigation fallback
 * does not claim it either. Combined with `cache: 'no-store'` for the HTTP cache, the response is
 * necessarily fresh or absent.
 */
const probeUrl = () => {
    const origin = (typeof window !== 'undefined' && window.location?.origin) || '';
    probeCounter += 1;
    return `${origin}/?_clock=${probeCounter}-${Math.random().toString(36).slice(2)}`;
};

/**
 * One measurement. Returns the candidate offset in ms, or null when nothing trustworthy came back.
 * Never throws: offline, blocked, or header-less all mean "no sample", never "the clock is wrong".
 */
async function sampleOffset() {
    if (typeof fetch !== 'function') return null;
    try {
        const t0 = Date.now();
        // Status is deliberately NOT checked. Even a 404 or a 405 (a host that refuses HEAD) carries
        // a server-generated `Date`, and that header is the only thing being read — demanding
        // response.ok would throw the measurement away over a detail that does not affect it.
        const response = await fetch(probeUrl(), { method: 'HEAD', cache: 'no-store' });
        const t1 = Date.now();
        const headerMs = Date.parse(response?.headers?.get?.('date') || '');
        if (!Number.isFinite(headerMs)) return null;

        const rtt = t1 - t0;
        if (rtt > MAX_SAMPLE_RTT_MS) return null;

        // The header is truncated to whole seconds, so the true server instant lies uniformly in
        // [headerMs, headerMs + 1000) — take its midpoint. Pair it with the midpoint of the round
        // trip, which is the client instant that same response is closest to.
        return (headerMs + 500) - (t0 + rtt / 2);
    } catch {
        return null;
    }
}

/**
 * Fold a candidate into the live anchor.
 *
 * Two separate guards, and they answer different questions. The first is "is this device wrong at
 * all" — inside the trust band we snap to exactly zero rather than carrying a fraction of a second
 * around. The second is "is this news" — an anchor that moved by less than the band is measurement
 * noise, and re-seating it would make serverNowMs() step backwards, which is the one thing that can
 * turn a real interval into a negative one. So the anchor only moves when the device's error
 * genuinely changed (including back to zero, when someone fixes the clock).
 */
function applySample(candidate) {
    const next = Math.abs(candidate) < CLOCK_TRUST_BAND_MS ? 0 : candidate;
    lastSyncedAt = Date.now();
    if (Math.abs(next - offsetMs) < CLOCK_TRUST_BAND_MS) return offsetMs;
    offsetMs = next;
    return offsetMs;
}

/**
 * Measure the device's error against the server and re-anchor. Concurrent calls share one probe.
 * Resolves with the offset in force afterwards, so a caller can log or surface it.
 */
export function syncServerClock() {
    if (inFlight) return inFlight;
    inFlight = sampleOffset()
        .then((candidate) => (candidate === null ? offsetMs : applySample(candidate)))
        .finally(() => { inFlight = null; });
    return inFlight;
}

// How long a boot-time caller may wait for the very first probe before giving up and stamping with
// the device clock anyway. Generous next to a same-origin HEAD (tens of ms in practice) yet far
// below any interval a human would notice as the app "hanging" on open. Timing out is not a
// failure mode: it lands us exactly where this module's callers were before it existed.
const ANCHOR_WAIT_MS = 4000;

/**
 * Resolve once the anchor is known — or once waiting for it stops being worth it.
 *
 * WHY BOOT CODE MUST AWAIT THIS. `installServerClockSync` is fire-and-forget by design, so for the
 * first moments of a session `serverNowISO()` silently returns the DEVICE clock. Nothing a human
 * does lands in that window — a tap is seconds away — but orphan recovery runs *at boot*, and it is
 * the one path that stamps a session's endTime without anyone asking it to. On a machine whose
 * clock runs fast, that stamp lands past the rules' 2-minute future bound, the whole atomic
 * transition is denied, and the run stays canonically active: the worker's timer neither stops nor
 * can be restarted, on that device, until someone fixes the clock. Awaiting the anchor first costs
 * one already-in-flight round trip and removes the entire class.
 *
 * Concurrent callers share the boot probe (`syncServerClock` dedupes), so this issues no extra
 * request. Resolves with the offset in force, for logging.
 */
export function awaitServerClock(timeoutMs = ANCHOR_WAIT_MS) {
    if (lastSyncedAt > 0) return Promise.resolve(offsetMs);
    return Promise.race([
        syncServerClock(),
        new Promise((resolve) => { setTimeout(() => resolve(offsetMs), timeoutMs); }),
    ]);
}

/**
 * Wire the anchor to the moments it can actually change: app start, regaining connectivity (the
 * first chance an offline device gets to ask), and returning to a tab that has been away long
 * enough for the machine to have slept. Idempotent.
 */
export function installServerClockSync() {
    if (typeof window === 'undefined' || installed) return;
    installed = true;

    syncServerClock();
    window.addEventListener('online', () => { syncServerClock(); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (Date.now() - lastSyncedAt < RESYNC_AFTER_MS) return;
        syncServerClock();
    });
}

/** Test seam — drops the anchor and the install latch so each case starts from a known clock. */
export function __resetServerClockForTests() {
    offsetMs = 0;
    lastSyncedAt = 0;
    inFlight = null;
    installed = false;
    probeCounter = 0;
}
