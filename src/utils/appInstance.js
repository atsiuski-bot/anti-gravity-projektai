// Identity of THIS running app instance — one tab / PWA window / JS context, regenerated on every
// boot. Deliberately NOT persisted: a reload must produce a NEW id, because the whole point is to
// tell "the app that anchored this run is still alive" apart from "some app of this worker is open".
//
// Why a running timer needs an owner at all
// -----------------------------------------
// A live timer is only a stored start instant; the per-minute heartbeat (timerLastHeartbeat /
// activeSessionLastHeartbeat) is the sole proof that the worker's app was still alive at a given
// moment, and crash recovery credits time up to that proof. The heartbeat is therefore only as
// trustworthy as the answer to "who is allowed to write it".
//
// The original stand-in for ownership was `timerStartedAt >= APP_LOAD_TIME` — "did this run begin
// after THIS context booted". That is a proxy, and it is wrong in the expensive direction: any
// second context of the same signed-in worker (a laptop tab left open, a browser tab beside the
// installed PWA — src/firebase.js enables multi-tab persistence explicitly) that was already open
// when the run started also satisfies it. It then beats, every 60 s, a run it merely OBSERVES.
// Because the beat is a single flat last-write-wins field, the bystander does not just add a beat:
// it OVERWRITES the dying device's true final beat. A run whose phone died at 09:00 keeps looking
// alive until the worker reopens it, and recovery credits the whole dead stretch as worked — ghost
// minutes that reach work_sessions, timerMinutes and pay, with no banner, while the server's 25-min
// stale-timer nudge stays silent for the same reason.
//
// Anchoring the run to the instance that started it makes the beat mean what every consumer already
// assumes it means. A context that did not anchor the run stays a read-only observer.
//
// Why there is a SECOND, coarser identity underneath it
// -----------------------------------------------------
// Ownership above answers "is the context that anchored this run still alive". Crash recovery needs
// a DIFFERENT question answered: "could this run be mine to recover at all". It used to conflate the
// two and ask only "did this run start before I booted" — which is equally true of a run the SAME
// worker is right now running on another device. A phone timer left running is, from a PC signing in later, always
// pre-boot; and because the heartbeat only ticks while the app is in the foreground, a pocketed
// phone also always looks dead. So opening the app on a PC reliably stopped the timer running on the
// phone (reported: "when I sign in, it stops"). The per-boot id could not tell that apart from an
// ordinary reload, because it is regenerated on every boot BY DESIGN.
//
// So the stamped owner carries both: a DEVICE segment that survives restarts, and a BOOT segment
// that does not. Heartbeat ownership matches the whole string (unchanged — a second tab on the same
// device is still a bystander and must not beat). Recovery matches only the device segment, so a
// device recovers its own abandoned runs and never reaches across to another one. A run genuinely
// abandoned on a device that never comes back is closed by the server net (autoStopForgottenTimers),
// which is where that responsibility belonged all along.
//
// Composed into the EXISTING owner field rather than a new one: no document grows a key, and
// firestore.rules — which never reference this field — need not be touched or redeployed.
const DEVICE_ID_KEY = 'workz.timer.deviceId';

const newDeviceId = () => `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

// Persisted so it survives reloads, PWA restarts and OS evictions — that persistence IS the signal.
// When storage is unavailable or refuses (private windows, blocked site data) we fall back to a
// per-boot value. That device then matches none of its own earlier runs, so it simply never performs
// client-side recovery: it leaves other devices' timers alone and defers to the server net. That is
// the conservative direction — the failure it declines to risk is stopping someone's live timer.
function loadDeviceId() {
    try {
        const stored = globalThis.localStorage?.getItem(DEVICE_ID_KEY);
        if (stored) return stored;
        const minted = newDeviceId();
        globalThis.localStorage?.setItem(DEVICE_ID_KEY, minted);
        return minted;
    } catch {
        return newDeviceId();
    }
}

export const DEVICE_ID = loadDeviceId();

// `{device}::{boot}` — see above. The separator is absent from both segments, so the split is exact.
export const APP_INSTANCE_ID = `${DEVICE_ID}::inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Was this run anchored by THIS PHYSICAL DEVICE (any boot of it)?
 *
 * The test crash recovery must use. An UNSTAMPED run answers false: it predates this scheme, so we
 * cannot prove it is ours, and guessing wrong means stopping a timer someone is actively running —
 * exactly the reported bug. Those runs are still closed by the server's forgotten-timer net, and any
 * legitimate continuation re-anchors them under this device, after which they recover normally.
 */
export const isOwnedByThisDevice = (ownerInstance, deviceId = DEVICE_ID) =>
    typeof ownerInstance === 'string'
    && ownerInstance.split('::')[0] === deviceId;

// Does `ownerInstance` (as stored on a run) belong to THIS app instance?
//
// A run anchored before ownership existed carries no owner. Those must NOT be treated as ours —
// falling back to "beat it anyway" would reinstate the exact bystander bug for every legacy run —
// so callers fall back to the boot-time proxy instead, which is conservative in the safe direction.
export const isOwnedByThisInstance = (ownerInstance, instanceId = APP_INSTANCE_ID) =>
    !!ownerInstance && ownerInstance === instanceId;
