# Full Sweep — Synthesis — 2026-06-24

**Verdict:** ⚠️ **2 critical (🔴) findings — both crash-safety durable-trace/recovery gaps.**
Neither breaks the app today; both are silent-failure blind spots that hide data-integrity
problems in production. Everything else is green or polish.

- **Deterministic track:** ✅ all gates green (lint · functions-lint · build · 428 tests ·
  rules == live · 12/12 indexes deployed · 19/19 functions deployed). Only standing item is
  the known-accepted dev-only dependency-audit posture.
- **Reasoning track:** ⚠️ PARTIAL — 11 confirmed (2🔴 · 7🟠 · 2🟡); verify stage hit the
  session limit before `firebase-coupling` + `ux-a11y` could be verified. I refuted the 4
  firebase-coupling "missing-index" HIGH claims deterministically (all false); the 6 ux-a11y
  leads remain unverified polish items.

| Track | 🔴 | 🟠 | 🟡 | ℹ️ |
|---|---|---|---|---|
| Deterministic | 0 | 0 | 2 | 10 |
| Reasoning (confirmed) | 2 | 7 | 2 | — |
| Reasoning (unverified leads) | — | — | ~6 (ux-a11y) | 4 refuted (index) |
| **Net actionable** | **2** | **7** | **~6** | — |

Reasoning cost (measured output tokens): **find 152,541 · verify 300,960 · total 453,501**
(131 agents, 22m). Use this to size the next run.

---

## 🔴 Critical — fix first (2)

> Both are in the **crash-safety / durable-logging** invariant: a real failure happens with
> **no trace in the durable crash log** (30-entry localStorage ring buffer + remote
> `error_logs`). That's the exact blind spot the log exists to close, and the codebase has a
> *deliberately-applied* `logError` pattern these two sites simply missed.

| # | Where | Problem | Fix | Effort |
|---|---|---|---|---|
| **C1** | `sessionActions.js:481-483` | `endLegacySession` catch is `console.error`-only — a failed *critical* flag-clearing write leaves the user stuck **and** unlogged. Twin main-path catch was already upgraded to `logError`; this is the lone holdout. | `logError(err, { source:'endLegacySession', userId, sessionType })` | **S** |
| **C2** | `WorkerView.jsx:64-68` ↔ `ManagerView.jsx` | Orphan-recovery hooks mount only in `WorkerView`; managers run quickWork/call/break too → a manager crash/reload leaves a `running` timer uncleared → **ghost time, no recovery notice**. | Mount both recovery hooks in `ManagerView`, or hoist to `Layout` so every role gets recovery | **S–M** |

---

## 🟠 Likely — fix this pass (7)

> Two clusters: **(a) more swallowed-failure logging gaps** (same family as C1) and **(b)
> Vilnius-vs-UTC date-boundary drift in Reports**, plus **canonical-component discipline**.

