# ADR 0027 — A running timer means work until the worker stops it

Status: Accepted · Date: 2026-08-05

## Context

The same worker as ADR 0026 (zivile@), now on iPhone:

> *"I open the app, start work, the time runs. I do something, after a while I open the app again —
> say to look something up — and from that second opening the time is stopped. I always have to press
> for it to start counting again."*

That is not the ADR 0026 defect. There the worker's **other** device stopped the run, and the fix was
an identity: recovery now acts only on runs anchored by THIS physical device
(`isOwnedByThisDevice`, `{deviceId}::{bootId}`). Here there is only one device, the run is genuinely
its own, and recovery is doing exactly what it was written to do.

**The mechanism.** Three facts compose into a stop on every app re-open:

1. **The heartbeat only ticks in the foreground.** It is a `setInterval` in the page; a backgrounded
   or suspended context does not run it. That is by design and is already relied upon elsewhere —
   "a pocketed phone always looks dead" is stated outright in `appInstance.js`.
2. **iOS discards a backgrounded PWA within minutes.** Returning to it is therefore a **cold boot**:
   a new JS context, a new `APP_LOAD_TIME`, and boot recovery runs. The persisted `deviceId` (ADR
   0026) makes the run recognisably this device's, so recovery does not stand down.
3. **The continue window is three minutes** (`TIMER_HEARTBEAT_CONTINUE_MS`) — calibrated for a
   *reload*, i.e. three missed beats. Any real absence exceeds it.

So the last beat is always stale, every re-open is classified "the app was genuinely closed", and the
timer is stopped. The worker restarts it by hand — every time.

**The deeper problem is that the app was answering a question it cannot answer.** A quiet heartbeat
means one of two things — "pocketed but still working" or "stopped working" — and nothing in the data
distinguishes them. `functions/index.js` already says this outright about the server nets. The client
was nonetheless guessing, and guessing "stopped" on a platform where the quiet beat is the norm.

It is also a lost-time hole, not merely toil. Nothing announces the stop, so a worker who does not
notice keeps working against a stopped timer — the shape of the Simona-class loss.

The same unanswerable question had a second consumer: a scheduled net (`notifyStaleRunningTimers`)
that pushed *"Ar laikmatis vis dar veikia?"* to the worker after 25 minutes of heartbeat silence. It
asked the worker precisely because the server could not decide. Founder direction (2026-08-05): stop
asking — a running timer means work until the worker stops it.

## Alternatives considered

- **Raise `TIMER_HEARTBEAT_CONTINUE_MS`** (e.g. to 30 minutes). Smallest possible diff, but it only
  moves the cliff — the reported 40-minute absence would still stop — and it silently widens what
  gets credited as ONE proven row, since that branch credits straight through to the reload instant
  with no gap row and no opt-out banner.
- **Beat from the background** (Service Worker, Web Periodic Background Sync). Rejected: iOS supports
  neither for this purpose, so it would fix every platform except the one that reported the bug.
- **Continue only when the absence was auto-credited** (built first, then withdrawn). It made
  continuation follow the credit decision, so a ≤4h same-day absence kept the timer and anything
  longer stopped it. Coherent, but it still lets the app decide on the worker's behalf — and it
  decides *against* them exactly when they have been away longest, which is when a wrongly-stopped
  timer costs the most. It also kept the 25-minute nudge meaningful, i.e. kept asking the question.
- **Keep the nudge, drop only the stop.** Rejected on the same grounds: a push that asks "are you
  still working?" is the manual press wearing a different hat.
- **Also remove the crediting bounds** (the 4h cap, the work-day boundary, the nightly 16h net), so
  "worked until stopped" governs pay as well. Rejected by the founder: it restores the 2026-07-27
  production case where a timer left running overnight credited 623 minutes of sleep, and it undoes
  ADR 0025 (accepted 2026-07-30), where a >4h gap became a manager's decision rather than an
  automatic payment.

## Decision

