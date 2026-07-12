# ADR 0021 — Server-authoritative timer/session write path (audit R-04 + R-12)

- **Date:** 2026-07-12
- **Status:** Accepted — **Option A** (founder decision, 2026-07-12): rules-level R-12 binding now;
  R-04 + R-06-create formally deferred as accepted risks. See §Decision.
- **Relates to:** [ADR 0020](0020-reliable-offline-session-engine.md) (revisioned offline engine),
  [ADR 0009](0009-*.md) (task totals are projections), audit 2026-07-10 findings **R-04**, **R-12**,
  and the create-time half of **R-06**.
- **Author:** claude-opus-4-8 (handoff `.handoffs/audit-2026-07-10-R12-R04-server-authoritative-timer.md`)

## Context

Two deferred findings from the 2026-07-10 sweep share one root cause: **the client is trusted to
write canonical timer/session state directly.**

- **R-12 — atomicity is convention, not enforced.** Every timer transition
  ([`timerTransitionPlan.js`](../../src/utils/timerTransitionPlan.js)) emits one bundle of writes —
  `active_sessions/{uid}` (revision bump), the `timer_commands` marker, the `users/{uid}` projection,
  `tasks/{id}`, and a deterministic-id `work_sessions`/`break_sessions` ledger row — committed in one
  client `writeBatch` ([`timerTransitionExecutor.js`](../../src/utils/timerTransitionExecutor.js)).
  ADR-0020 invariant #6 requires these to commit together, but the rule clauses governing each doc are
  **independent**: none asserts the siblings. A custom or buggy client can advance the revision and
  omit the ledger row; every individual rule still passes. The revision guard then gives false
  confidence while credited time silently diverges from canonical session state.

- **R-04 — workers can mint unlimited canonical `work_sessions`.** The `work_sessions` create rule
  ([`firestore.rules` ~L382](../../firestore.rules)) admits any owner-stamped, shape-valid,
  duration-in-range row. Nothing ties a new ledger row to a real, just-closed run. A worker can POST
  arbitrarily many valid-shaped rows — inflating pay, reports, and badges — with a **client-chosen
  `durationMinutes`, `startTime`/`endTime`, and (for some paths) document id.**

- **R-06-create** — the `tasks` create rule intentionally permits a worker to self-create a task
  already `confirmed` (the call/quick-work auto-log flow depends on it). The same create-vs-update
  trust gap: a worker can mint self-confirmed "approved work."

These are two *different* security properties, and conflating them is the trap the earlier deferral
avoided:

| Finding | Property at stake | What closes it |
|---|---|---|
| R-12 | **Atomicity** — a revision bump co-occurs with its ledger row | Rules can enforce co-occurrence (proven below) |
| R-04 | **Authorship/correctness** — credited minutes reflect real elapsed time | Only a trusted server producer can author the number |
| R-06-create | Create-time authorship of "approved" status | Same trusted producer as R-04 |

## Empirical findings from this session

### 1. The R-12 atomicity binding is viable at the rules level — and the eval budget is NOT a problem

A `getAfter` binding was added to the `active_sessions` **update** rule and exercised in the Firestore
emulator against a modified copy of the live ruleset (spike scripts in scratchpad; **no repo files
changed**). The binding: *if the pre-image is a task run being closed, the deterministic ledger row
`work_sessions/sess_run_{runId}` must exist in the same batch and carry the matching `runId`.*

Definitive spike (correctly instrumented — raw `batch.commit()`, allow/deny observed directly):

| Case | Result | Meaning |
|---|---|---|
| worker close **+ correct ledger** | ALLOW | legit bundle passes |
| worker close, **no ledger** (R-12 exploit) | **DENY** | atomicity enforced |
| worker close + **decoy** ledger (wrong id) | **DENY** | existence-bypass blocked |
| worker close + right id, **wrong `runId` body** | **DENY** | content checked, not just existence |
| **in-scope mgr** force-idle + ledger (budget stack) | ALLOW | binding survives stacked on `overseesUser()` get + cross-collection create |
| in-scope mgr force-idle, no ledger | **DENY** | atomicity holds on the manager path too |
| **out-of-scope** mgr force-idle + ledger | **DENY** | R-08 scope still holds |

Key results: (a) computed path segments — `$('sess_run_' + resource.data.run.runId)` — work;
(b) `existsAfter`/`getAfter` correctly see a `set(..., {merge:true})` sibling; (c) **the binding does
not trip the per-request evaluation budget**, even combined with the existing `overseesUser()` document
read and the sibling `work_sessions` create rule. This matches the `firestore.rules` L88-97 note: the
budget ceiling that blocked the `users`-update rule comes from *that rule's ~10 field pins*, not from
`getAfter` per se — and `active_sessions` is lean, so it has ample headroom.

### 2. The clean binding covers the TASK close path only

`closeTaskWrites` emits the `sess_run_{runId}` ledger **unconditionally** (even sub-minute), so the
"task run closed ⇒ ledger exists" implication is total and rule-checkable. The other closes are not
cleanly bindable:

