# ADR 0023 — Worker self-service time reduction is one-way

*Status:* Accepted · *Date:* 2026-07-28

## Context

The commonest honest time-keeping error in the field is a timer left running: a worker finishes at
16:00, pockets the phone, and notices at 18:30 that the task is still counting. Until now the worker
could only **flag** the row ("Pranešti apie klaidą") and wait for a manager to open the day timeline
and fix it with the admin session editor. In the meantime the over-credited time sat in every report
— and in pay.

Editing logged time was admin-only on the assumption that *any* worker-authored change to credited
time is a risk. That assumption conflates two operations with opposite incentives.

## Alternatives

1. **Keep everything manager-gated (status quo).** Safe by construction, but it leaves a wrong
   number standing for as long as it takes a manager to notice, and it makes the honest worker's
   correction the slowest path in the product.
2. **Let workers edit their own sessions freely.** Simple, and — uncomfortably — barely weaker than
   today at the door: the `work_sessions` update rule already grants an owner write access, and the
   create rule already lets any worker mint a session (ADR 0021: every credited number is
   client-authored). But it removes the one place where the direction of a change is visible, and it
   reads as "workers may adjust their own pay", which is not a policy we want to state.
3. **Split by direction (chosen).** Shortening is self-service; lengthening stays a request.

## Decision

**A worker may shorten one of their own logged sessions without approval. They may never lengthen
one.**

The asymmetry is a claim about **incentive**, not about trust:

- **Shortening is self-punishing.** A worker giving back time they were already credited has nothing
  to gain, so an approval gate buys no safety — it only delays a correction everyone wants.
- **Lengthening pays the person asking for it.** That is exactly what approval is for, so an increase
  never travels the self-service path: the same modal turns it into the `session_correction_request`
  the manager already resolves with the editor they have.

Concretely:

- Only the **end** moves. The start stays as the timer recorded it, so a correction can shorten a
  session but never relocate it into another day or over another one.
- **No time limit.** A worker may shorten an already-approved session from any date (founder
  decision, 2026-07-28: flexibility beats a window, since the change can only ever reduce pay).
- The row is stamped `selfAdjusted` plus the shared `edited` / `original*` audit snapshot, so one
  "Koreguota" badge explains admin and worker corrections alike.
- Every admin gets an **informational** `time_self_reduced` notification — same posture as an
  approval-free backdated entry (ADR: trusted backdate). Never an action item; there is nothing to
  decide.

### Enforcement

`firestore.rules` carries the direction as `selfAdjustOkForUpdate()` on `work_sessions` update: when
an incoming write sets `selfAdjusted: true` **and** changes `durationMinutes`, the new value must be
strictly smaller.

It is keyed on the **marker**, not on the caller's role, for two reasons:

1. It judges only the new path. The live timer legitimately **grows** a session's duration on update
   — the interrupted quick-work/call partial row is finalized onto the *same* deterministic doc id
   with a larger value — so a blanket "workers may not increase" rule would break the timer itself.
2. An `updateDoc` is judged on the **merged** result, so a marker left on a row would silently
   constrain every later write to it. The admin editor therefore clears `selfAdjusted` back to
   `false`, keeping the manager the unconstrained authority they have always been.

Applied to `work_sessions` only, not `break_sessions`: break time is an allowance, not payable, so
there is no incentive to inflate it.

## Consequences

- This is a **product gate, not a security boundary** — the same class as `canBackdateTime`. The
  create rule still lets a worker mint a session, so ADR 0021's "every credited number is
  client-authored" is unchanged. What this closes is the *honest-mistake* path being the slow one,
  and what it adds is that the self-service path itself can only ever reduce.
- The task's cached counter is moved by a **negative delta** (a plain worker's by-taskId session read
  is denied, so the owner-scoped sum is provably incomplete). The correction is therefore
  **exactly-once by caller contract** — the modal's `busy` gate is what guarantees it.
- The worker-facing affordance no longer requires an assigned manager: a self-reduction needs nobody,
  so only the *request* half is disabled when there is no one to ask.
- **Deploy:** the rules change and the `functions/` push-copy mirror reach production only when a
  human deploys from an up-to-date `main` checkout **after** this merges (CLAUDE.md post-ship rule).
  Until then the client refuses an increase on its own, and the old push wording stands for the new
  type.

## Follow-ups

- The manager still applies an approved increase by hand in the session editor; the request carries
  the worker's proposed end so it is a transcription, not a conversation. A one-tap "apply" on the
  notification card is the obvious next step.
- The modal itself was not exercised end-to-end in a browser (the dev test account has no logged
  sessions, and minting one would mean writing to production). Verified by unit tests, emulator rules
  tests, and a render of the surface that hosts it.
