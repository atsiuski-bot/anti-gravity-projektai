# ADR 0015 — AI-native command substrate (actor model · decision log · propose/commit)

- **Status:** Accepted (Phase 1 landed — substrate + first command; not yet wired into the UI)
- **Date:** 2026-06-23
- **Supersedes / superseded by:** none
- **Related:** [0002](./0002-agent-operating-model.md) (free-write + `[ai-author]` audit — this is that
  instinct pushed down to the *data* layer), [0005](./0005-scoped-manager-hierarchy.md) /
  [0007](./0007-senior-manager-subtree.md) (the authorization spine commands defer to),
  [0011](./0011-data-durability-and-integrity.md) (the durability net a runaway agent must not defeat).

## Context

WORKZ is to eventually host **AI manager agents** that distribute work and analyse operations. An
agent has no browser and cannot click a form; it acts by *issuing operations* and *reading state*.
A diagnostic of the current architecture found the seeds of what that needs, but inconsistently:

- **Actions are not a contract.** State changes happen three ways — clean pure functions in
  `src/utils/` (`taskActions`, `sessionActions`), **inline `addDoc`/`updateDoc` in components**
  (e.g. `TaskModal` creates a task directly even though `createManagerTask` exists), and admin-SDK
  Cloud Functions. An agent can only reliably use ONE named, callable surface. The dual create path
  already causes drift today — evidence this is not speculative.
- **Assignment is an invisible side effect.** "Assign" = setting `assignedUserId` on form save.
  There is no record an assignment *decision* was made, and no seam for a policy (or an agent) to
  plug into.
- **The model is state-mutation-biased.** Tasks mutate in place; "why" and "what changed" vanish at
  the moment of the write. Only `work_sessions` is append-only. There is no audit/event spine an
  agent action could be attributed to, reversed from, or learned from.
- **Every actor is assumed human.** Identity = a Firebase Auth user. There is no notion of a
  non-human principal acting *as itself*, attributably and revocably.

These are exactly the decisions that are cheap to shape now and expensive to retrofit once agents
exist and writes have proliferated.

## Decision

Introduce a deliberate **command layer** under a new `src/domain/` (distinct from misc `src/utils/`),
**transport-agnostic** so the same contract can later be exposed via a callable Cloud Function
without changing a caller. Four cross-cutting concerns are designed in from the first command:

1. **Actor model** (`actor.js`) — every command is performed by an explicit `{ type, id, name }`
   actor: `human` (built from the AuthContext user), `agent` (its own principal id + `kind`), or
   `system` (a non-AI job). `actorStamp()` flattens it onto the audit entry. An actor is a frozen,
   serializable value — **not** a credential; Firestore rules stay the real authority on the write.

2. **Decision log** (`decisionLog.js` → new append-only `decision_log` collection) — the **event
   spine**. Each consequential command appends one immutable record: actor stamp · command · target
   · reason · compact `before`/`after`. The **doc id is the command's idempotency key**, so a
   retried command (agents retry) re-issues `setDoc` against the same id, which the rules treat as
   an `update` and **deny** (the log is immutable); the appender swallows that denial (best-effort),
   leaving the original entry standing instead of duplicating it. Audit-write failure **never aborts
   the command** (the effect already happened) but is surfaced to the durable crash log.

3. **Command kernel** (`command.js` → `defineCommand`) — wraps a domain op with actor + mode +
   idempotency + audit. A command is `{ name, targetType, authorize, plan, apply }`:
   - `plan(input, ctx)` is **pure** (no writes) and is the single source of "what this would do" —
     used by **both** modes, so a proposal is exactly what gets committed.
   - `authorize(input, {actor, mode})` returns `true` or a **refusal reason string** (a soft,
     expected refusal — not an exception). This expresses actor/mode policy the rules can't.
   - `apply(plan, …)` performs the writes (commit only), run **before** the audit append.

4. **Propose / commit contract** (`MODES`) — the **default mode is `propose`**: a command writes
   **nothing** unless the caller explicitly asks to `commit`. This makes "AI proposes, human
   approves" the built-in shape of every command (generalising the existing `parseTaskDraft`
   pattern), so an agent can be rolled out behind an approval gate and have its autonomy raised
   gradually.

