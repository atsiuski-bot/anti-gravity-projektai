# ADR 0025 — A refused work gap becomes a manager decision, not a vanishing offer

- **Status:** Accepted and implemented 2026-07-30 (founder decision: *all* of the worker's team
  managers settle it). **Implemented more simply than designed — see "Implementation note" below;
  the simplification removes the rules change entirely, so no rules deploy is required.**
- **Date:** 2026-07-30
- **Supersedes / builds on:** [0020](./0020-reliable-offline-session-engine.md),
  [0021](./0021-server-authoritative-timer-session-write-path.md),
  [0023](./0023-worker-self-service-time-reduction.md)

## Context

When a task timer's heartbeat dies (pocketed phone, no signal) and the app is reopened much
later, recovery credits the heartbeat-**proven** stretch and then has to decide what to do with
the unproven tail — the *untracked gap*.

That decision is `isCreditableUntrackedGap` ([src/utils/timeUtils.js:515](../../src/utils/timeUtils.js)).
A gap is auto-credited only when it is ≥1 min, within one Vilnius work day, and **≤4 h**
(`MAX_UNTRACKED_GAP_MINUTES`). The 4 h ceiling is well-chosen and must stay: of 78 auto-credited
gaps ever written the median is 27 min and the second-largest is 3.6 h, and the previous 16 h
bound once paid 623 minutes for a night's sleep (production, 2026-07-27).

The problem is not the refusal. It is **where the refusal goes.**

A refused gap falls back to an opt-in claim offer that is written to
`localStorage` ([src/utils/recoveryNotice.js:8-12](../../src/utils/recoveryNotice.js)) —
deliberately *not* synced to Firestore, shown **once**, on **one device**, to the **worker
only**. If they do not tap "Užskaityti", the worked time is gone. Nobody is told. Nothing is
owed to anyone. The server does leave a durable trace
(`orphanRecovery:gapNotAutoCredited` in `error_logs`), but that trace is routed to no one.

So the system knows time was lost and says so only to the one person who benefits from claiming
it, in the least durable place it has.

**Observed instance.** Povilas Bielskis, 2026-07-29, task `7Qjc6ztecSvR067s2QXC`: recovery
credited to the 15:43 heartbeat; the real end was 19:34; the gap 15:43 → 00:04 was 8 h 21 min,
so above the 4 h ceiling and refused. The task was confirmed one second after the offer
appeared. 3 h 51 min of real work was forfeited and was only found because the worker complained
in a chat message the next day. (Restored manually on 2026-07-30.)

**This is not fixed by the canonical/atomic engine.** `planTaskRecover` calls the same
`isCreditableUntrackedGap` ([src/utils/timerTransitionPlan.js:1655](../../src/utils/timerTransitionPlan.js))
— by design, so both engines credit the same physical event identically. The atomic engine did
close a *different* defect (the task counter drifting from the ledger) on the auto-credit path,
because it writes the ledger rows and `timerMinutes` in one batch. The manual claim fallback
still runs the legacy two-write path.

## Decision

**A gap that the system refuses to auto-credit becomes a pending decision assigned to a manager.
Worked time may be refused, but it may not silently disappear.**

The direction of authority follows the principle already established in ADR 0023: *shortening*
own time needs no approval, *lengthening* it pays the person asking, so it needs one. Below 4 h
the system trusts the worker's opt-out (auto-credit + "Nedirbau"). Above 4 h that trust is not
available — the interval is too easily a forgotten timer — so the worker may **state** the
claim and a manager must **grant** it.

### 1. The refused gap becomes a durable record

New collection **`time_gap_claims`**, one document per refused gap, id
`gap_{taskId}_{gapFromMs}` — the same deterministic-id idempotency `sess_gap_` already uses, so
two devices recovering the same run converge on one claim instead of two.

| field | purpose |
|---|---|
| `userId`, `userName` | the worker the time belongs to (always the assignee) |
| `taskId`, `taskTitle` | what was being worked on |
| `fromIso`, `toIso`, `gapMinutes` | the interval under negotiation |
| `status` | `pending` → `credited` \| `rejected` (one-way) |
| `cause` | why auto-credit declined (`gap-not-one-work-stretch`, `not-own-task`, `auto-credit-write-failed`) |
| `engine` | `legacy` \| `canonical` — so the two paths stay comparable |
| `teamManagerIds` | read scoping, mirroring `work_sessions` |
| `sessionId` | set on credit — the row that settled it |
| `settledBy`, `settledAt`, `decisionReason` | audit |

The **client** writes it, at the same point that today calls `addRecoveryNotice`. This is
correct despite the client being unreliable here: Firestore's offline queue makes the write
durable even in the exact offline condition that produced the gap. (Contrast the delta guard in
`reconcileTaskTimerFromSessions`, which needs a *read* to prove a row is new — a read cannot be
queued, which is why that guard fails closed precisely when it is needed. See Follow-ups.)

