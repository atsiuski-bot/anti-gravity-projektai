# Full Sweep — Synthesis & prioritized fix list

**Date:** 2026-06-21 · **Branch:** `claude/frosty-blackburn-86376b` · **HEAD:**
`22e34e9` · **Duration:** ~28 min (11:57Z → 12:25Z)

---

## ✅ FIXES APPLIED (2026-06-21, same session)

All findings below were subsequently fixed in the working tree (read-only sweep → fix pass).
**Gate: `npm run lint` clean · `npm run build` succeeds · `firestore.rules` validates.** No
automated tests exist, so behaviour is not test-verified; **rules are NOT deployed** (deploy
is human-initiated). 21 files changed + 1 new hook (`useOrphanedTaskRecovery`).

- **🔴 C1–C3 (rules authorization):** `firestore.rules` rewritten — per-document **write**
  ownership (owner field + manager/admin escape) on every per-user collection; reads kept
  **team-wide by design** (the Reports tab + team calendar query collection-wide and filter
  client-side — scoping reads broke them, so writes are scoped instead, which is where the
  tampering threat actually lives); worker self-confirmation blocked on UPDATE; disabled user
  can no longer read other users; `sessions` rule added; unused `shift_logs`/`daily_stats`
  locked; `deleted_tasks` read kept (still listened to). Manager escapes added for task
  **restore** and the approval **audit log**.
- **🔴 C4–C6 + 🟠 time/crash:** shared `clampSessionMinutes` (reject negative skew, cap at
  16 h) applied to every credited-time path (`timeUtils`, `pauseTask`, `endSession`, partial,
  legacy, **and** the Finish path); new `useOrphanedTaskRecovery` auto-pauses a task left
  running across a restart; `pauseTask` got an in-flight guard so recovery + the limit monitor
  can't double-log; swallowed `sessionActions` catches routed to `logError`.
- **🟠 timezone:** archive cutoff + deadline promotion now use Vilnius time; DailyStatistics
  break query uses the `date` field (no new composite index).
- **🟠 deps + 🟡 docs/perf:** `firebase-admin` → `devDependencies`; `DEPLOY_FIRESTORE_RULES.md`
  rewritten to the real model; `calendar-vendor` / `date-vendor` chunk split (the 413 KB
  popup chunk → 220 KB, calendar isolated).
- **🟡 design-system (×11):** 9 component files — colours sourced from `SESSION_COLORS`, raw
  hex/off-ladder z-index → tokens, raw `<button>`s → canonical `Button` (added a `success`
  variant). Modals: **token-only** fix; full canonical-`Modal` migration deferred.

**Adversarial verification caught real regression classes** the gates could not (Firestore
rules are not row filters — a collection-wide query returning one unreadable row fails wholly):
the first rules draft broke the worker Reports/team-calendar reads + `calendar_requests` and
task restore; a recon claim that `deleted_tasks` was unused was wrong (it is live-listened). A
final debug pass then caught that **`Dashboard.jsx` ran the team-wide daily automation with no
role gate** — correct now that the rules deny a worker writing other users' tasks, it would
permission-fail for a worker AND burn the once-per-day localStorage flag, suppressing the
manager's run; fixed by gating on manager role (matching `Layout.jsx`). All fixed and re-verified
(lint · build · `npm test` 31 green).

**Deferred (deliberate, flagged):** full canonical-`Modal` migration of `TaskModal`/
`DetailsModal` (needs on-device UI verification); deeper lazy-load of the calendar views (the
residual 220 KB app chunk); React 19 / Firebase 12 / react-router 7 **major** bumps (separate
tested migration; the worktree resolves `node_modules` from the parent, so a version bump here
would not even take effect); per-user **read** isolation (a product decision — would require
filtering the Reports/calendar queries by uid for workers).

**Test coverage — now bootstrapped (2026-06-21).** Vitest added; 31 tests pin the pure
time-math + timezone logic the fix pass changed (`timeUtils` + `automationUtils` buckets/
cutoff), `npm test` green alongside lint/build. The 🟠 zero-coverage finding is no longer
absolute — the highest-risk pure math is guarded; the session lifecycle, crash log, and
component behavior remain uncovered (next increments).

---

## Verdict

