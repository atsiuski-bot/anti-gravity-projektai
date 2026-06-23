# Phase 06 — Firebase rules / indexes (deterministic diff)

**Status:** ✅ COMPLETE
**Findings:** 🔴 0 · 🟠 0 · 🟡 1 · ℹ️ 2

## Method
Read local `firestore.rules` (412 L), `storage.rules` (39 L), `firestore.indexes.json`
(94 L). Pulled the **live deployed** rules for project `darbo-planavimas` (ACTIVE, project
number 198926113678) via the Firebase MCP (`firebase_get_security_rules`) and byte-compared
repo vs live. Deterministic facts only — privilege-escalation reasoning is delegated to the
`security` / `firebase-coupling` reasoning dimensions.

## Result
- **No `if true` / `allow read, write: if true`** anywhere. Locked collections
  (`shift_logs`, `daily_stats`, `deleted_tasks` write) correctly use `if false`.
- **Live Firestore rules == repo rules — functionally identical.** The ONLY difference is in
  comments: live rules cite **ADR 0006**, repo rules cite **ADR 0007** (the hierarchy ADR was
  renumbered 0006→0007 after main took 0006 for the notification-bell). Every executable rule
  body is byte-for-byte identical. → The deployed rules behaviour is **current**; the repo is
  only ahead by a comment renumber that has not been redeployed.
- **Live Storage rules == repo Storage rules** — byte-identical.
- **`firestore.indexes.json` EXISTS** (11 composite indexes for the scoped-manager hierarchy:
  tasks/archived_tasks/work_sessions/break_sessions on `teamManagerIds`+date/status and
  owner-field+date). This **contradicts the sweep plan**, which repeatedly states "no
  `firestore.indexes.json`."

## Findings
### 🟡 Risk
- **Index-file completeness is asserted by comment, not verified.** `firestore.indexes.json`
  covers the scoped-overseer compound queries, but its own header note admits single-field
  and other compounds rely on Firestore's auto-index or a runtime "create index" link. Whether
  the live project has all required composites built (vs. the repo file matching what is
  deployed) was not diffed here — `firestore_list_indexes` would confirm. The
  `firebase-coupling` reasoning dimension enumerates every client compound query against this
  file; any query with no matching entry is a runtime `FAILED_PRECONDITION` risk.
  FIX: cross-check the reasoning-track `firebase-coupling` findings against this file's 11
  entries; build any missing composite before it bites a manager mid-report.

### ℹ️ Info
- **Live-vs-repo rules: comment-only drift (ADR 0006 → 0007).** No functional/security
  impact — the deployed rules enforce exactly the current logic. A future
  `firebase deploy --only firestore:rules` will sync the comment text. Not a deployment gap.
- **Sweep-plan drift (meta).** The plan asserts WORKZ has "no `firestore.indexes.json`" and
  "no Cloud Functions." Both are false: the index file exists (above) and a `functions/`
  codebase exists (`functions/index.js`, 38 KB, with its own `package.json` — the FCM push
  senders + storage-cleanup, per the deployment memory). `firebase.json` wires all four:
  hosting, storage, firestore(rules+indexes), and functions. The `firebase-coupling` /
  `security` reasoning dimensions cover the rules↔query coupling; the Cloud Functions
  source is now in-repo and auditable.