The localStorage banner stays as the worker's immediate feedback. It is no longer the only
carrier, so its loss costs nothing.

### 2. The record raises a manager action

A Cloud Function trigger on `time_gap_claims` create fires a new notification type
**`time_gap_claim`** (`category: 'action'`, `sound: 'alert'`, `push: true`, link → tasks) to the
worker's managers via the overseer closure, plus an `info` copy to the worker so they know it
was escalated rather than lost.

Per ADR 0017 this means: one entry in [src/notifications/registry.js](../../src/notifications/registry.js),
one hand-copied mirror in `copyForRequestNotification`, and the existing
`firebaseConsistency.test.js` gate locks the two together.

### 3. The manager settles it in one tap

The bell card shows worker · task · date · interval · duration, and two actions:

- **Užskaityti** — creates the gap session **with the manager's authority**, then reconciles the
  task counter. This closes the second defect as a side effect: a manager's broad by-`taskId`
  sessions read is permitted, so the reconcile takes the wholesale-sum path and cannot land in
  the `partial` fail-closed branch that left Povilas's counter 2 h 12 min short.
- **Atmesti** — sets `status: rejected` + reason. Nothing is credited, and the refusal is now
  *recorded* rather than implied by absence.

Both re-read the claim and re-verify that the named task's assignee matches `userId` before
writing — the same confused-deputy discipline `applyRequestedSessionEnd`
([src/utils/sessionEditActions.js:488-493](../../src/utils/sessionEditActions.js)) already
applies, for the same reason: the claim document was authored by the beneficiary.

### 4. A pending claim cannot rot

A scheduled sweep re-notifies on claims still `pending` after 3 days, mirroring
`notifyStaleRunningTimers`. Unsettled pay is a worse failure than a noisy bell.

## Implementation note (what was actually built, and why it is smaller)

The design above invents a `time_gap_claims` collection to hold the pending decision. Building it
revealed that the codebase **already has that mechanism**: `request_notifications` is a two-way
feed whose `category: 'action'` rows *are* pending decisions, and `session_correction_request`
already uses it for the same shape — a worker-authored ask that a manager settles in one tap from
the bell. A second parallel store would have duplicated it, and it would have needed new rules and
therefore an irreversible rules deploy.

So the claim **rides on the notification** instead. What that changes:

- **No new collection, no rules change, no rules deploy.** Notifications are written client-side
  through the existing `notify()` funnel, whose provenance invariants the current rules already
  enforce; the server only fans out the push.
- **`status` is not stored.** Settled = the notification is cleared, exactly as every other action
  card works. What replaces the `rejected` audit row is a notification *back to the worker*
  (`time_gap_settled`), which is arguably better: the refusal reaches the person who needs it
  rather than sitting in a collection nobody reads.
- **Idempotency comes from the row id, not from a status field.** Both routes write
  `sess_gap_{taskId}_{fromMs}`, so a manager crediting a gap the worker already claimed lands a
  value-identical merge, and a double tap re-derives the same total. This is what makes it safe to
  leave the worker's own offer in place alongside the escalation.
- **Recipients are resolved from the worker's own user doc** (`overseerRecipients`, the same
  precedence `isOverseenBy` uses) rather than from React context, so both recovery hooks keep their
  signatures and an offline boot still resolves them from the persistent cache.
- **The 3-day stale sweep is not built** (it needs a scheduled function); an unsettled claim is an
  unread `action` row, which the bell already floats to the top. Deferred, see Follow-ups.

**Deploy consequence:** the only server-side change is the push COPY mirror. Until `functions` is
deployed, in-app behaviour is fully correct and the OS push still arrives — with the generic
"Gildijos pranešimas" title instead of "Neužfiksuotas darbo laikas". Nothing is lost by deploying
late, so this is a normal post-merge `functions` deploy, not a gate.

Files: `src/utils/gapClaim.js` (new — raise), `src/utils/sessionEditActions.js`
(`creditRefusedGap`), `src/utils/teamScope.js` (`overseerRecipients`), both recovery hooks,
`src/notifications/registry.js` + `functions/index.js` mirror,
`src/components/ManagerNotifications.jsx` (the card).

## Alternatives considered

**A. Trigger the notification off the existing `error_logs` trace.** Smallest possible diff —
no client change at all, and it would work retroactively on the backlog. Rejected as the
*primary* mechanism: it makes a pay obligation depend on a diagnostic channel that is prunable,
unscoped for manager reads, and free-form. Kept as a **one-off retro-scan** to find historical
holes (see Follow-ups).

**B. Raise `MAX_UNTRACKED_GAP_MINUTES`.** Rejected. It adds no decision-maker; it only re-opens
the paid-for-sleeping class the ceiling was introduced to close.

**C. Auto-credit above 4 h and let a manager claw it back.** Rejected. Over-stating pay is worse
than a pending decision, and the codebase consistently prefers fail-closed on this axis.