> **AUDIT FAIL — 6 critical (🔴) findings.** All six are server-trust gaps: three are
> Firestore privilege-escalation holes (any active worker can mutate/approve other workers'
> data), three are time-integrity / crash vectors that silently corrupt the **hours people
> are paid for**. None block the build (lint ✅, build ✅), so they ship today — they are
> correctness/security debt, not a broken pipeline.

**Severity mapping note.** The reasoning track labels findings high/medium/low on its *own*
finder scale; this synthesis re-maps every finding onto the §5 sweep rubric (🔴 = breaks
prod / data-loss / privilege escalation · 🟠 = contract drift, missing index/rule, build/
lint/dep failure · 🟡 = pattern violation, doc/perf/a11y smell · ℹ️ = baseline). That is why
several finder-"high" design-system items land at 🟡 here — a bespoke modal is a conformance
smell, not a prod-breaker.

## Totals (deduped across both tracks)

| Severity | Count | Source |
|---|---|---|
| 🔴 Critical | **6** | reasoning (verified) + 0 deterministic |
| 🟠 Likely | **13** | reasoning 7 · deterministic 6 |
| 🟡 Risk | **16** | reasoning 13 · deterministic 3 |
| ℹ️ Info | several | both tracks (baselines) |

Reasoning cost (measured): find **127k** · verify **410k** · **total 537k** output tokens
(131 subagents, ~23 min). False positives filtered by adversarial verify: **13**.

---

## 🔴 Critical (6) — fix first

| # | Finding | File | Effort |
|---|---|---|---|
| C1 | **Lateral read/write across all 12 per-user collections — no ownership scope.** Any active worker can read/write/delete any other worker's tasks, sessions, work_hours, logs. | `firestore.rules:59-116` | **L** |
| C2 | **Worker can self-approve `work_hours`** — auto-approve gated only by client-side `isManagerRole()`; flat rule lets a direct SDK write bypass it. | `firestore.rules:84-86` + `WorkPlanner.jsx:495-536` | **M** |
| C3 | **Worker can self-confirm any task as a manager** — `status:'confirmed'`/`isApproved` written client-side; no field-level rule constraint. | `firestore.rules:59-61` + `taskCompletionActions.js` | **M** |
| C4 | **`endSession` writes negative `durationMinutes` on clock skew** — no `>= 0` guard (which `pauseTask` has); a backward clock permanently corrupts the `work_sessions` log row + break totals. | `sessionActions.js:209-211` | **S** |
| C5 | **No crash/reload recovery → ghost time** — a task left `running` after a crash credits the entire offline interval as work on the next Pause (09:00 crash → 17:00 reload = 8 ghost hours). | `timeUtils.js:70-80` | **M** |
| C6 | **`pauseTask` failure during `startSession` silently swallowed** — task stays `running` with stale `timerStartedAt`; the break interval later gets credited as work; failure never reaches `logError`. | `sessionActions.js:50-54` | **S** |

**C1–C3 are one root cause:** authorization is enforced in the React client but **not** in
the security rules, so the rules are the real boundary and they are wide open. Fixing C1
(per-document ownership predicates + a manager/admin escape, keyed on the `userId`/
`assignedUserId` each collection already stores) largely subsumes C2/C3; C2/C3 then need
field-level constraints on the approval fields. **Verify each collection actually carries an
owner field before tightening** — a rule referencing a missing field locks users out.

**C4–C6 are the time-integrity core:** the product exists to count paid hours, and these
three let a clock skew, a crash, or a swallowed write corrupt that count with no durable
trace. C4 is a one-line guard; C6 is "stop swallowing + `logError`"; C5 needs a small
on-load reconciliation (detect stale `running` + old `timerStartedAt`, auto-pause, cap the
credited elapsed). There are **no tests** guarding any of this (🟠 below).

---

## 🟠 Likely (13)

**Reasoning track (7):**
- **Disabled user can read the entire `users` collection** — `/users` read gated on
  `isAuthenticated()` not `isUserActive()`; a just-disabled account keeps a token ~1 h.
  `firestore.rules:41-43` — **S** (swap the predicate).
- **03:00 archive cutoff uses browser-local `getHours()`** not Vilnius — off-TZ workers
  mis-archive by a day. `automationUtils.js:132-137` — **S**.
