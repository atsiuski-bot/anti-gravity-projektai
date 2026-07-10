# ADR 0020 — Revisioned offline session engine

- **Date:** 2026-07-09
- **Status:** Accepted (incremental rollout; task-timer slice first)
- **Supersedes:** client-side session serialization as a complete concurrency guarantee
- **Narrows:** ADR 0009 (task totals are projections, never a second time ledger) and ADR 0018
  (recovery continues a safe run after crediting the recovered interval)

## Context

The current timer path has three independent representations of one fact:

1. the worker profile says which session is active;
2. the task says whether its timer is running and carries a mutable accumulated total;
3. `work_sessions` records credited intervals.

Those documents are written independently. Some writes are awaited, some are suppressed, and some
are fire-and-forget. This permits partial success: the active session can be cleared before its
ledger row exists, a task can run while the profile says idle, or the profile can point at a session
that the task never accepted.

Firestore Web mutation promises resolve after backend acknowledgement. An offline mutation may be
accepted into the persistent local queue while its promise remains pending until reconnection.
Waiting for that promise before returning an "offline queued" result therefore locks the UI action
guard at exactly the time the worker must be able to issue a second command, especially stop after an
offline start.

The existing per-user JavaScript lock orders writes inside one page process only. Two tabs, a
restarted PWA, and two phones can still read the same state and perform stale last-write-wins
updates. A server-first read reduces the window but cannot close it.

Finally, `AuthContext` exposes a whole optimistic user document over the confirmed snapshot. It is
cleared only on an exact semantic match, so an old local prediction can indefinitely hide a newer
server session or conflict.

## Decision

### 1. Canonical records and invariants

`active_sessions/{uid}` is the authoritative active-session record for new-engine runs. It has a
monotonic integer `revision` and either an active run or an explicit idle state. An active run has a
stable `runId`, `type`, `startedAt`, and type-specific identity such as `taskId`.

The invariants are:

1. At most one run is active per worker.
2. Every accepted transition increments `revision` exactly once.
3. A command names the `expectedRevision` and, when closing or replacing a run, its
   `expectedRunId`.
4. A stale command cannot overwrite a newer revision or a different run.
5. One closed run produces at most one credited `work_sessions` row. Its deterministic document id
   is derived from `runId`, not from retry time.
6. The active-session transition, affected task transition, and closed-run ledger creation are one
   Firestore write batch. They all commit or none commits.
7. `work_sessions` is the sole credited-work authority. Client-written task totals are compatibility
   projections during migration and must not be used as an independent ledger.

The legacy `users/{uid}.activeSession`, `workStatus`, and per-type flags remain compatibility
projections while old clients exist. They are updated in the same batch as the canonical record,
never as an independent transition.

### 2. Persistent offline commands

Every user action creates a command before attempting Firestore:

- `commandId`: stable idempotency key;
- `kind`: start, pause, resume, end, switch, recover, or undo-recovery;
- `issuedAt`: stable client timestamp;
- `expectedRevision` and optional `expectedRunId`;
- the intended target and deterministic next `runId` where applicable;
- `status`: `queued`, `confirmed`, `rejected`, or `conflicted`.

Commands live in an IndexedDB outbox so PWA process death cannot erase the user's intent. Firestore
is then given one atomic batch. The public action API returns `queued` as soon as both the outbox
record and the local Firestore mutation have been issued; it does not await remote acknowledgement.
The batch promise settles later:

- backend acknowledgement marks the command `confirmed`;
- a permission or validation failure marks it `rejected`;
- a revision/run mismatch marks it `conflicted`;
- loss of process leaves it `queued`, and the next boot replays the same command idempotently.

Replaying a confirmed command is harmless because both the transition identity and any ledger id
are deterministic. Queue order is per worker. A later offline stop may depend on an earlier queued
start and is rebased over that local pending projection rather than blocked on connectivity.

### 3. Multi-device conflict policy

Security rules are the concurrency boundary. For an existing canonical record, a client transition
is accepted only when the requested revision is exactly the stored revision plus one and the
command's `expectedRevision` equals the stored revision. A close/replace additionally carries the
stored `runId`. Creation is allowed only at revision 1.

Consequently, simultaneous commands from revision N have one explicit winner. The first accepted
batch creates revision N+1; every other stale batch is rejected. The losing device surfaces a
conflict, drops or rebases its pending projection after the newer confirmed snapshot arrives, and
never reports success silently.

This rule deliberately prefers visible conflict over implicit last-write-wins. Automatic replay is
allowed only when rebasing preserves the original meaning. For example, a repeated pause of the same
already-closed run is an idempotent success; "start task B" after another device started task C
requires the worker to choose and is a conflict.