**D. Keep it worker-only but make the offer durable across devices.** Cheapest real improvement,
and it would have saved Povilas's time. Rejected as insufficient: the only person who ever sees
the loss is the one who profits from claiming it, and a worker who simply does not act still
forfeits real work. Durability without accountability moves the failure, it does not remove it.

## Consequences

- **No worked time is dropped without a named decision.** A loss becomes a visible pending item
  instead of an absence — which is the property that made the Povilas case undiagnosable until he
  complained.
- **Manager workload is small.** Only the >4 h tail escalates; the common 27-minute gap keeps
  auto-crediting silently as today.
- **No rules surface after all** (see the implementation note): the claim rides on
  `request_notifications`, whose create invariants the current rules already enforce, so there is
  **no rules deploy**. The security posture is unchanged from `session_correction_request`: a worker
  can author a claim naming any task, which is why `creditRefusedGap` re-reads the task and refuses
  unless its assignee matches the claim's subject — the manager's authority never writes payable
  time on an unverified pointer.
- **The R-04 posture is unchanged.** A worker could already mint `work_sessions` directly (accepted
  risk, ADR 0021); this adds a *manager-authored* credit path, which is strictly narrower.
- **Two engines, one path.** Because the claim is raised from the shared refusal decision, legacy
  and canonical behave identically — preserving the invariant `planTaskRecover` already documents.
- **`isCreditableUntrackedGap` becomes safe to tighten.** Once refusal has a destination, a
  stricter ceiling costs a manager tap instead of costing a worker their pay.

## Follow-ups

1. **The delta-guard hole is not closed by this ADR.** On the worker's own "Užskaityti" path
   (≤4 h gaps), `claimRecoveredGap` can only pass a counter delta if it can *read* that the row is
   new; offline that read fails, so no delta is passed, `reconcileTaskTimerFromSessions` returns
   `partial`, and the task counter silently diverges from the canonical ledger. This is exactly
   what produced Povilas's 1 h 56 m vs 4 h 08 m mismatch. Needs its own fix.
   **— CLOSED 2026-08-04.** Not by a better client read (there cannot be one: the claim exists
   *because* the device is offline), but by moving the fold to the party that needs no read. The
   `reconcileCounterOnGapClaim` trigger fires when the queued claim finally commits and re-derives
   the task counter **wholesale** from the full ledger. Wholesale, not an increment, is what makes
   it idempotent — safe to retry, safe when the worker's claim and a manager's settlement land on
   the same deterministic id, and safe alongside a stale client bundle still applying its own
   delta. Scoped to client-authored claims only (the atomic engine's own gap row carries
   `engineVersion` and moves the counter inside its batch; two authorities must not fight over one
   number). The client is unchanged: it stays correct when online and merely stops being the *only*
   route. **Requires a `functions` deploy to take effect** — until then the hole is open exactly as
   described above.

   **The retro-scan (follow-up 2) re-framed the defect, and the fix holds under the wider reading.**
   All 18 recorded `reconcile:claimRecoveredGap → partial` events carry `online: true`, so offline
   was never the whole story: *online*, the novelty probe succeeds and answers "not new" — the row
   already exists — so no delta is passed and the counter still does not move. The real class is
   **the first fold failing, after which every later claim of the same gap can add nothing**: a
   one-way ratchet into staleness. Folding at row CREATION removes the inherited state that ratchet
   depends on. Rows created *before* the deploy keep their drift; repairing those is a separate data
   operation.
2. **Retro-scan** `error_logs` for `orphanRecovery:gapNotAutoCredited` and
   `reconcile:*` `partial` outcomes, to size how much historical time and how many stale counters
   are affected across all workers.
   **— DONE 2026-08-04 (read-only, via the Firebase MCP).** `orphanRecovery:gapNotAutoCredited`:
   **exactly one event ever** (2026-07-29, user `ZcfeXc4Q…` — notably *not* Povilas), so a >4 h
   refusal is genuinely rare and the 4 h bound is not over-firing. `reconcile:claimRecoveredGap →
   partial`: **18 events across 4 distinct users, all on 2026-07-28/29, every one `online: true`** —
   the finding that re-framed follow-up 1 above. The nightly `counterDrift` scan had *not* warned
   about any of them, so it is not a reliable second witness for this class. Remaining question,
   deliberately not answered here: how many of those 18 tasks are still drifted today, and whether
   the repair should be a one-off backfill or `dailyIntegrityScan` graduating from reporting drift
   to healing it.
3. **Decide whether the same escalation should cover session (quick-work/call) gaps**, which today
   have their own recovery path.
4. **The 3-day stale-claim sweep** (a scheduled function, mirroring `notifyStaleRunningTimers`) was
   not built. Until it exists, an unsettled claim relies on the bell's action tier for visibility.
5. **Not exercised in a browser.** The gate is green (lint · 1207 unit tests · build · functions
   lint) and the decision logic is unit-tested, but the manager card itself was never rendered
   against a real claim: producing one requires a genuinely orphaned >4h timer, and minting that
   would write to production. Verify via the dev test login when a natural claim appears.
