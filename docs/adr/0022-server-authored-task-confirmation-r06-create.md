# ADR 0022 — Server-authored task confirmation (audit R-06-create / roadmap P-R06)

- **Date:** 2026-07-13
- **Status:** **Accepted — Option A** (founder decision, 2026-07-13), **deferred**. The durable close
  — a server authors the task confirmation off a bounded offline intent — is the chosen direction, but
  it **rides the shared ADR-0020 offline intent rail** (R-04's P2) rather than a second bespoke trigger,
  so it is gated on that rail existing (which is in turn gated on the dormant engine migration). Option B
  (interim rules narrowing) is **declined**: it would be throwaway once A forbids worker `confirmed`
  creates outright. Until the rail lands, R-06-create stays an **accepted-with-controls** risk — the
  Option C compensating controls (pay review, `scanCreditIntegrity`, report exclusions) hold in the
  interim. Nothing is built yet; this ADR is the committed design for when the rail is available.
- **Relates to:** [ADR 0021](0021-server-authoritative-timer-session-write-path.md) (the R-04/R-12
  parent — defers R-06-create as an accepted risk, FU#3 asks for this ADR),
  [ADR 0020](0020-reliable-offline-session-engine.md) (the offline engine whose intent rail Option A
  reuses), [ADR 0015](0015-ai-native-command-substrate.md) (the audited `createTask` command path),
  the [R-04 + R-06-create closure roadmap](../roadmap/r04-r06-closure-roadmap.md) (phase **P-R06**),
  audit finding **R-06** (create half).
- **Author:** claude-opus-4-8 (handoff `.handoffs/r04-closure-progress.md`; the roadmap's P-R06 slice)

## Context

WORKZ has two independent approval gates on a task's lifecycle, and only one of them is enforced:

- **Update is guarded.** `changesApprovalFields()` ([`firestore.rules:163`](../../firestore.rules))
  forbids the assignee from flipping an *existing* task's `status`/`isApproved`/`confirmedBy`/
  `approvedBy` (the `!changesApprovalFields()` conjunct on the assignee update branch,
  [`firestore.rules:361`](../../firestore.rules)). A worker cannot take a pending task they own and
  self-approve it. This closed the update half of R-06.

- **Create is deliberately *unguarded* on status.** The `tasks` create rule
  ([`firestore.rules:338`](../../firestore.rules)) admits any owner-stamped, shape-valid
  (`taskFieldsOk`) row — **nothing constrains the `status` field on create.** The in-rule comment
  ([`firestore.rules:157-162`](../../firestore.rules)) records *why*: the call / quick-work auto-log
  flow legitimately creates a worker's own task **already `confirmed`**, so blocking self-confirmed
  CREATE would break that flow.

The legitimate worker-initiated confirmed-create surface is narrow and known:

| Path | Doc id shape | `status` for a plain worker | Confirming marker |
|---|---|---|---|
| **Call** auto-log ([`sessionActions.js:624`](../../src/utils/sessionActions.js)) | `sess_call_task_{uid}_{startMs}` | **`confirmed`** (a call is auto-confirmed by design) | `isSystemTask:true`, `confirmedBy:uid`, `completed:true`, `manualMinutes` |
| **Quick-work** auto-log ([`sessionActions.js:708`](../../src/utils/sessionActions.js)) | `sess_qw_task_{uid}_{startMs}` | **`completed`** (awaits manager approval) — only a *manager's* is `confirmed` | `isQuickWork:true`, `confirmedBy: isManager?uid:null` |
| Normal task create ([ADR 0015](0015-ai-native-command-substrate.md) `createTask`) | client id | non-approved (`pending`) | — |

**The forgery (R-06-create).** Because create ignores `status`, a custom or buggy client can `setDoc`
a `tasks/*` doc with `assignedUserId == self`, `status: "confirmed"`, `confirmedBy: self`, and a
client-chosen `manualMinutes` — minting **"already-approved work" that never passed a manager gate.**
Confirmed tasks feed reports, tiered pay ([ADR 0012](0012-tiered-pay-rates-earnings.md)), and badges,
so this inflates paid time and recognition.

## Why this is a distinct property from R-04 (and why it is closeable now)

ADR 0021 separated **atomicity** (R-12, closed) from **credited-time authorship** (R-04, deferred).
R-06-create is a **third** property, and it is closer to closeable than R-04's residual:

- **R-04 residual (intents g/f — manager-manual, self-backdate)** is an **asserted-duration** forgery:
  the actor legitimately types a start/end, so there is *no server ground truth* for the window. Rules
  can only re-check `duration == end−start`, never whether the window is real. Accepted-with-controls
  (ADR 0021).
- **R-06-create** is a **privilege** forgery: self-*granting the approval flag*, independent of any
  duration. A worker is **never** authorized to author `confirmed` on a non-auto-log task — so unlike
  a duration, this *can* be adjudicated. It is also **migration-invariant** (does not depend on the
  ADR-0020 engine rollout, which is [dormant in prod](../roadmap/r04-r06-closure-roadmap.md)).

The trap to avoid: the call auto-log makes a plain worker's *own* `confirmed` create legitimate, so a
naive "workers may not create confirmed tasks" rule regresses the single most-used field flow. The
close must **distinguish the legitimate auto-log from a forged confirmed task**, which is exactly what
the options below do.

## Options

### Option A — Server authors the confirmation (durable close)

The client stops writing the confirmed task directly and instead writes a bounded **intent** (an
offline-capable Firestore write — a callable is rejected because it cannot acknowledge an offline
call→stop, per ADR 0020 §3). A Firestore-**trigger** Cloud Function re-checks authorization
server-side, **re-derives the credited minutes from the paired `work_sessions` row** (never trusting a
client `manualMinutes`), and authors the `confirmed` task via the Admin SDK with a deterministic
(idempotent) id. Rules then forbid a worker's client from creating any task with
`status ∈ {confirmed, approved}`.

- **Closes:** the privilege forgery **and** the asserted-minutes residual (server owns the number).
- **Cost / risk:** touches the **live** call/quick auto-log hot path; needs a functions-emulator
  oracle **and** browser QA (this path has never had automated login QA — [ADR 0014](0014-dev-test-login-and-visual-qa.md));
  couples to the ADR-0020 offline outbox so the intent survives offline. Because it needs the same
  offline intent rail as R-04's P2, it should **ride that rail** rather than stand up a second bespoke
  trigger — i.e. deferred until the migration provides it.

### Option B — Create-time rules signature binding (interim narrowing, now)

Tighten the `tasks` create rule: when the creator is a **plain worker** (not manager/admin) and
`assignedUserId == self` and `status ∈ {confirmed, approved}`, **require the auto-log signature** —
the deterministic id prefix (`sess_call_task_` / `sess_qw_task_`), `isSystemTask == true` (or
`isQuickWork == true`), `confirmedBy == self`, `completed == true`, and `manualMinutes` present and in
range. Any other worker-created task must carry a non-approved status. Managers/admins are unaffected
(they hold real approval authority).

- **Closes:** the *general* privilege forgery — a worker can no longer mint an arbitrary approved
  task; a forged confirmed task must now **look exactly like a system auto-log.**
- **Does NOT close:** the leftover — a client can still forge an auto-log-shaped confirmed task with a
  fabricated `manualMinutes`. But that residual is **the same asserted-duration class** already
  accepted for R-04 g/f, so Option B *folds R-06-create's residual into the already-accepted risk
  bucket* rather than leaving it as an open privilege-escalation.
- **Cost / risk:** rules-only, **emulator-provable**, no new runtime, no offline coupling. The only
  behavioural requirement is that every legitimate worker-initiated confirmed create already satisfies
  the signature — true for the call path today (must be re-confirmed by a full trace + browser QA
  before shipping). Lowest risk; the recommended near-term slice.

### Option C — Accept with controls (status quo)

Keep the current compensating controls — manager pay review, `scanCreditIntegrity`
(orphan + suspicious-work-day, roadmap P0), `isTest`/quick-work report exclusions. Cheapest; closes
nothing. This is today's posture.

## Recommendation (proposed, not decided)

**B now, A later, on the shared rail.** Option B is a small, migration-invariant, emulator-provable
rules tightening that removes the privilege-escalation-beyond-auto-log and reduces R-06-create's
residual to the *same* bounded asserted-duration risk already accepted for R-04. Option A is the
durable close but should wait for the ADR-0020 offline intent rail (P2) so it does not stand up a
second bespoke trigger and hot-path QA effort. If the founder prefers to keep the surface small, C
(status quo) remains defensible given the compensating controls — this ADR exists to make that a
*chosen* posture, not an unexamined gap.

## Decision (founder, 2026-07-13)

**Option A, deferred.** The founder chose the durable server-authored close over the interim rules
narrowing (B). Rationale: Option A's final rule forbids a worker's client from creating any
`confirmed`/`approved` task, which makes B's signature-binding rule **redundant** — shipping B now
would be building a rule only to delete it when A lands. Rather than that throwaway step, R-06-create
remains an **accepted risk bounded by the Option C controls** until the ADR-0020 offline intent rail
(R-04's P2) exists, at which point A is built on that shared rail with the QA plan below. This makes
P-R06 **gated on the same migration long-pole** as R-04's self-mint core — a deliberate trade of
interim exposure (bounded, low-volume, detection-covered) for a single clean structural close instead
of two.

## QA plan (binding when Option A is built)

- **Emulator oracle** (`src/integration/firestore/securityRules.integration.test.js`, the R-04/R-12
  oracle pattern): a plain worker directly creating a `confirmed`/`approved` task **without** the
  auto-log signature is **DENIED**; the real call auto-log create **SUCCEEDS**; a manager creating a
  confirmed task **SUCCEEDS**; (Option A) any worker-client `confirmed` create is **DENIED** and the
  server-authored row is **ALLOWED**. Run via `npm run test:firestore`.
- **Full trace before shipping B:** enumerate every worker-initiated create that lands `confirmed`/
  `approved` (call, manager quick-work, any `createTask` branch) and prove the signature covers all of
  them — a missed path would deny a legitimate flow.
- **Browser QA** via the dev test login ([ADR 0014](0014-dev-test-login-and-visual-qa.md) /
  [runbook](../runbooks/visual-qa-test-account.md)): run a real **call** timer and a **quick-work**
  timer end-to-end at a ~360px viewport; confirm the auto-logged task still appears and reports/pay are
  unchanged. This path has never had automated login QA — do not ship without it.

## Consequences

- **Do not rush this into a tail-end session.** It touches the most-used worker flow; a regression
  silently breaks call/quick logging. It gets its own emulator oracle + browser-QA pass, per above.
- **Deploy is founder-run, post-ship.** Option B is a `firestore.rules` change → the standard
  human-only rules deploy (`firebase deploy --only firestore:rules` from up-to-date `main`, then
  re-verify the LIVE ruleset via Firebase MCP). Option A adds a `functions` deploy.
- **No client change for Option B** beyond the rule the client already satisfies; Option A rewrites the
  auto-log write into an intent write.

## Follow-ups / open questions

1. ~~Which option?~~ **Resolved 2026-07-13: Option A, deferred** (see Decision).
2. When A is built: confirm the intent rides the ADR-0020 outbox (offline projection) rather than a bare
   Firestore write, so an offline call→stop still queues; and that the trigger re-derives credited
   minutes from the paired `work_sessions` row rather than trusting the intent's `manualMinutes`.
3. When A is built: the emulator oracle must prove *any* worker-client `confirmed`/`approved` task
   create is DENIED and only the server-authored row is ALLOWED — plus the browser-QA pass on the live
   call/quick auto-log paths (never automated-QA'd).
4. Interim (while deferred): does the `scanCreditIntegrity` net already flag an auto-log-shaped forgery
   (task carries `manualMinutes`; is there a paired `work_sessions` row?), or is that a detection gap
   worth widening as a cheap compensating control *before* A lands? (Conservative assumption: partial.)