### Cluster A — swallowed failures (durable-log gaps)
| # | Where | Problem | Fix | Effort |
|---|---|---|---|---|
| **M3** | `taskActions.js:27-29` | `updateUserWorkStatus` failure → `console.error` only; user-doc/task-doc go silently inconsistent, invisible in `error_logs` | route catch through `logError` | **S** |
| **M4** | `sessionActions.js:376-378` | `doResume` race-guard `getDoc` failure **proceeds anyway** (resumes the wrong task on a rapid re-start), logged only `console.warn` | fail-safe (don't resume) + `logError` | **S–M** |

### Cluster B — Reports date boundaries (Vilnius vs UTC vs browser-local)
| # | Where | Problem | Fix | Effort |
|---|---|---|---|---|
| **M1** | `Reports.jsx:426-428` | `end.setHours(23,59,59)` uses **browser-local** tz; near the `endDate` boundary tasks are wrongly in/excluded | build both boundaries from the Vilnius day via the existing `getLithuanian*` helpers | **M** |
| **M2** | `Reports.jsx:625-629` | grouped-view date key = raw **UTC** date (`split('T')[0]`); 00:00–03:00 Vilnius tasks group to the wrong day, disagreeing with `DailyStatistics` 03:00 boundary | key by `getLithuanianDateString(...)` | **S** |

### Cluster C — canonical components / token discipline
| # | Where | Problem | Fix | Effort |
|---|---|---|---|---|
| **M5 + M7** | `TaskTimeLimitPopup.jsx:51,94-108` | bespoke `<button>`s + raw `bg-red-600/700` instead of `Button variant="danger"` / `feedback-danger` tokens *(M5 and M7 are the same component — fix together)* | swap to canonical `Button` + danger tokens | **S** |
| **M6** | `BreakTimer.jsx:102-122` (+ `CallTimer`, `QuickWorkTimer`) | three timer components hand-roll the session-toggle button because `Button` lacks a session-active-ring variant | add the variant to `Button`, migrate all three (kills the duplication at the root) | **M** |

---

## 🟡 Risk — opportunistic (≈6 confirmed/near + unverified ux-a11y)

| # | Where | Problem | Fix | Effort |
|---|---|---|---|---|
| **L1** | `QuickWorkDescribePrompt.jsx:40` | raw `border-red-200` vs `border-session-quickWork-soft` (sibling uses the token) | swap token | **S** |
| **L2** | `firestore.rules:474-479` | `error_logs` create has no field shape/size guard — floodable, can inject long strings into manager-visible reports | add permissive `size()` clamps (mirror `request_notifications`); **rules deploy = human-only** | **S–M** |
| **D1** | tests | timer/session **crash-recovery** paths covered only indirectly | add a direct orphan-recovery + `errorLog` ring-buffer unit test (pairs well with C1/C2) | **M** |
| **UX (6)** | `ActiveWorkSessions`, `ManagerNotifications`, `DailyStatistics` ×2, `TaskDetailsModals`, `AllUsersCalendar` | `text-xs`+`opacity-70/80` contrast & a self-documented **42px** (2px-short) tap target — **unverified leads**, code patterns confirmed present | self-contained a11y polish pass; the AllUsersCalendar fix is one char (`-inset-y-[9px]`→`[10px]`) | **S–M** |

---

## ℹ️ Cleared / accepted (no action)

- **All quality gates green** — lint (root + functions), build, **428/428 vitest**, rules
  byte-identical to live, 12/12 indexes `READY`, 19/19 functions deployed. See `02`/`04`/`05`/`06`.
- **Dependency audit (🟡, accepted):** 7 root + 9 functions **moderate**, **0 high/critical**,
  prod tree clean. All dev-only or official-SDK-transitive (`firebase-admin`/`firebase-functions`
  → `uuid`/`gaxios`); npm's only "fix" is a major downgrade. **Do not `audit fix --force`.** See `19`.
- **4 firebase-coupling "missing index" HIGH claims → REFUTED** (deterministic Firestore-index
  rules; the queries run in live prod daily). See `00-reasoning-confirmed.md` § Unverified leads.
- **Framework majors held deliberately** (React 19, firebase 12, tailwind 4, vite 8, eslint 10).
- Orphan locked rules (`shift_logs`, `daily_stats`) are intentional `if false` placeholders.

---

## Recommended sequencing

1. **One small crash-safety PR** — C1 + C2 + M3 + M4 (all the `logError`/recovery gaps; same
   invariant, same file family) + the D1 test. Highest value, lowest risk, ships client-only.
2. **One Reports date-boundary PR** — M1 + M2 (both Vilnius-day fixes; verify against
   `DailyStatistics`' 03:00 boundary).
3. **One UI-discipline PR** — M5/M7 + M6 + L1 (canonical `Button` + session tokens; add the
   `Button` session-active variant once, reuse).
4. **Defer:** L2 (needs a human rules deploy) and the ux-a11y polish set (re-verify after the
   session limit resets, or hand-check contrast).

> **The sweep changed nothing** — read-only. All paths above are proposals, not applied edits.
> Verdict per §5 rubric: **🔴 > 0 → "AUDIT FAIL — 2 critical findings"** (i.e. 2 items flagged
> as needing attention before the next large feature series; the app is not broken today).