### 4. Confirmed state and pending projection

Listeners retain Firestore snapshot metadata (`fromCache`, `hasPendingWrites`) and the last confirmed
server revision. The UI derives a narrow session projection by applying queued commands over that
confirmed state. It never replaces the whole user document.

A pending projection is removed when its command is confirmed or rejected. It is rebased or marked
conflicted whenever a newer server revision arrives. UI copy distinguishes:

- saved on this device (`queued`);
- synchronized (`confirmed`);
- not accepted (`rejected`);
- changed on another device (`conflicted`).

Color remains the session signal, while text and an icon communicate pending/conflict state so the
result does not depend on color alone.

### 5. Recovery and undo

Each running segment is server-anchored by its persisted `startedAt`. On boot, a legacy or
new-engine run is compared with the last durable heartbeat:

1. credit the recovered interval using one deterministic close command;
2. if no newer revision/run superseded it, atomically open a fresh segment and keep the timer
   running;
3. show the worker what was credited and offer an undo for time they report as not worked.

The one-, five-, and 120-minute process-death cases follow the same policy. The heartbeat tail does
not decide whether the task stays paused; it only bounds evidence used for credit and telemetry.

### 6. Task totals and reconciliation

Reports and task detail read credited work from `work_sessions`. A server-owned projection may cache
the sum on the task for list performance, but clients do not increment or reconcile that total.
Projection updates are idempotent and revision-aware. A non-destructive integrity scanner reports
missing, duplicate, overlapping, and projection-drift cases before any historical repair is
enabled.

### 7. Migration

Rollout is vertical and backward compatible:

1. Add emulator tests, canonical schema, rules, outbox, and metadata-aware listeners.
2. Migrate task start/pause/resume first while dual-writing legacy profile/task projections.
3. Migrate task finish and recovery.
4. Move break, call, quick-work, and nested restore behavior onto the same transition builder.
5. Move task-total projection ownership to the server.
6. Stop legacy writes only after telemetry shows no active legacy clients/runs.

When no canonical record exists, compatibility reads synthesize revision 0 from the legacy user/task
state. The first accepted new-engine transition creates revision 1 and preserves or closes the
legacy run in the same batch. No bulk rewrite of active production sessions is required.

### 8. Rollback

Each migrated UI path has a feature gate. Rollback disables new command issuance while retaining:

- compatibility reads of canonical active records;
- outbox replay and status visibility for already-issued commands;
- deterministic ledger ids and legacy projections.

Rollback must never delete canonical records or queued commands. Old clients can continue reading the
dual-written legacy projection. If rules must be rolled back, issuance is disabled first and queued
commands are drained or explicitly surfaced; permissive last-write-wins rules are never restored over
active revisioned records.

## Alternatives considered

### Firestore transactions for every transition

Transactions provide compare-and-set but are not a usable offline command mechanism: they require a
server round trip and cannot satisfy stop-after-offline-start. Rejected for the client transition
path.

### Cloud Function command processor

A server processor can transact safely and remains a future option for privileged or complex
transitions, but it cannot acknowledge an offline action until reconnect and adds deployment/runtime
coupling. The local outbox plus rules-enforced atomic batch provides offline issue semantics without
making a function the only write path.

### Keep `users/{uid}.activeSession` authoritative

This would keep timer concurrency mixed into a large, frequently edited profile document and make
revision rules interact with unrelated user preferences and admin edits. A dedicated record gives
the invariant one owner and one revision boundary.

### Client lock plus server-first reads

This is the current mitigation. It reduces same-process races but cannot order two devices and cannot
turn independent writes into one transition. Rejected as a correctness boundary.

## Consequences

- Offline start can be followed immediately by offline pause; neither action waits for reconnection.
- Two devices produce an explicit winner and a visible conflict instead of a silent overwrite.
- A ledger failure cannot clear the active run because both writes share one atomic batch.
- Retried commands cannot duplicate credited time.
- The client carries more explicit state: confirmed snapshot, pending commands, and command outcome.
- Rules become part of timer correctness and require emulator coverage plus a human-run,
  post-ship deployment from up-to-date `main`.
- During migration, legacy projections remain duplicated representations, but they are outputs of
  one transition rather than independent ledgers.

## Verification and rollout gates

The Firestore emulator must cover offline queueing, stop-after-offline-start, simultaneous stale
revisions, atomic ledger failure, and idempotent replay. Unit tests cover transition construction,
pending projection/rebase, compatibility reads, and recovery decisions. The release gate remains
lint, all tests, build, and 360 px visual QA with the dev test account.

No deployment is performed as part of this work.