**Recovery never leaves the timer stopped, and the app never asks whether the worker is still
working.** A running timer means work until the worker stops it.

Concretely:

- `planTaskRecover` (canonical) and `recoverConfirmedOrphan` (legacy) always close the old run — which
  is what files the ledger row — and immediately anchor a fresh one from the recovery instant. The
  "brief interruption" special case disappears as a *branch*; it survives only as a credit boundary.
- `decideOrphanTaskRecovery`'s `pause-now` and `resume` modes collapse into one: with no usable
  heartbeat there is nothing to split on, so the stretch is credited whole and the run continues —
  the same outcome, hence the same mode. A mode named "pause-now" that no longer pauses would be a
  name that lies.
- The scheduled `notifyStaleRunningTimers` net, its `TIMER_STALE_NUDGE_MS` knob and
  `shouldNudgeStaleTimer` predicate are **deleted**. Its `timer_running_check` notification type is
  *retired, not removed*: no producer remains, but the registry entry and the server copy stay so
  notifications already sitting in workers' bell history keep rendering, and so the client↔server
  mirror lockstep test stays honest.
- `notifyOverEstimateTimers` **stays**. It states a fact about a specific run — this one passed its
  plan — rather than asking a question the app now answers by policy.

**Continuing is not paying, and the crediting rules are untouched.** Only an absence
`isCreditableUntrackedGap` admits (≥1 min, ≤ `MAX_UNTRACKED_GAP_MINUTES` 4h, not crossing the 05:00
Vilnius work-day boundary) is auto-credited, with its one-tap "Nedirbau" opt-out. Anything longer
becomes `refusedGap` → the manager's decision (ADR 0025). The whole recovered run stays under one
16h budget (R-03), and the nightly `autoStopForgottenTimers` still closes a run nobody ever returns
to. A forgotten timer therefore cannot pay itself; it only stays visibly running, where the worker
can see it.

`silentGap` — which swallows the credited-gap banner — is now bound to the **offline restart** alone
(a confirm landing well after boot proves this app was open and showing the run the whole time). On
an ordinary cold re-open the worker was away, so the banner must appear: those minutes are opt-out
pay and it is their only way to refuse them.

## Consequences

- **The reported bug is gone**, and with it every silent stop: the timer the worker started keeps
  running across app re-opens, evictions, reloads and offline stretches.
- **A worker who stops working without stopping the timer now keeps a running timer.** That is the
  accepted cost of not guessing. It is bounded by what the app will PAY (above), by the 100%-of-plan
  forced decision, by the over-the-plan push, by the 16h clamp and by the nightly server net — and,
  unlike before, they can see it running the moment they open the app.
- **Deleting a scheduled function requires a `functions` deploy to take effect.** Until that runs,
  `notifyStaleRunningTimers` keeps firing in production from the currently deployed code; merging
  alone does not stop it. This is the human-only step (see CLAUDE.md): deploy from an up-to-date
  `main` checkout after the merge, and confirm via `functions_list_functions` that the function is
  gone — the deploy log alone is not proof.
- **No rules change.** `firestore.rules` are untouched. The one new shape — a recovered-gap ledger
  row (`isManualSession` + `isRecoveredGap`) written in the same batch that leaves the session ACTIVE
  — is covered by an emulator test and accepted by the live ruleset as written.

## Follow-ups

1. The credited-gap banner now appears on ordinary re-opens rather than only after a crash. Its
   frequency is unchanged (the credit already happened on every such re-open); if it reads as noisy,
   raise the minimum gap it announces rather than silencing it.
2. `TimerSyncNotice` copy still predates the fleet-wide engine rollout (open since ADR 0026).
3. Secondary sessions (break / call / quick-work) are deliberately untouched — their abandonment test
   is day-crossing/16h, not beat staleness. Revisit whether the same principle should govern them.
4. Once the retired `timer_running_check` notifications have aged out of workers' bell history,
   delete the registry entry, the server copy case and the category mapping.
