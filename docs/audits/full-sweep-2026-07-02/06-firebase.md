# 06 — Firebase deterministic diff — ✅ COMPLETE (re-auth restored)

**Live verification (2026-07-02, post-`--reauth`):** billing enabled, account
`audrius@medievalclub.org`, project `darbo-planavimas`. Live state read via Firebase MCP.

## Live vs repo — result

| Surface | Live | Repo | Verdict |
|---|---|---|---|
| Composite indexes | 12, all `READY` | 12 | ✅ Match, all built |
| Cloud Functions | 21 (nodejs22, europe-west1) | 21 exports | ✅ Match |
| Firestore rules | see below | see below | ⚠️ **1 drift** |

### 🟠 One confirmed rule drift — `calendar_requests` userId-pin NOT deployed

Repo [firestore.rules:501-502](../../../firestore.rules) pins the owner on update
(`request.resource.data.get('userId','') == resource.data.get('userId','')`); the **live**
deployed rule is the older `allow update: if isUserActive() && (ownsUserId() || isManagerOrAdmin());`
with **no pin**. Latent gap: an owner/manager could re-point a calendar_request's `userId`
to a colleague, grafting a request onto their calendar history. Low severity (calendar, not
time/pay), but real. This matches the 2026-06-27 sweep note ("calendar_requests userId-pin
NOT deployed"). The equivalent pins on `work_sessions` / `break_sessions` / `work_hours`
**are** live — only this one lagged.

> **Founder deploy (one step, post-merge from up-to-date main):**
> `firebase deploy --only firestore:rules` — then re-verify live via MCP
> (`firebase_get_security_rules`), not the deploy log. Deploy is human-only by protocol.

## Known pending deploys from memory — now RESOLVED as already-live

The 06-27 memory listed recurrence multi-week, badge thresholds, and VERY_LOW retirement as
"deploy PENDING". Live functions (21/21) and indexes (12/12) now match the repo, so those
function/index changes **are deployed**. Only the `calendar_requests` rule pin above remains.

## Local snapshot (what SHOULD be live)

- **firestore.rules** — 688 lines. **storage.rules** — 39 lines.
- **firestore.indexes.json** — 12 composite indexes: tasks ×5 (teamManagerIds CONTAINS
  + createdAt/status/updatedAt; assignedUserId + status/updatedAt), archived_tasks ×3,
  work_sessions ×2, break_sessions ×2 (each: teamManagerIds+date, userId+date).
- **functions/index.js** — 21 exports: push notifiers (request_notifications,
  calendar_requests, pending signup, overdue tasks), attachment cleanup ×3, badge awards ×3,
  team-stamp writers ×4 + restamp + backfill callable, `dailyIntegrityScan` (which invokes
  the internal `autoStopForgottenTimers` — task timers only, by design note at
  functions/index.js:1222), `generateRecurringTasks` + `runRecurringTasksNow`,
  `escalateTaskPriorities`, `parseTaskDraft`.

## Known pending deploys (from memory/decisions — could not be re-confirmed live)

- 🟠 `firestore.rules`: calendar_requests userId-pin + work_hours `overseesUser` (from the
  2026-06-27 sweep, `95e02be`) — recorded as NOT deployed.
- 🟠 Functions: recurrence multi-week `interval`/`anchorDate` (`d67d1f1`) and badge
  threshold recalibration (`304e220`) — recorded as deploy PENDING.
- 🟠 Rules+functions: priority VERY_LOW retirement (`a0c3d11`) — recorded as deploy PENDING.

If those are still undeployed, prod runs old logic for each — a latent drift, not visible
to this sweep until re-auth. **Re-verify via MCP after `--reauth`, never trust the deploy log.**
