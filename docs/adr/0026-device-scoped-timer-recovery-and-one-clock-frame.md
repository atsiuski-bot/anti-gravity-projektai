# ADR 0026 — Crash recovery is scoped to the device, and every timer instant lives in one clock frame

Status: Accepted · Date: 2026-08-04

## Context

A worker (zivile@) reported: *"the Gildija timer doesn't work again. When I sign in, it stops. And it
won't start again, because I signed in on the PC."* Their PC's system clock was visibly wrong.

Three independent defects produce exactly that sentence. All three were reachable in production; the
first two are ordinary bugs, the third is a design gap.

**1. The heartbeat lived in a different clock frame from the run it describes.** A run's `startedAt`
and `endTime` are stamped in the SERVER's frame (`serverNowISO`, ADR 0021 / `serverClock.js`). The
per-minute heartbeat — the sole proof a run is alive — was stamped with the raw device clock. On a
correct machine the two agree, so the mismatch was invisible. On a machine running a few minutes
fast, a beat written one second ago reads as being in the FUTURE relative to the server-anchored
"now", so `hasUsableHeartbeat` is false, the unproven tail is infinite, and recovery concludes the
run has no proof of life at all. Every boot then stops a perfectly healthy timer. The same mismatch
existed between the run's start and the app's boot instant (`APP_LOAD_TIME`, a raw `Date.now()`),
which recovery compares against server-anchored values to ask "is this run pre-boot".

**2. Boot recovery stamped before the clock anchor had landed.** `installServerClockSync()` is
fire-and-forget by design, so for the first moments of a session `serverNowISO()` still returns the
device clock. Nothing a human triggers lands in that window — a tap is seconds away — but orphan
recovery runs *at boot*, and it is the one path that writes a session `endTime` with nobody waiting
on it. On a fast clock that stamp exceeds the rules' 2-minute future bound
(`endTimeNotInServerFuture`); because a transition commits as one atomic batch, the denial takes the
whole transition with it and the run stays canonically **active** — not stoppable, and not
restartable, on that device.

**3. A second device could not tell another device's LIVE run from its own crashed one.** The only
ownership identity was `APP_INSTANCE_ID`, regenerated on every boot by design (it answers "is the
context that anchored this run still alive", which is what makes the heartbeat trustworthy — see
`appInstance.js`). Recovery therefore fell back to a temporal proxy: "did this run start before I
booted". A timer running on a phone is, from a PC signing in later, ALWAYS pre-boot. And because the
heartbeat only ticks in the foreground, a pocketed phone always looks dead. So signing in on a PC
reliably stopped the timer running on the phone.

## Alternatives considered

- **Widen the rules' 2-minute skew tolerance.** Rejected for the reason already recorded in
  `serverClock.js`: it only moves the cliff. A clock is trusted or it is not, and "trusted within N
  minutes" still refuses the worker whose machine is N+1 minutes off.
- **Let the second device TAKE OVER the run and keep it running.** Smaller diff, and it preserves the
  worker's time. Rejected because it re-opens the runaway the 16h ceiling exists to bound: a timer
  genuinely forgotten overnight would also continue. Bounding it by "is this gap plausibly one work
  stretch" reintroduces a heuristic where an identity now gives a fact.
- **Add a new `timerOwnerDevice` field.** Rejected in favour of composing the device segment into the
  existing `timerOwnerInstance` value: no document grows a key, and `firestore.rules` — which never
  reference this field — need not be touched or redeployed.
- **Do nothing beyond the clock fixes.** Rejected: it leaves the reported stop reachable whenever the
  worker's phone has been quiet for more than the 3-minute continue window, which pocketed-phone
  field work makes routine.

## Decision

**One clock frame.** Both heartbeats (`timerLastHeartbeat`, `activeSessionLastHeartbeat`) are stamped
with `serverNowISO()`, like the boundaries they are compared against. The app's boot instant — the
one value that cannot be server-anchored when taken, since module evaluation predates any probe — is
converted at every comparison via `toServerFrame` / `appLoadTimeServer()`.

**Recovery waits for the anchor.** A new `awaitServerClock()` gates all four boot-recovery paths. It
joins the in-flight boot probe rather than issuing its own, and times out (4 s) rather than hanging —
timing out lands exactly where callers were before it existed.

**Ownership is two-layered.** `APP_INSTANCE_ID` becomes `{deviceId}::{bootId}`, where `deviceId`
persists in `localStorage`. Heartbeat ownership still matches the WHOLE string, so a second tab on
the same device remains a bystander and cannot overwrite a dying device's final beat. Crash recovery
matches only the DEVICE segment (`isOwnedByThisDevice`): a device recovers runs it anchored in any
earlier boot, and never reaches across to another device's run.

An UNSTAMPED run, or a device where `localStorage` is unavailable, answers "not mine". That is the
conservative direction: the failure it declines to risk is stopping a timer someone is actively
running.

## Consequences

- The reported incident is closed on all three of its causes.
- Runs genuinely abandoned on a device that never returns are no longer closed by the worker's OTHER
  device. That responsibility now sits solely with the server net (`autoStopForgottenTimers`,
  `autoCloseForgottenSessions`), which is where it belonged — it is the only actor that can see a
  device is gone. Practically this means such a run is closed on the server's schedule rather than at
  the next sign-in elsewhere.
- Runs already running at release carry no device segment, so they will not be client-recovered.
  They are closed by the server net, and any legitimate continuation re-anchors them under the
  current device, after which recovery works normally. Exposure is one work cycle.
- No `firestore.rules` change and therefore **no deploy** beyond the normal app release.
- Secondary sessions (break / call / quick-work) were deliberately left out of the device gate: their
  abandonment test is "crossed a Vilnius day or exceeded 16h", not heartbeat staleness, so a second
  device never stops a merely-quiet one.

## Follow-ups

- Consider surfacing "this timer is running on another device" in the UI, so the second device shows
  why it is not offering a start rather than simply refusing.
- `TimerSyncNotice` copy still predates the wider engine rollout (open item from the 2026-07-26
  time-continuity audit) and is worth revisiting alongside the above.
