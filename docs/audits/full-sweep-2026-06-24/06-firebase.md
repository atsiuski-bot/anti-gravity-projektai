# Phase 06 — Firebase deterministic diff (rules · indexes · functions)

**Status:** ✅ COMPLETE
**Findings:** 🔴 0 · 🟠 0 · 🟡 0 · ℹ️ 2

## Method

Live state read via the Firebase MCP against project **`darbo-planavimas`** (EU
`europe-west1`), authenticated `audrius@medievalclub.org`:
- `firebase_get_security_rules` (firestore + storage) → diffed against repo
  `firestore.rules` / `storage.rules`.
- `firestore_list_indexes` (collection groups `tasks`, `work_sessions`, `break_sessions`,
  `archived_tasks`) → diffed against repo `firestore.indexes.json`.
- `functions_list_functions` → diffed against the `exports.*` in `functions/index.js`.

Deterministic facts only here — the privilege-escalation *reasoning* is the reasoning
track's `security` + `firebase-coupling` dimensions (`00-reasoning-confirmed.md`).

## Findings

### ✅ Rules — repo == live (deployed)
Both `firestore.rules` (568 lines) and `storage.rules` (39 lines) are **byte-identical to
the live deployed rulesets**. Every distinctive guard is present live: the `durationInRange`
24h ceiling on `work_sessions`/`break_sessions`, the **`userId` UPDATE pin** (full-sweep F5)
on all three time collections, `payRate` admin-only (ADR 0012), `taskFieldsOk` priority/
estimate shape guard, the `decision_log` `actorType:'human'` create pin (ADR 0015), the
`system_config` kill-switch (admin-only, `enabled is bool`), and `integrity_reports`
write-locked. Repo rules last changed `955920a` (2026-06-23); they are live. No drift.

### ✅ Indexes — 12 local == 12 live (all READY)
All 12 composite indexes in `firestore.indexes.json` exist live with `state: READY`:
- `tasks`: ×5 (teamManagerIds+{createdAt↓, status, updatedAt}; assignedUserId+{status, updatedAt})
- `archived_tasks`: ×3 (teamManagerIds+archivedAt↓; assignedUserId+{archivedAt↓, archivedAt})
- `work_sessions`: ×2 (teamManagerIds+date; userId+date)
- `break_sessions`: ×2 (teamManagerIds+date; userId+date)

**No local-only (undeployed) index** → no latent `FAILED_PRECONDITION` from this file. The
file's own header notes single-field array-contains queries are served automatically and
need no entry — consistent with what is live.

### ✅ Functions — 19 repo exports == 19 deployed (name parity)
Every `exports.*` in `functions/index.js` maps 1:1 to a deployed v2 function in
`europe-west1` (nodejs22): the 5 notify/cleanup triggers, 3 badge triggers, 4 team-stamp
triggers, `restampTeamOnUserChange`, `backfillTeamStamps`, `notifyAdminsOnPendingSignup`,
`dailyIntegrityScan`, `generateRecurringTasks`, `runRecurringTasksNow`, `parseTaskDraft`.
**No missing function (stale-export) and no orphan deployed function.**

### ℹ️ Info
1. **Name-parity only, not source-hash parity.** The MCP confirms the *set* of deployed
   functions matches the repo's exports, but cannot prove the *deployed bytes* equal the
   current repo source. A function edited-but-not-redeployed would pass this check. The
   `/firebase-status` skill carries the source-hash diff; run it if a functions change is
   suspected post-merge. (Repo `functions/index.js` last changed `0fc5b09`, 2026-06-24.)
2. **Locked/orphan rule collections are intentional**, not dead-rule findings:
   `shift_logs`, `daily_stats` (`if false`), `deleted_tasks` (read-only, listened by
   `DailyStatistics`), `sessions` (legacy audit, write-own). The `deadcode` dimension
   re-checks whether the client still touches each.
