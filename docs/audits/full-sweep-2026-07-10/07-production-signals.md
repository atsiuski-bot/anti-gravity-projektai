# Phase 07 — Live production signals

**Status:** ✅ COMPLETE  
**Findings:** 🔴 0 · 🟠 3 · 🟡 2 · ℹ️ 2

## Method

Read the latest 100 `error_logs`, all 17 daily `integrity_reports`, and recent Cloud Functions logs from the correctly pinned `darbo-planavimas` project. User identifiers and payload details were not copied into this report.

## Findings

### 🟠 Likely

- **Current timer reconciliation is deterministically denied before its write.** `writeFail:reconcileTaskTimerFromSessions` appears 16 times from 2026-07-08 through 2026-07-10, including two events on the audit day. It affects four distinct active accounts (three workers and one scoped manager) on the production host. Source/rule reconstruction proves the first operation — `work_sessions where taskId == ...` at `src/utils/sessionEditActions.js:81` — cannot satisfy the private read rule at `firestore.rules:327-330` for a worker or scoped overseer because it carries neither the owner nor team constraint. Firestore rejects the query before either task lookup or update. The initiating correction has already mutated the canonical session and the failure is swallowed, so task counters can diverge while the UI reports success. The same unmigrated task-centric query shape breaks hard-delete session cleanup, scoped-manager time correction, and scoped history export. **Fix:** centralize role-aware session queries and move cross-document reconciliation/delete cascade to an authorized idempotent server-side path; add authenticated emulator oracles. The existing log context still cannot identify which caller produced each individual event or quantify each stale projection.
- **A required production composite index is missing.** `useWorkerStats` logged five real `FAILED_PRECONDITION` events between 2026-07-01 and 2026-07-07. The required combination is `archived_tasks: teamManagerIds ARRAY_CONTAINS + archivedAt ASC + __name__ ASC`; local/live manifests contain only the descending variant. **Consequence:** the affected scoped worker-statistics query fails at runtime. **Fix:** add the ascending composite definition and a query-spec/index parity test; deploy only after the change is merged and main is current.
- **A critical integrity event remains operationally unexplained.** The 2026-07-01 daily report records `break_sessions` falling from 2,096 to 1,189 — 907 documents / 43% — and correctly marks the day `critical`. Subsequent days are stable. **Consequence:** this is either a legitimate bulk remediation or a major deletion event; the audit cannot safely infer which. **Fix:** correlate the date with the founder's cleanup audit trail/backups and document the operation. If unrecognized, use the existing PITR/backup runbook to investigate immediately.

### 🟡 Risk

- **Service-worker update failures become global unhandled rejections.** Thirteen of the newest 100 errors are SW update failures (six on production, seven on localhost). `src/components/PwaUpdatePrompt.jsx:36-40` calls `registration.update()` without a Promise handler, and `src/utils/errorLog.js:142` records the rejection. The same block never clears its hourly interval. **Fix:** own the interval in an effect cleanup and handle/classify the Promise with rate-limited logging.
- **Additional user-command/race failures are visible but not yet causally isolated:** three delete attempts, three confirm attempts, three complete attempts, four missing-document undo/confirm updates, and one duplicate work-session create appear in the newest window. Some sources log the same event at two layers, so raw row count is not action count. Add operation IDs and expected revision/target metadata to error context, then reproduce before promoting these to separate implementation findings.

### ℹ️ Info

- The newest 100 error records span 2026-06-30 through 2026-07-10: 77 permission-denied, 13 SW update failures, 5 missing-index errors, 4 missing-document updates, and 1 already-exists race. Ninety-three originated on the production Cloudflare Pages host and seven on localhost.
- Cloud Functions produced no WARNING-or-higher log entries in the last seven days and no ERROR-or-higher entries in the last 30 days. The latest integrity report (2026-07-10) is `ok`: zero value anomalies, zero overdraft offenders, zero auto-closures, and no collection drop.