- **break end** and **quick-work end** write their ledger only when `durationMinutes >
  MIN_LOGGED_SESSION_MINUTES`. A legitimate sub-threshold close writes *no* ledger, so a rule cannot
  require one — "revision advanced, ledger omitted" is indistinguishable from a legit short session.
- **call end**, **quick-work end**, and **recovery** derive their ledger id from `Date.parse(startedAt)`
  (`sess_call_ws_{uid}_{startMs}`, `sess_qw_ws_{uid}_{startMs}`) or emit two rows
  (`sess_run_` + `sess_gap_run_`). Rules cannot parse an ISO string to epoch-ms, so the rule cannot
  reconstruct the id; binding would require the client to write the expected id as a field — which the
  client also authors, degrading the guarantee to client-declared co-occurrence.

So a rules-level binding hardens the dominant, highest-value path (actual task work time) and leaves
break/call/quick/recovery convention-enforced.

### 3. The R-04 surface is 7 intents — and ADR-0020's own migration is already shrinking it

A full client trace found **8 standalone `work_sessions`-create sites collapsing to 7 distinct intents**
(the handoff's "5" undercounted):

| # | Intent | Site | Id shape | Owner | Provenance | Retired by ADR-0020? |
|---|---|---|---|---|---|---|
| a | task-timer run segment (legacy pause/finish) | `taskActions.js:228`, `TaskTimerControls.jsx:611` | `sess_task_{taskId}_{startMs}` | assignee | none | **yes** (engine batch) |
| b | call end log (legacy) | `sessionActions.js:642` | `sess_call_ws_{uid}_{startMs}` | self | `isSystemTask` | **yes** (planSecondaryEnd) |
| c | quick-work end log (legacy) | `sessionActions.js:729` | `sess_qw_ws_{uid}_{startMs}` | self | `isQuickWork` | **yes** (planSecondaryEnd) |
| d | interrupted secondary partial | `sessionActions.js:109` | auto-id | self | `isPartial` | **likely** (engine) |
| e | recovered-gap self-service claim | `sessionEditActions.js:399` | `sess_gap_{taskId}_{startMs}` | self | `isRecoveredGap` | no — survives |
| f | worker self-backdate | `sessionEditActions.js:328` | auto-id | self | `isBackdated`, `canBackdateTime`-gated | no — survives |
| g | manager manual-create for a worker | `sessionEditActions.js:252` | auto-id | **target worker** | `createdByAdmin` | no — survives |

Six are worker self-logging (`userId` = actor); only **(g)** is a manager acting for another user.
Crucially, **intents (a)-(d) are legacy siblings that ADR-0020 steps 4-6 fold into the engine batch or
retire.** Building a server-authoritative producer for all 7 now would migrate paths that are about to
be deleted. After the ADR-0020 migration, the durable standalone surface is just **(e) gap-claim,
(f) backdate, (g) manager-manual** — three intents, all low-volume and already gated (window checks,
`canBackdateTime`, manager role).

## The crux: this collides with ADR-0020 (offline-first)

ADR-0020 (Accepted, 2026-07-09, mid-rollout) **explicitly rejected the Cloud Function processor as the
sole write path**: *"it cannot acknowledge an offline action until reconnect and adds
deployment/runtime coupling. The local outbox plus rules-enforced atomic batch provides offline issue
semantics without making a function the only write path."* Its §3 makes **security rules the
concurrency boundary**, precisely so an offline worker can start a task and immediately stop it with no
round trip.

Consequences for our two options:

- A **callable** processor is dead on arrival for the worker timer path — it breaks offline start→stop.
- A **Firestore-trigger** intent processor is the only server-authoritative shape compatible with
  offline *issue*: the client writes an intent doc offline (already modelled by the ADR-0020 outbox),
  the UI projects from queued commands, and on reconnect the trigger authors the canonical writes in one
  Admin transaction. But this **moves ledger authorship from the client batch to the server**, defers
  canonical confirmation to reconnect + trigger execution (seconds of latency even when online), makes
  the trigger transaction — not rules — the concurrency boundary, and must absorb at-least-once,
  unordered trigger delivery on the paid-time-critical path. That is a **material amendment to a 3-day-old
  mid-rollout ADR**, validated only by emulator + functions-emulator oracles (no browser QA on this app).

## Alternatives (the A-vs-B decision)

### Option A — rules-level atomicity binding now; R-04 deferred with compensating controls

- Add the proven `getAfter` binding to the `active_sessions` update rule, closing **R-12 for the task
  close path** (revision bump ⇒ matching ledger). Emulator-provable; one rules change; **zero client
  change, zero offline-model change, no ADR-0020 conflict.**
- **R-04 stays open** (credited-time authorship is still client-side) but is bounded by existing
  compensating controls: `durationInRange` clamp, the 16 h/`MAX_BACKDATE_DAYS` clamps,
  `dailyIntegrityScan` (duplicate/overlap/orphan detection), `isTest`/quick-work report exclusions, and
  manager pay review. R-06-create likewise stays open, mitigated by `isSystemTask`/`isQuickWork` flags.
- Honest limit: the binding gives **atomicity, not correctness** — it proves a ledger row co-occurred
  with the revision bump, not that `durationMinutes` equals real elapsed time.

### Option B — server-authoritative trigger processor now (closes R-04 + R-12 + R-06-create)

- A Firestore-trigger processor becomes the **sole producer** of canonical `work_sessions` +
  `active_sessions`; rules forbid direct client writes; all 7 intents are re-expressed as
  server-validated intents; ADR-0020 §3's concurrency boundary is amended from rules-CAS to the trigger
  transaction.
- Closes R-04 (server authors credited time), R-12 (server writes the whole bundle atomically), and
  R-06-create (server authors `confirmed`).
- Cost: a multi-week rewrite of the most safety-critical path, dents offline confirmation latency,
  introduces trigger cold-start/ordering reliability on paid time, amends a mid-rollout ADR, and — worst
  for this repo — is validated with the **weakest QA available** (emulator + functions emulator only, no
  browser, solo non-programmer founder who "cannot audit a large or speculative diff").
- Sequencing hazard: doing this before ADR-0020's migration completes means migrating intents (a)-(d)
  that ADR-0020 is about to delete.

## Decision — Option A (founder-confirmed 2026-07-12)

**Option A: ship the rules-level R-12 binding now; scope Option B as a future, post-ADR-0020-migration
project.** R-04 and R-06-create are **formally accepted, deferred risks** with the compensating controls
named below. Rationale:

1. **R-12 is cheaply and provably closeable today** at the rules level for the dominant task path; the
   budget objection is empirically disproven. This is the "smallest viable change" that converts
   ADR-0020 invariant #6 from convention to rule-enforced for real task time.
2. **R-04 cannot be closed without partially walking back ADR-0020's offline design.** Whether to pay
   that price is a genuine security-risk trade-off that is the founder's to own. Given the constraints
   (offline-first is a core product promise for field workers; QA is emulator-only), accept-with-controls
   is the responsible near-term posture.
3. **The R-04 surface is self-shrinking.** Finishing ADR-0020's migration first drops the durable
   standalone surface from 7 intents to 3 (gap-claim, backdate, manager-manual). A trigger processor —
   or even a tighter rules binding — for *three low-volume, already-gated* intents is far more tractable
   and safer than one for seven, four of which are being deleted.

**Therefore the sequence is:** ship A (rules binding + oracle) → let ADR-0020 migration retire intents
(a)-(d) → re-evaluate the residual 3-intent R-04 surface against a trigger processor as a *scoped*
follow-up ADR. R-04 and R-06-create remain **explicitly accepted risks** in the interim, with the
compensating controls above named as the mitigation.

## Emulator oracle matrix (the QA gate — the only security-boundary proof on this app)

For Option A (to add to `securityRules.integration.test.js`, run via `npm run test:firestore`):

- **R-12 fail:** worker advances `active_sessions` revision closing a task run **without** the
  `sess_run_{runId}` ledger in the batch → **DENIED**.
- **R-12 fail (bypass):** same, with a decoy ledger at a different id, and with the right id but a
  mismatched `runId` body → **DENIED**.
- **R-12 legit:** the full task-close bundle (revision bump + matching ledger) → **SUCCEEDS**.
- **R-12 legit (manager):** in-scope force-end with ledger → **SUCCEEDS**; out-of-scope → **DENIED**
  (R-08 regression guard).
- **Non-task closes unaffected:** a break/call/quick close (no `sess_run_` ledger) still **SUCCEEDS**
  (the binding is conditioned on `run.type == 'task'`).

If/when Option B is taken, the matrix extends to: a worker directly creating any `work_sessions` row is
**DENIED**; each of the 3 residual intents submitted as an intent is **validated and produced by the
trigger**; a partial transition is impossible (single Admin transaction); replay is idempotent
(deterministic ledger id).

## Consequences

- **A (recommended):** R-12 task-atomicity becomes rule-enforced; the offline engine and ADR-0020 are
  untouched; R-04/R-06-create remain accepted risks with named compensating controls; break/call/quick
  atomicity stays convention-enforced until the ADR-0020 migration folds them into the (binding-covered)
  engine batch. One human rules deploy, post-ship, re-verified live via Firebase MCP.
- **B (deferred):** would remove client trust entirely but at a cost and QA risk disproportionate to a
  solo non-programmer app mid-way through a related engine migration; revisit when the surface is 3
  intents, not 7.

## Follow-ups

1. Implement Option A: the `active_sessions` update binding + the R-12 oracle set above. (Rules change →
   human deploy from up-to-date `main`, per `workz-deploy-post-ship-only`.)
2. Track R-04 + R-06-create as explicitly-accepted deferred risks in `docs/decisions-log.md`, with the
   compensating controls named.
3. After ADR-0020 steps 4-6 land, open a scoped follow-up ADR for the residual 3-intent server producer.
4. Verify the compensating controls actually fire on standalone sessions: confirm `dailyIntegrityScan`
   flags duplicate/overlapping/orphan `work_sessions` from intents (e)-(g).