- **Stale `timerStartedAt` adds uncapped live elapsed** across devices → inflated totals +
  false auto-pause alarm. `timeUtils.js:70-82` — **S**.
- **`DailyStatistics` queries `break_sessions` by naive ISO `startTime` range** → post-
  midnight Vilnius breaks vanish; should use the `date` field like `Reports.jsx`.
  `DailyStatistics.jsx:86-92` — **S**.
- **Deadline promotion compares local-midnight `Date`s, not Vilnius** → promotion fires a
  day late. `automationUtils.js:25-41` — **M**.
- **`startSession` catch never calls `logError`** → field failures invisible.
  `sessionActions.js:174-177` — **S**.
- **`endSession` catch swallows failure (no rethrow, no `logError`)** → session left in limbo
  silently. `sessionActions.js:365-367` — **S**.

**Deterministic track (6):**
- **Zero automated test coverage** — the C4–C6 / time-math logic is unguarded against
  regression. `04-tests.md` — **L** (stand up Vitest; pin the pure `timeUtils` functions
  first).
- **`firebase-admin` (server SDK) in production `dependencies`** — sole consumer is the
  one-off `fetch_task.cjs`; drags the **critical `protobufjs` RCE** + ~8 high advisories into
  the prod dependency set (tree-shaken from `dist/`, so not shipped, but real install/supply-
  chain surface). `package.json:16` — **S** (move to `devDependencies` or delete).
- **`react-router-dom` XSS-via-open-redirect advisory** — *does* ship in the client bundle;
  patched line is v7 (major). `package.json:21` — **M** (upgrade or prove redirect surface
  closed).
- **`vite` path-traversal advisory** — dev-server only (not the static deploy), but WORKZ
  runs `dev` with network host for phone testing. `package.json:36` — **S** (in-range bump).
- **`sessions` collection written with no matching rule** — `sessionActions.js:277` does
  `addDoc(collection(db,'sessions'), …)` but `firestore.rules` has only `work_sessions`/
  `break_sessions`; every write is Firestore default-denied (logged to `error_logs` via its
  `.catch`, but the legacy log doc is never persisted). Deterministically corroborated by
  grep. `firestore.rules` (missing) + `sessionActions.js:277` — **S** (add the rule or drop
  the legacy write). *This is the one `firebase-coupling` item confirmed despite that
  dimension being capped — see the coverage gap.*
- **`DEPLOY_FIRESTORE_RULES.md` describes a `users` read rule that isn't in the code** —
  doc claims own-doc-only read; `firestore.rules:43` is broad `isAuthenticated()`.
  `06-firebase.md` — **S** (reconcile doc ↔ rule).

---

## 🟡 Risk (16)

**Design-system discipline (reasoning, 11) — all map to 🟡 (conformance smells):**
- TaskModal bespoke full-screen dialog (`z-[100]`) instead of canonical `Modal`
  — `TaskModal.jsx:534` — **M**.
- `DetailsModal` bespoke shell (`z-50`) cascading to 4 children (Links/Comments/Description/
  TimeAdjustments) — `TaskDetailsModals.jsx:7-57` — **M**.
- **ActiveWorkSessions hard-codes the session palette** (not `SESSION_COLORS`) —
  `ActiveWorkSessions.jsx:46-94` — **S**. *(Dual-confirmed: discipline + session-color.)*
- **CombinedHoursSummary duplicates the palette with divergent values** (`orange`/`sky` vs
  the map) — `CombinedHoursSummary.jsx:201-243` — **S**. *(Dual-confirmed.)*
- `ImageLightbox` uses `z-[9999]`/`z-[10000]` + raw scrim + raw `<button>`s —
  `TaskDetailsModals.jsx:391-473` — **S**.
- `ManagerNotifications` action CTAs are raw `<button>`s duplicating `Button` —
  `ManagerNotifications.jsx:428-630` — **M**.
- CallTimer / QuickWorkTimer raw hex (`#e5e7eb`, `#000`) in inline styles —
  `CallTimer.jsx:59-63`, `QuickWorkTimer.jsx:61-65` — **S**.