**First command — `assignTask`** (`commands/assignTask.js`): makes work distribution a first-class,
named, audited operation wrapping the same field write the UI already performs. The **human-only
boundary is in code**: an agent actor may `propose` an assignment but is **refused** on `commit`
(mirroring CLAUDE.md's deploy/secret boundary) — agent-driven commits ship later behind a
propose→approve gate.

## Alternatives considered

- **Keep evolving `src/utils/` ad hoc.** Rejected: the scattered-write drift is already biting, and
  there would be no consistent place to attach actor/audit/mode — the retrofit cost this ADR avoids.
- **Go server-first (callable Cloud Functions now).** Rejected for Phase 1: larger change, needs
  human-gated deploys, and the *contract* (actor/mode/audit/idempotency) matters more than the
  *transport*. The contract is designed to lift to a callable later unchanged.
- **Full event-sourcing of all state.** Rejected: the live UI and the signature whole-screen session
  colour depend on fast current-state reads. We keep mutable projections for live state and add the
  append-only log **alongside**, only for consequential decisions.
- **Idempotency via read-before-write existence check.** Rejected for Phase 1: racy on the client
  and adds a read. Doc-id dedup at the log + naturally-idempotent effects is sufficient now; strict
  cross-process idempotency lands with the server surface.

## Consequences

- **Additive and inert-safe.** No existing flow is rewritten; `assignTask` is fully built + tested
  but **not yet wired into the UI**. Until the `decision_log` rules clause is deployed, an append is
  denied and silently skipped (command still succeeds, no audit) — so the client is safe to ship
  ahead of the deploy, but the rule should be deployed **before** routing real traffic through a
  command (else every commit also emits a permission-denied crash-log line).
- **New collection + rule.** `decision_log` is append-only: `create` if active **and** the doc stamps
  the caller's uid as `actorId` (provenance, same idiom as `request_notifications`); `update:false`
  (immutable); `read` managers/admins; `delete` admin-only. A client write is therefore always a
  human acting as themselves; an agent's future commit runs server-side via the admin SDK.
- **Quality gate green:** lint 0 warnings · **226 tests** (+33: actor, decision log, kernel
  propose/commit/authorize/idempotency + the audit-never-aborts guarantee, and the full `assignTask`
  path incl. the agent-commit refusal) · build OK. `firestore.rules` validated via the Firebase MCP.
- **No behaviour change yet** for users. The substrate is the foundation the next increments build on.

## Review hardening (adversarial multi-agent pass)

Before acceptance, a 5-dimension adversarial review (parallel finders → 3-skeptic majority verify)
raised 15 findings; **7 were confirmed and fixed**, 8 dismissed as out-of-scope/speculative:

1. **`decision_log` create pins `actorType:'human'`** (not just `actorId`) — a human can no longer
   launder a decision as if an AI agent or system job decided it (the attribution boundary itself).
2. **The kernel OWNS the "audit never aborts the command" guarantee** with a defensive try/catch, and
   `appendDecision` is now genuinely non-throwing (a malformed actor / bad input degrades to a logged
   null instead of aborting an already-applied effect).
3. **`apply` idempotency is an explicit documented contract** — the log de-dups the AUDIT, not the
   EFFECT; the kernel re-runs `apply` on retry.
4. **`assignTask` no longer persists `assignedUserName`** (a read-derived display field everywhere
   else) — only the audit before/after capture it.
5. **The audit-never-aborts guarantee is tested at the kernel level** (a null AND a thrown append).
6. **`decision_log` create gained minimal permissive shape guards** (command a non-empty string, mode
   a string, reason ≤2000, null-tolerant) so the spine can't be poisoned by a malformed/oversized entry.
7. **`appendDecision` tags the crash-log source by failure class** (`.denied` for the expected
   retry/rollout class vs `.AUDIT_LOST` for a genuine, unexpected audit loss) so a real gap is greppable.

## Follow-ups (the roadmap this is Phase 1 of)

1. **Wire the real assignment UI through `assignTask`** — **DONE (increment 2, same worktree):**
   `TaskModal`'s edit branch now routes a reassignment through `assignTask` (the command owns the
   assignee write + its audit; `assignedUserId`/`assignedAt` are kept out of the content save). The
   second write is non-atomic with the content save (one-command-per-edit is #2 below), so a failed
   reassignment surfaces a precise message, suppresses the (otherwise false) `task_assigned`
   notification, and keeps the modal open for a retry. A focused adversarial review (1 finding) drove
   that handling. **Deploy the `decision_log` rule to activate the audit** (until then the reassign
   still works, the audit append is silently denied).
2. **Migrate the other consequential writes** through the kernel — consolidating the scattered write
   paths. **`createTask` DONE (increment 3, same worktree):** a `createTask` command is now the single
   audited create path — it mints the new id locally (so the audit names it), canonicalizes, stamps
   provenance from the actor, writes the doc, and records one decision. **Both** create sites route
   through it: `createManagerTask` (the template/recurring/quick-add util) delegates to it, and
   `TaskModal`'s create branch calls it instead of an inline `addDoc` — killing the dual-create drift
   the analysis flagged. The kernel result gained `targetId` for a clean new-id accessor. Verified
   live in prod (real auth): the created doc is field-equivalent to the prior path and a matching
   `createTask` decision entry (before: null) is written.
   **`completeTask` + `reopenTask` DONE (increment 4, same worktree):** task completion and reopen are
   now audited lifecycle transitions. `completeTask` applies the manager auto-confirm (a manager / the
   task's own manager → `confirmed`, else `completed`); `reopenTask` resets completion + confirmation +
   soft-delete flags back to `pending`. The existing utils delegate to them — `toggleTaskCompletion`
   (the running timer is still paused in the util first, so the command needn't import the timer code
   and cycle) and `revertTask` (now carrying the acting user for attribution); the dead one-way
   `completeTask` util + `sanitizeTaskData` were removed. Adversarial review clean (0 confirmed of 4
   raised — the only deltas, e.g. a reopened zero-time task's `timerStatus` going `paused`→`null`, were
   judged benign). Verified live in prod: a full create→complete→reopen cycle leaves the task `pending`
   and writes the three matching decision entries (the lifecycle's "how it got here" trail).
   **`approveTask` + `reprioritizeTask` + `rescheduleTask` DONE (increment 5, same worktree):**
   `approveTask` consolidates FOUR previously-identical inline approve writes (TaskCard, TaskTable, two
   ManagerNotifications handlers) into one audited command — every approval is now attributable.
   `reprioritizeTask` + `rescheduleTask` are the manager-agent's triage verbs (single-field, canonical
   priority / verbatim deadline); they are built + tested and **agent-ready but not yet UI-wired** (the
   UI changes priority/deadline through the edit form until that path is routed through a command).
   Review clean (0 findings); verified live in prod (real auth): a create→approve→reprioritize→reschedule
   run left the task `approved` / `URGENT` / dated and wrote the four matching decision entries.
   **`deleteTask` DONE (increment 6, same worktree):** task deletion is now an audited command —
   the soft (keep-hours, in-place mark) and hard (remove + mark work_sessions deleted) writes plus the
   decision entry are owned by the command; the util keeps the timer-pause + role/actor resolution and
   the 4 call sites (TaskCard/TaskTable/TaskHistory/ManagerNotifications) are unchanged. Review clean
   (0 findings); gate green (297 tests). `extend-time` is N/A — `extendTaskTime` is dead code (no caller).
   STILL TODO: **confirm** (completed→confirmed — its writes still vary across 4 sites and those sit in
   the actively-churned approval-unify zone, so reconcile once that settles) and routing the **EDIT**
   path through one command (retiring increment 2's split — TaskModal is also a hot, parallel-edited zone).
3. **Formalize the task lifecycle as an explicit state machine** enforced by the commands.
4. **Promote perception (E):** make `workerStats`/`reportAggregate` callable server-side so an agent
   can read "decision context" without a browser.
5. **Server-callable command surface + agent principal** in `firestore.rules` (the agent acts as
   itself, with a kill-switch); then the first real assignment agent in `propose` mode behind the
   approval gate.

**Founder-run:** deploy `firestore.rules` (adds the `decision_log` clause) before follow-up #1.
