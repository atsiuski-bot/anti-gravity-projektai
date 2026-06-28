# Phase 06 — Firebase deterministic diff (rules · indexes · functions)

**Status:** ⚠️ PARTIAL — local analysis complete; **live diff blocked** (MCP token expired)
**Findings:** 🔴 0 · 🟠 0 · 🟡 1 · ℹ️ 3

## Method
Local artifacts read directly: `firestore.rules`, `storage.rules`, `firestore.indexes.json`,
`firebase.json`, `functions/index.js` (+ `functions/decisionLog.js`). Live-vs-repo diff
attempted via the Firebase MCP (`firebase_get_security_rules`, `firestore_list_indexes`,
`functions_list_functions`). Deep query↔index↔rule coupling reasoning is delegated to the
`firebase-coupling` reasoning dimension; this phase records deterministic facts only.

## Live diff — BLOCKED
`firebase_get_security_rules` / `functions_list_functions` returned **`Authentication Error:
credentials are no longer valid — firebase login --reauth`**. The MCP token for
`audrius@medievalclub.org` has expired, so the **live** ruleset / index / function runtime
**cannot be verified this session**. `firebase_get_environment` still resolved (cached): active
project **`darbo-planavimas`** (alias `default`), EU region. Re-auth is an interactive
human-only action — surfaced below, not performed.

## Local inventory (all present + wired)
- **`firebase.json`** wires `firestore.rules`, `firestore.indexes.json`, `storage.rules`, and
  the `functions/` codebase (`source:"functions"`, `region` set in code).
- **`firestore.rules`** (rules_version 2): comprehensive, per-collection. Identity/role
  helpers use the safe `.get(field, default)` idiom throughout (the documented `isDisabled`
  dot-access trap is closed). Per-document ownership scoping on all writes; broad team-wide
  reads by design (documented). No `if true`, no recursive `=**` wildcard, no unscoped
  `allow write`. Unused collections (`shift_logs`, `daily_stats`) are explicitly locked
  `if false`. Durability guards present (`durationInRange` ≤1440, `workHoursShapeOk`,
  `taskFieldsOk`, request_notifications/error_logs/decision_log shape clamps).
- **`storage.rules`** (rules_version 2): owner-scoped `attachments/{uid}/` (image-only,
  <20 MB) and `avatars/{uid}/` (image-only, <5 MB; team-wide read for avatar render). Clean.
- **`firestore.indexes.json`**: **12 composite indexes** (tasks ×5, archived_tasks ×3,
  work_sessions ×2, break_sessions ×2). The header documents that array-contains-only
  single-field queries are auto-served.
- **`functions/index.js`**: **21 exported functions**, `setGlobalOptions({region:'europe-west1',
  maxInstances:10})`. 11 Firestore triggers (notify*, cleanupAttachments*, *Badge,
  stampTeam*, restampTeamOnUserChange, notifyAdminsOnPendingSignup), 4 scheduled
  (`dailyIntegrityScan`, `generateRecurringTasks`, `escalateTaskPriorities`,
  `notifyOverdueTasks`), 3 callables (`backfillTeamStamps`, `runRecurringTasksNow`,
  `parseTaskDraft`). `functions/` lint clean (see `19-deps.md`).

## Findings
### 🔴 Critical
_(none deterministically — rule/storage files are well-formed and scoped)_
### 🟠 Likely
_(none deterministically — coupling reasoning is in the reasoning track)_
### 🟡 Risk
- **Live deploy state unverifiable + documented pending deploys.** Project memory flags
  several changes as *client-live but deploy-pending*: the **VERY_LOW→4-tier priority**
  retirement (rules `taskFieldsOk` now lists `['URGENT','HIGH','MEDIUM','LOW']` locally —
  RULES+FUNCTIONS deploy pending), the **multi-week recurrence interval** (functions deploy
  pending), and the **badge-threshold recalibration** (functions deploy pending). If the live
  ruleset still allows `VERY_LOW`, or live functions run the old recurrence/badge logic, prod
  silently runs stale logic. WHY 🟡 (not 🔴): these are tracked, human-only deploys and the
  client is already live; the risk is drift, not a live break. FIX (human-only, post-merge):
  re-auth the Firebase MCP, then verify the live ruleset/index/function runtime per the
  CLAUDE.md deploy protocol (`/ship` → main merge → deploy from updated main → MCP-verify live).

### ℹ️ Info
- Re-auth required to verify live state: `firebase login --reauth` (account
  `audrius@medievalclub.org`) — interactive, human-only.
- `firebase_get_environment` reports `Billing Enabled: No`. Project memory records a Blaze
  plan with deployed FCM functions, so this is likely a stale/limited read, not a regression;
  cannot confirm without working credentials.
- Compound-query ↔ index ↔ rule coupling (missing-index `FAILED_PRECONDITION` risk,
  client-touched collections without a rule, orphan rules) is the `firebase-coupling`
  reasoning dimension — see `00-reasoning-confirmed.md`.