- AllUsersCalendar raw hex `VACATION_COLOR` + grid color — `AllUsersCalendar.jsx:19,235` — **S**.
- DailyWorkProgress raw `bg-blue-500`/`bg-indigo-500` colorClass args —
  `DailyWorkProgress.jsx:195,238,246` — **S**.
- CallTimer active card mixes token surface with raw `blue-200/900` — `CallTimer.jsx:282` — **S**.

**Crash-safety (reasoning, 1):**
- Fire-and-forget task-pause failure not sent to `logError` — `sessionActions.js:54` — **S**.

**Deterministic (3):**
- **`TaskTimeLimitPopup` chunk is 413 KB raw / 115 KB gz** — largest app chunk, likely
  bundling `react-big-calendar`; within threshold but a code-split candidate.
  `05-build.md` — **M**.
- DEPLOY-doc drift (also listed 🟠 above for the security angle) — **S**.
- (Browserslist `caniuse-lite` ~6 mo stale — cosmetic.) — **S**.

---

## ℹ️ Info / baselines
- **Lint:** clean, 0 warnings (`--max-warnings 0` gate green).
- **Build:** exit 0, `dist/` 2.0 MB, PWA artifacts (manifest + sw.js + workbox) present/valid.
- **Major-version dep drift:** react 18→19, firebase 10→12, react-router-dom 6→7, etc. —
  plan as deliberate, separately-tested upgrades, not folded into a feature PR.
- **Firebase live-rules diff UNVERIFIED:** the Firebase MCP is bound to the GODSGLOOM project
  (`g-o-g-f1e67`), not WORKZ's `darbo-planavimas` — confirm live rules in the Console manually.

---

## ⚠️ Coverage gap — read before trusting completeness

The reasoning track found **104** issues but verified only **40** (`maxFindings=40` cap). The
40 verified came **only from the first 5 dimensions** (discipline, timetracking, crashsafety,
session-color, security). **Dimensions 6–11 were never verified:**

| Dimension | Status this run |
|---|---|
| `firebase-coupling` | ❌ unverified — only the `sessions`-no-rule item was caught (by grep). The full compound-query / `FAILED_PRECONDITION` index enumeration is **missing**. |
| `ux-a11y` | ❌ unverified — no WCAG / touch-target / table-on-phone scan landed. |
| `i18n-brand` | ❌ unverified — no Lithuanian-"Jūs" / English-leakage / retired-brand scan. |
| `perf` | ❌ unverified — **no `onSnapshot` listener-leak scan** (the highest-value perf check in an onSnapshot-heavy app). |
| `docsdrift` | ⚠️ partial — only the DEPLOY-doc drift (deterministic) was caught. |
| `deadcode` | ❌ unverified. |

**Recommended follow-up (NOT auto-run — cost discipline):** a single scoped re-run closes
the gap without re-paying for the 5 covered dimensions:

```
Workflow({ name: 'triage-sweep', args: {
  dimensions: ['firebase-coupling','ux-a11y','i18n-brand','perf','docsdrift','deadcode'],
  maxFindings: 40
}})
```

Budget it like this run's find+verify split (~50–60k tok/dimension verified). Until then,
treat those six dimensions as **unassessed**, not clean.

---

## Suggested order of attack

1. **C1–C3 (rules authorization)** — one rules pass; the largest blast radius (any worker can
   currently corrupt any other's data). Verify owner fields exist first.
2. **C4, C6** (S each) then **C5** (M) — close the hours-corruption vectors; cheap, high value.
3. **Stand up Vitest** and pin `timeUtils` + the C4–C6 paths *as you fix them* — converts the
   🟠 zero-coverage finding into a regression guard for the 🔴 fixes.
4. **`firebase-admin` → devDeps** (S) — clears the critical advisory from prod deps.
5. The 🟠 timezone/`logError` cluster (all S/M) — same files, batch them.
6. **Run the coverage-gap follow-up** before calling the codebase audited.
7. 🟡 design-system drift — a focused "route bespoke shells through `Modal`, source colors
   from `SESSION_COLORS`, kill raw hex" sweep; mechanical, batchable, lint-guardable later.

_The sweep changed nothing in the codebase. All findings live under
`docs/audits/full-sweep-2026-06-21/`._
