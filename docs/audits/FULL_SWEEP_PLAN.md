# WORKZ — Full-Project Debug Sweep Plan

> **Goal:** a whole-project, autonomous, multi-phase audit chain the main agent can
> launch with one trigger (`/full-debug-sweep`) and leave running. On completion it
> produces one prioritized report at `docs/audits/full-sweep-<DATE>/00-SYNTHESIS.md`,
> findings ranked by severity, with a follow-up plan.
>
> This document is the **durable specification** — `/full-debug-sweep` reads it as the
> step list, and `triage-sweep`'s inline dimension prompts are the condensed form of the
> reasoning phases here. Changing the plan ≡ changing behaviour — edit it here, not ad hoc.

> **Status:** Ported from the GODSGLOOM `/full-debug-sweep` (2026-06-21), adapted to the
> WORKZ stack (React 18 + Vite + Tailwind + Firebase PWA, JavaScript, no TypeScript;
> a Vitest suite, a `functions/` Cloud Functions subtree, and `firestore.indexes.json`
> are all present). First execution pending a user trigger.

---

## CONTENTS

1. [Goal, non-goals, principles](#1-goal-non-goals-principles)
2. [Architecture & orchestration](#2-architecture--orchestration)
3. [Output structure & resume protocol](#3-output-structure--resume-protocol)
4. [Pre-flight: environment guards](#4-pre-flight-environment-guards)
5. [Severity rubric](#5-severity-rubric)
6. [Deterministic track](#6-deterministic-track)
7. [Reasoning track — the 11 dimensions](#7-reasoning-track--the-11-dimensions)
8. [Synthesis & prioritized report](#8-synthesis--prioritized-report)
9. [Failure handling & resume](#9-failure-handling--resume)
10. [What this plan does NOT do](#10-what-this-plan-does-not-do)

---

## 1. Goal, non-goals, principles

### Goal
- **Full-project** sweep (NOT diff-scoped) — walk the whole tracked tree and check:
  does the code honour the project invariants, does the Firebase coupling have silent
  drift, does the quality gate pass, is the documentation stale, is the time-tracking
  math sound.
- **Autonomous** — no `AskUserQuestion`, no "press agree". Every choice is made by the
  rules written here. If a phase would require a destructive action (overwriting an
  existing file, a prod write, a force push) — the phase is **SKIPPED**, not performed.
- **Aggregated output** — all findings roll up into one `00-SYNTHESIS.md` with a
  prioritized fix list. The main agent reads only the summary files, not raw output.

### Non-goals
- **NO fix loop** — `/full-debug-sweep` finds problems, it does not fix them.
- **NO pre-ship gate** — this is housekeeping, run on its own cadence (every 2–4 weeks
  or before a large feature series), not a `/ship` prerequisite.
- **NO prod write** — no Firestore write (even audited), no Firebase deploy, no `gh pr`.
  All writes are local findings files under `docs/audits/full-sweep-<DATE>/`.
- **NO git mutate** — no commit, push, or branch checkout. The sweep runs in the current
  worktree state.

### Principles
1. **Read-only.** All phases use Read, Grep, Glob, Bash (read commands), Agent, Workflow.
   No Edit/Write except findings files; no `gh`; no `firebase deploy`.
2. **Subagent-first orchestration.** The reasoning track is delegated to the
   `triage-sweep` Workflow so the main context is never flooded with raw finder output.
3. **Fail-soft per phase.** If a phase breaks (e.g. `npm run build` exits 1), it does NOT
   stop the sweep. The phase is marked `⚠️ PARTIAL` with an error excerpt and the rest
   continues.
4. **Idempotent rerun.** If the sweep is interrupted, re-run with the same
   `--date=YYYY-MM-DD` and it skips phases whose output files already exist (see §9).
5. **Severity, not effort.** A finding says "what breaks / is wrong", not "how much work
   to fix". Effort estimation is a synthesis-stage tag.

---

## 2. Architecture & orchestration

```
┌─────────────────────────────────────────────────────────────┐
│  MAIN AGENT (orchestrator)                                  │
│  - reads FULL_SWEEP_PLAN.md (this file)                     │
│  - creates docs/audits/full-sweep-<DATE>/                   │
│  - runs the deterministic track (sequential Bash)          │
│  - delegates the reasoning track to triage-sweep Workflow  │
│  - aggregates summaries into 00-SYNTHESIS.md               │
└─────────────────────────────────────────────────────────────┘
            │
            ├─ Deterministic ─→ Bash(npm run lint)   → 02-lint.md
            │                   Bash(npm run build)  → 05-build.md
            │                   Bash(npm outdated)   → 19-deps.md
            │                   rules diff           → 06-firebase.md
            │                   Bash(npm test)       → 04-tests.md (vitest run)
            │
            └─ Reasoning  ─→ Workflow({name:'triage-sweep'})
                              ├─ Find:  one Explore finder per dimension (Sonnet)
                              ├─ dedup by file:line:title
                              └─ Verify: N skeptics per finding (Opus, majority rules)
                                    → 00-reasoning-confirmed.md
```

### Why the two tracks
Deterministic gates (lint, build, deps, rules diff) have no LLM value — run and parse.
The reasoning dimensions need judgement, so they go through `triage-sweep`, whose
adversarial-verify stage filters false positives and runs in parallel.

### Why WORKZ's track list differs from a TypeScript repo's
WORKZ has **no TypeScript** (no `tsc` phase) and **no RTDB**. It *does* have a **Vitest
suite** (the `04-tests` phase runs it), a **`functions/` Cloud Functions subtree** (lint +
deploy-state checks), and a **`firestore.indexes.json`** (its drift against the live
indexes is a coupling risk the `firebase-coupling` dimension hunts).

---

## 3. Output structure & resume protocol

### Folder structure

```
docs/audits/full-sweep-2026-06-21/
├── README.md                      # invocation metadata (date, git sha, env)
├── 02-lint.md                     # + 02-lint-raw.txt
├── 04-tests.md                    # zero-coverage standing finding
├── 05-build.md                    # + 05-build-stats.json (vite manifest)
├── 06-firebase.md                 # firestore.rules + storage.rules diff
├── 19-deps.md                     # npm outdated / npm audit
├── 00-reasoning-confirmed.md      # triage-sweep confirmed findings
└── 00-SYNTHESIS.md                # final aggregated report
```

### `README.md` (invocation metadata)

```markdown
# Full Sweep — 2026-06-21

- **Git SHA:** <commit hash at start>
- **Branch:** claude/<worktree-name>
- **Worktree:** <full path>
- **Node / npm:** <node -v> / <npm -v>
- **Vite:** <from package.json>
- **OS:** Windows 11 / PowerShell
- **Started:** <ISO ts>
- **Finished:** <set by synthesis>
- **Reasoning cost (measured):** find <tok> · verify <tok> · total <tok>
- **Total findings:** 🔴 X · 🟠 Y · 🟡 Z · ℹ️ W
```

### Per-phase summary file format

Every `NN-name.md` follows this template:

```markdown
# Phase NN — <Name>

**Status:** ✅ COMPLETE  /  ⚠️ PARTIAL  /  ❌ FAILED  /  ⏭️ SKIPPED
**Findings:** 🔴 X · 🟠 Y · 🟡 Z · ℹ️ W

## Method
<1–3 sentences: which tools/patterns, what was checked>

## Findings
### 🔴 Critical
- `<file:line>` — <what breaks> — WHY: <reason> — FIX: <remediation>
### 🟠 Likely
### 🟡 Risk
### ℹ️ Info
```

### Resume protocol

If the orchestrator stops, restart with `--date=2026-06-21 --resume`:
1. Read the README → grab started ts + git SHA.
2. Check **current HEAD == started SHA**. If NOT → ABORT ("code changed since the sweep
   started; continuing would corrupt the report"). Tell the user to check out that SHA or
   start a fresh sweep.
3. For each phase — if its file exists AND has `Status: ✅ COMPLETE` → SKIP, else rerun.
4. When all phases are done — run synthesis.

---

## 4. Pre-flight: environment guards

The main agent runs these before any phase. If one fails → STOP and report.

### 4.1 Worktree guard
```bash
git rev-parse --show-toplevel
git branch --show-current
```
- branch == `main` → **STOP** ("do not sweep from main; create a worktree first").
- branch not starting with `claude/` → **WARN** and continue (custom branch).

### 4.2 Output dir / resume
```bash
DATE=$(date -u +%Y-%m-%d)
mkdir -p docs/audits/full-sweep-$DATE
```
If the dir already exists and no `--date=` was passed → RESUME mode (§3).

### 4.3 Git status snapshot
```bash
git status --porcelain
git rev-parse HEAD
```
Record HEAD SHA in the README; the resume protocol checks it has not changed.

> No `.env` guard is needed — WORKZ has no test runner, so there is no test-env Firebase
> collision. Leave `.env` in place.

---

## 5. Severity rubric

One rubric for every phase:

| Level | Meaning | Example |
|---|---|---|
| 🔴 **Critical** | Breaks prod / data-loss vector / privilege escalation | Client writes the `sessions` collection that has no rule (default-deny silent loss); a Firestore rule lets any active worker mutate another user's tasks; orphaned timer credits hours of ghost time on the next pause |
| 🟠 **Likely** | Contract drift, missing index, build/lint failure | A compound query with no `firestore.indexes.json` entry (FAILED_PRECONDITION at runtime); an `onSnapshot` with no `unsubscribe()` cleanup; a lint warning (CI fails on any) |
| 🟡 **Risk** | Pattern violation, doc drift, perf or a11y smell | Raw hex / `text-[10px]` / `z-[9999]` in a component instead of a token; `bg-sky-*` for the call state instead of the `SESSION_COLORS` map; a touch target under 44 px |
| ℹ️ **Info** | Baseline metric, SKIP reason, intentional pattern | LOC count; "Phase X skipped: dev server not available"; "match is in a comment, not live code" |

Synthesis verdict: `total 🔴 == 0` → "Audit clean"; `🔴 > 0` → "AUDIT FAIL — N critical
findings", with the 🔴 list first.

---

## 6. Deterministic track

Sequential, Bash, fail-soft per step. Bash gate commands are **not** parallelized
(they share `node_modules`).

### 6.1 Lint → `02-lint.md` (+ `02-lint-raw.txt`)
- `npm run lint 2>&1 | tee docs/audits/full-sweep-$DATE/02-lint-raw.txt`
- The script is `eslint . --ext js,jsx --report-unused-disable-directives --max-warnings 0`.
  Any warning fails CI → every warning is 🟠, every error 🟠/🔴 by location.
- If eslint itself crashes (bad config / missing plugin) → 🔴 "lint config broken — CI
  fail vector".

### 6.2 Build → `05-build.md` (+ `05-build-stats.json`)
- `npm run build 2>&1 | tee build-raw.txt` (`vite build` → `dist/`).
- Exit non-zero → 🔴 "build broken".
- Copy `dist/.vite/manifest.json` → `05-build-stats.json`. Flag: vendor chunk
  > 500 KB gz → 🟠; total `dist/` > 10 MB → 🟡 (PWA precache bloat); any single asset
  > 500 KB → 🟡 (unoptimized image).
- PWA: confirm `dist/manifest.webmanifest` (name, icons 192+512, start_url, display) and
  a service worker artifact exist.

### 6.3 Deps → `19-deps.md`
- `npm outdated` and `npm audit --json`. (Single root `package.json` — no `functions/`.)
- Each high/critical advisory → 🟠. Major version drift on `firebase` / `react` → ℹ️ +
  note migration risk.

### 6.4 Firebase rules diff → `06-firebase.md`
- WORKZ persists only `firestore.rules` and `storage.rules` (no `firestore.indexes.json`,
  no Cloud Functions).
- Confirm the local rules are deployed: `DEPLOY_FIRESTORE_RULES.md` notes a manual deploy
  may be pending — the live rules may be ahead of or behind the repo. If the Firebase MCP
  is available, read live rules (`firestore_get_security_rules`) and diff; otherwise mark
  ℹ️ "deploy state unverifiable from repo".
- Deterministic facts only here (rule presence, obvious `if true`); the privilege-
  escalation *reasoning* belongs to the `security` and `firebase-coupling` dimensions.

### 6.5 Test-coverage gate → `04-tests.md`
- There is no test script and no test files in WORKZ. Record a standing finding:
  🟠 "Zero automated test coverage — the time-tracking, session lifecycle, and
  crash-safety logic (`timeUtils.js`, `sessionActions.js`, `taskActions.js`,
  `errorLog.js`) is unguarded against regression." This is a finding, not a skipped step.

---

## 7. Reasoning track — the 11 dimensions

Delegated to `Workflow({ name: 'triage-sweep' })`. Each dimension is one read-only finder
(Sonnet) → dedup → N skeptics verify (Opus, strict majority). The checklists below are the
long-form reference; the workflow's inline prompts are the condensed form. To preview
cheaply: `Workflow({ name: 'triage-sweep', args: { findOnly: true } })`.

### 7.1 discipline
Convention violations from CLAUDE.md + DESIGN_SYSTEM.md:
- Bespoke modal/button/card shells instead of the canonical set in `src/components/ui/`
  (`Button`, `IconButton`, `Card`, `Modal`, `ConfirmDialog`, `StatusPill`, `EmptyState`,
  `Loading`).
- Any live `window.confirm` / `window.alert` in a UI flow (must be `ConfirmDialog`).
- Firestore/Auth/Storage instances obtained anywhere but the `src/firebase.js` wrapper
  (importing `db`/`auth`/`storage` directly from `firebase/*`). Importing stateless SDK
  helpers (`collection`, `doc`, `onSnapshot`, …) from `firebase/firestore` is fine.
- A session palette duplicated instead of read from `src/utils/sessionColors.js`
  (`SESSION_COLORS`) — e.g. `bg-sky-*` for the call state.
- Raw hex / arbitrary `text-[Npx]` / unmanaged `z-[NNNN]` literals in components instead
  of design tokens.
- Raw `err.message` embedded in a user-facing string instead of mapped Lithuanian copy.

### 7.2 timetracking (the heart of WORKZ)
Hunt in `src/utils/timeUtils.js`, `sessionActions.js`, `taskActions.js`,
`automationUtils.js`, `calendarNotifications.js` and the timer hooks:
- Wall-clock deltas (`now - timerStartedAt`, `now - session.startTime`) that go negative
  or silently discard elapsed on device-clock skew.
- Double-counting across `manualMinutes` / `timerMinutes` / the
  `parseTimeStringToMinutes(actualTime)` fallback in `calculateCurrentTotalMinutes`.
- `durationMinutes` computed once at write time, never sanity-capped (a skewed value is
  permanent in the log).
- Europe/Vilnius vs UTC vs local-browser timezone mismatches: the 03:00 archive cutoff,
  the week boundary in `calendarNotifications`, deadline promotion in `automationUtils`,
  and the report date filters.
- Report aggregation in `Reports.jsx` double-counting interrupted quick-work/call partial
  segments against the full-duration log doc.

### 7.3 crashsafety
`errorLog.js` is the durable crash log (localStorage ring buffer `workz_error_log`
capped at 30 + fire-and-forget Firestore `error_logs`). Hunt:
- A running task/session left orphaned after reload or crash (`timerStatus:"running"` +
  stale `timerStartedAt`) with no automatic recovery → next `pauseTask` credits ghost time.
- Fire-and-forget Firestore writes whose failures are swallowed (`.catch` that only logs)
  → silent data loss.
- Throw paths in `startSession` / `startTask` / `resumeTask` that never reach `logError`
  or the global `unhandledrejection` handler.
- The single-level `pausedSession` nesting being overwritten on a second interruption.

### 7.4 session-color
The signature whole-screen session color (DESIGN_SYSTEM §2 Principle 1, §4 Rules A–D):
- **Rule A:** a colored session shell must always be paired with a persistent text label
  + icon (color is never the sole signal, WCAG 1.4.1).
- **Rule B:** every session color reads from the single `SESSION_COLORS` map; no drift.
- **Rule C:** full-saturation red is reserved for the quick-work state — the offline
  banner must use the neutral `feedback.offline` slate, not red.
- **Rule D:** body text/controls sit on a white `surface` card, not directly on the
  saturated shell. The no-session state uses `IDLE_SHELL`.

### 7.5 security
- `firestore.rules`: collections with `allow read, write: if isUserActive()` and no
  per-document ownership scope (any active worker can mutate any other user's
  tasks/sessions/work_hours/calendar entries).
- The `users` read gated only by `isAuthenticated()` (not `isUserActive()`) → a disabled
  user can still read all records.
- Any recursive `=**` wildcard or `if true`.
- `storage.rules`: over-broad paths; client input reaching a write unvalidated.
- Worker-vs-manager authorization enforced only client-side with no matching rule.
- Hardcoded secrets committed to git (the `src/firebase.js` fallback config / API key).

### 7.6 firebase-coupling
- A collection the client reads/writes that has **no matching rule** → default-deny at
  runtime (known live example: the `sessions` collection written in `sessionActions.js`
  with no rule, error swallowed = silent loss). Find every such gap.
- A rule for a collection the client never touches (orphan: `shift_logs`, `daily_stats`).
- There is **no `firestore.indexes.json`**, so every compound query (`where` + `orderBy`
  on different fields, multiple `where`, or `where(...,"in",...)`) is a FAILED_PRECONDITION
  risk — enumerate them with file:line.
- A Storage `ref(...)` path with no matching `storage.rules` entry.

### 7.7 ux-a11y
Against DESIGN_SYSTEM §7 (WCAG 2.1 AA) and §9 (dual density):
- Clickable non-semantic `<div>`/`<span>` with `onClick` but no `role` + keyboard handler.
- Icon-only buttons / `IconButton` with no `aria-label` (`title=` alone fails on touch).
- Interactive controls under 44 px (`p-1.5` ~28 px, `p-0.5` ~20 px instead of
  `min-h-touch` / `min-w-touch`).
- Readable text below 12 px (`text-[8px]`..`text-[11px]`).
- Interactive elements with no `focus-visible` ring; no `prefers-reduced-motion` handling.
- Text-on-colored-shell contrast below 4.5:1.
- On phones, a dense horizontally-scrolling table shown to a worker instead of cards —
  `UserManagement`, multi-user `Reports`, `TaskHistory`, `MonthlyHours`, and the
  calendar-history table must each have a mobile card fallback.

### 7.8 i18n-brand
- User-facing strings (buttons, toasts, error banners, aria-labels, modal titles,
  empty/loading states, placeholders) that are English or informal instead of Lithuanian
  formal "Jūs". **English leakage in UI copy is the violation** (the inverse of an
  English-only repo — persisted artifacts are English, UI copy is Lithuanian).
- Raw `err.message` rendered to a user instead of mapped friendly Lithuanian copy.
- The retired brand name `Viduramžiai` / `Viduramžiai.LT` in user-facing `src/` or
  `index.html` (allowed only as documentary prose in `docs/`, `CLAUDE.md`, `AGENTS.md`).

### 7.9 perf
WORKZ is `onSnapshot`-heavy:
- Every `onSnapshot` in a `useEffect` MUST return its `unsubscribe()` in cleanup — a
  missing cleanup is a listener + memory + Firestore-read-cost leak (🔴/🟠).
- Expensive work in render without `useMemo`/`useCallback`; dynamic lists keyed by index
  or unkeyed; N+1 Firestore reads inside a loop/map; unbounded queries with no `limit()`;
  stacked `setInterval` timers or heavy synchronous work on the main thread.

### 7.10 docsdrift
Claims in `docs/` (`decisions-log.md`, `design/DESIGN_SYSTEM.md`, `design/tokens.md`,
`adr/*`), `README.md`, `AGENTS.md`, `CLAUDE.md`, `DEPLOY_FIRESTORE_RULES.md` that no
longer match source — file:line refs, default values, component/util names, flow
descriptions, and stale status notes (known example: `tokens.md` says the token config is
"Proposed (config not yet wired)" while `tailwind.config.js` is fully wired).

### 7.11 deadcode
Exported symbols with no importers; orphaned files; large commented-out blocks; legacy
fields/flags with no live consumers (e.g. legacy `workStatus` / `breakState` /
`callState` / `quickWorkState` paths if truly superseded by `activeSession`); unreachable
branches; orphan `firestore.rules` entries for unused collections.

---

## 8. Synthesis & prioritized report

Aggregate the deterministic findings + the triage-sweep `confirmed` findings into
`00-SYNTHESIS.md`:
- Group by severity, dedup across tracks, tag each with an effort estimate (S/M/L).
- Lead with the 🔴 list; verdict per §5.
- Record the measured reasoning cost (`tokens.{find,verify,total}`) so the next run is
  sized from real numbers.
- Update the README with finished ts + totals.

---

## 9. Failure handling & resume

- **Per-phase fail-soft:** a broken step is `⚠️ PARTIAL` with an error excerpt; the sweep
  continues.
- **Interrupted run:** resume with `--date=YYYY-MM-DD`; re-check HEAD == started SHA
  (abort if changed), then skip phases whose files are `✅ COMPLETE`.
- **Reasoning track:** run `triage-sweep` once (all dimensions, verified). Use `findOnly`
  for a preview; never loop it. If the result was capped (`counts.deduped > maxFindings`),
  note the uncovered remainder and raise `maxFindings` on a follow-up only if needed.

---

## 10. What this plan does NOT do

- It does not fix anything — it is read-only and produces findings, not patches.
- It is not a pre-ship gate — it is periodic housekeeping.
- It does not write to prod, deploy, commit, push, or branch.
- It does not cover TypeScript types, unit-test results, Cloud Functions, or RTDB —
  WORKZ has none of those. The missing `firestore.indexes.json` is covered as a coupling
  risk, not as an index-diff.
