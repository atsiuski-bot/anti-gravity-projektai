# Confirmed reasoning and false-positive controls

## Method

The audit combined deterministic gates with adversarial read-only inspection of the worker
timer path, canonical ledger, denormalized task projections, offline outbox, Firebase rules,
server triggers, integrity scans, role changes, responsive UI, and mobile performance.

Findings were accepted only when a complete path could be shown:

`entry point -> state transition -> persistence/authority -> consumer -> user consequence`.

## Strongest causal chains

### Worker correction divergence

1. A worker changes or discards one of their own `work_sessions` rows.
2. Full task reconciliation requires a broad `taskId` query.
3. Firestore rules cannot prove that broad result set is owner-only.
4. The code falls back to an owner query and marks the result partial.
5. Reconciliation deliberately skips the task projection.
6. The public action ignores the incomplete result and reports success.
7. Canonical reports and task-side displays now describe different paid time.

This is not a hypothetical rules mismatch: the unit test explicitly expects partial
reconciliation to avoid a task write.

### Session stamp fail-open

1. A work/break session is created.
2. A create trigger derives the manager closure.
3. A dependency read fails.
4. The closure helper translates the failure to an empty closure.
5. The trigger exits successfully without authoritatively stamping.
6. No update trigger or periodic repair revisits that row.
7. Scoped manager visibility and write authority remain wrong indefinitely.

### Integrity scan false green

1. One scan dependency fails while another data anomaly exists.
2. The helper returns an empty/zero/null substitute.
3. Report severity considers found anomalies but not incomplete coverage.
4. The run can publish `ok` and replace a numeric count baseline with `null`.
5. The operational control says "clean" exactly when it did not complete.

### Senior demotion stale authority

1. A senior manager is demoted to worker.
2. Existing `seniorManagerIds` membership remains in downstream closure data.
3. Restamping follows direct team membership, not the reverse senior membership.
4. Rules trust closure membership without validating the requester's current role.
5. The former senior retains writes into a former subordinate's user state.

### Rollout cache miss selects the wrong writer

1. An allowlisted worker boots offline or on a cold cache.
2. The config listener emits a cache-only document miss.
3. The listener ignores `fromCache` and resolves the tri-state gate to disabled.
4. Timer controls become actionable through the legacy writer.
5. The worker starts an activity.
6. A later server snapshot enables the canonical writer.
7. The legacy-only run is no longer represented by the authority the UI now reads.

### Offline secondary switch loses the new intent

1. A legacy quick-work/call/break session is active.
2. The worker selects a different secondary activity while offline.
3. The code issues and awaits the interrupted segment's deterministic ledger write.
4. Firestore queues the write locally but does not settle its promise without server ACK.
5. The new `activeSession` update is never issued.
6. The PWA closes before reconnect.
7. The old session remains the server authority and the selected activity never existed.

### Auto-stop safety net is non-atomic

1. The daily net reads a stale running-task snapshot and separately probes canonical state.
2. Projection stop, ledger create, and canonical release occur in three different phases.
3. Ledger errors are logged and swallowed; canonical-read errors are reclassified as legacy;
   projection writes have no revision precondition.
4. A transient failure or concurrent new run can therefore break exactly-once credit and
   projection/canonical agreement.
5. The stopped task no longer qualifies for the next scan, so some failures are not self-healing.

## Rejected or unconfirmed concerns

- Worker-authored sessions and confirmed task creation are documented accepted risks R-04 and
  R-06-create, not newly discovered defects.
- The 16-hour abandoned quick-work/call credit cap is a documented product policy.
- Firebase web client configuration is public application configuration, not a repository
  secret.
- English `console.error` messages are not user-facing copy.
- Development-only test-login errors are removed from the production build.
- `text-xs` resolves to the project's permitted 12 px minimum.
- Small icons inside 44 px buttons are not small touch targets.
- The completion-photo close control expands its hit area with a pseudo-element.
- A potential 360 px nested-session header overflow was identified geometrically but not
  reproduced in an authenticated browser; it is not included in the confirmed issue counts.
- Historical `workerId`-only rows cannot be inferred from source. Their existence remains a
  live-data verification question.
