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
export const APP_INSTANCE_ID = `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

// Does `ownerInstance` (as stored on a run) belong to THIS app instance?
//
// A run anchored before ownership existed carries no owner. Those must NOT be treated as ours —
// falling back to "beat it anyway" would reinstate the exact bystander bug for every legacy run —
// so callers fall back to the boot-time proxy instead, which is conservative in the safe direction.
export const isOwnedByThisInstance = (ownerInstance, instanceId = APP_INSTANCE_ID) =>
    !!ownerInstance && ownerInstance === instanceId;
