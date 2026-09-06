# 00 — SYNTHESIS · WORKZ full debug sweep · 2026-09-05

**Audited:** `origin/main` = HEAD `5657835` (2026-09-02, "fix(timeline): stop one unbroken stretch
reading as several blocks"), worktree `gallant-moser-71646e`, 0/0 ahead/behind.
**Verdict: NEEDS WORK — 1 🔴 (a known, never-dispositioned P1), 9 🟠, 23 🟡.** All deterministic
gates are green (lint · build · 1551 tests · functions lint), and — after a CLI re-auth on
2026-09-06 — **live Firebase is byte-for-byte in sync with the repo** (rules, 14 indexes, 24
functions). The sweep changed nothing outside this directory.

| Track | Result |
|---|---|
| Lint (root + functions) | clean, 0 warnings |
| Build | ok, 1m20s, largest chunk 123.5 KB gz, dist 7.0 MB, PWA artifacts present |
| Tests (`test:all` = vitest + bare-node functions + Firestore emulator) | **1551 passed, 0 failed** (1433 unit + 118 emulator) |
| Deps | 9 root advisories (2 high, build-time only) · 8 functions (moderate, mostly non-applicable) |
| Firebase live diff | ✅ **IN SYNC** (verified 2026-09-06 after CLI re-auth): Firestore + Storage rules identical, 14/14 indexes, 24/24 functions uploaded 2026-08-25 18:53Z — after the last `functions/` commit |
| Reasoning (triage-sweep, 11 dims) | 29 findings → 8 confirmed, 5 rejected on the merits, **16 unverified by skeptics** (usage limit) → all 16 re-checked by hand below |
| Browser smoke (production build, 375 px) | boots, login renders, SW active, manifest ok, no console errors, no <12 px text, button 52 px |

Effort tags: **S** ≤ 1 h · **M** half a day · **L** multi-day. Deploy-touching items are human-only.

---

## 🔴 Critical (1)

1. **Every active user can read every colleague's pay rate (and other admin-only control fields).**
   `firestore.rules:350-351` — `allow read: if isAuthenticated() && (uid == userId || isUserActive())`
   on `/users/{userId}`. Firestore cannot hide fields inside an allowed read, so the whole user doc —
   `payRate` (ADR 0012 NET tiers), `canBackdateTime`, `canEditOwnStartTime`, `isTest`,
   `overseerIds`/`teamManagerIds` — reaches any signed-in worker. It is not only theoretical:
   `UsersContext.jsx:30-45` subscribes to the whole `users` collection and spreads every field into
   app-wide state for every role. Three skeptics confirmed independently and traced it to the
   still-open **R-10 (P1)** in the audit register — logged, never fixed, never accepted. The write
   side is correctly admin-pinned (`:434`); only the read side leaks.
   **Fix (M, rules deploy human-only):** move `payRate` (and the admin-only flags if desired) into
   `users/{uid}/private/{doc}` readable by self + overseer closure + admin, migrate existing values
   with a one-off privileged script, update `UserManagement`/`PayRateModal`/earnings readers. Or
   **disposition it explicitly** as accepted in the register if salary visibility inside the team is
   the founder's actual intent — today it is neither.

## 🟠 Likely (9 open · 2 resolved during the sweep)

**Time & money correctness**

2. **Period summary and AI report under-count hours vs. the CSV and DailyStatistics.**
   `src/utils/workerStats.js:141-161, 284-292` — `computeWorkerStats` sums `work_sessions` only and
   never adds a finished plain task's own `manualMinutes`, while its two siblings on the same data
   (`reportAggregate.aggregateDaily:183-204`, `DailyStatistics.jsx:775-809`) do, with identical
   guards. A skeptic reproduced it with a throwaway test: one plain task with 120 manual minutes and
   no sessions → summary 0 h / 0 active days, CSV 02:00. The commit that fixed the CSV side
   (`f44aca3`) lists this as KNOWN INCOMPLETE; the fixture in `workerStats.test.js:21-26,43` locks
   the omission in (asserts 14 h while 190 manual minutes sit in the fixture). Legacy/typed-in
   tasks only, but it makes one export carry two totals. **Fix (S):** add the same guarded
   `manualMinutes` addition into the day bucket, correct the fixture's expected value.

**Deploy parity — RESOLVED after re-auth (see `06-firebase.md`)**

3. ~~Cloud Functions may be stale in prod.~~ **Withdrawn.** Live inventory read 2026-09-06: all 24
   functions were uploaded 2026-08-25 18:53–18:54 UTC, twelve minutes after the last
   `functions/` commit (`a7c9c06`) merged to `main` — so the 2026-08-15 recognition reframe and
   the SDK bump are both live. Nothing to deploy.
4. ~~Live ruleset body not compared for the second sweep running.~~ **Withdrawn.** The live
   `cloud.firestore` ruleset (released 2026-07-31 12:33 UTC) and the live Storage ruleset are
   byte-identical to `firestore.rules` / `storage.rules`. The live body was fetched through the
   CLI's own auth layer (`06-fetch-live-rules.cjs`), which also gives `/firebase-status` a working
   path while the MCP is down.

**Toolchain security (see `19-deps.md`)**

5. `browserslist` 4.28.1 — 2 HIGH advisories, build-time only, non-breaking fix available. (S)
6. `fast-uri` 3.1.5 — 4 HIGH advisories (SSRF/host confusion), build-time only via
   `vite-plugin-pwa → workbox-build → ajv`, non-breaking fix available. (S)

**Unguarded time-tracking paths (see `04-tests.md`)**

7. `src/hooks/useRevisionedTaskRecovery.js` (195 LOC) — device-scoped orphan-run recovery for the
   revisioned engine (now on for everyone) has no test of its own sequencing (anchor-first,
   this-device-only, notice/claim side effects = the ADR 0026 contract). (M)
8. `src/hooks/useRevisionedSecondaryRecovery.js` (153 LOC) — same gap for quick-work/call/break. (M)
9. `useTimerState.js` / `useActiveTaskElapsedMinutes.js` / `useActiveSecondarySession.js` — the
   displayed-elapsed derivation has no tests; the ledger math is locked, the number the worker sees
   is not. (S–M)

**Docs that can cause a wrong action**

10. **`CLAUDE.md:84` lists `/deploy-netlify` as an existing WORKZ command.** No such file exists in
    `.claude/commands/`; the `/deploy-netlify` that *does* resolve is a user-level skill that
    deploys the **GODSGLOOM** app to `app.godsgloom.com`. An agent following CLAUDE.md could run a
    production deploy of the wrong project. **Fix (S):** delete the mention (WORKZ ships via
    Cloudflare Pages on push; Netlify is parallel/automatic).

**The sweep tooling itself**

11. **`/full-debug-sweep` cannot launch its own reasoning track on this machine, and mislabels
    unverified findings.** Two defects, both reproduced this run:
    - `Workflow({ name: 'triage-sweep' })` was refused: the checkout has `core.autocrlf=true`, so
      `.claude/workflows/triage-sweep.js` is `i/lf w/crlf` and the Workflow permission layer
      rejects the CR control characters. Workaround used: an LF-normalised copy via `scriptPath`.
      **Fix (S):** add `.claude/workflows/*.js text eol=lf` (and the commands) to `.gitattributes`.
    - The verify phase lost 50 of 87 skeptics to a usage-limit error, and the workflow counted every
      missing vote as "not real" — 16 findings with **0/0 votes** were emitted in `rejected` as if
      refuted. **Fix (S):** route findings with `votesTotal === 0` (or `< skeptics`) to an
      `unverified` bucket and say so in the summary line. Also refresh the finder prompts: the
      firebase-coupling prompt still asserts "there is NO firestore.indexes.json" (there are 14
      indexes) and cites the long-closed `sessions` rule gap as a "known live example" — the finder
      duly re-reported it as a non-issue.

## 🟡 Risk (23)

**UI / design system (skeptic-confirmed)**

12. `TaskModal.jsx:1996-2003` and `:1906-1915` — two bespoke icon-only `<button>`s (remove
    attachment, more time options) duplicate `IconButton`, which the same file imports. (S)
13. `DailyStatistics.jsx:1427-1429` — break-time totals coloured from `feedback.warning` instead of
    `session.break`; Rule B (one `SESSION_COLORS` source) drift. (S)
14. `TaskHistory.jsx:35-37, 804-814` and `:916-940` — the date-range trigger and the "Rūšiuoti"
    segmented buttons sit under the 44 px touch floor. (S)

**Dead code (main-session verified by grep: zero callers outside the definition)**

15. `src/utils/formatters.js:27-51` `parseTimeToHours` — no callers. (S)
16. `src/utils/timeUtils.js:228-253` `isTaskTimerAnomalous` + `TASK_TIMER_ANOMALY_RATIO` —
    superseded by `computeDataTrust`, no callers. (S)
17. `src/utils/taskActions.js:636-657` `archiveTask()` — no callers (the nightly
    `archiveFinishedTasks` function is unrelated; deletion goes through the audited domain command). (S)
18. `src/utils/taskCompletionActions.js` — whole module orphaned: `toggleTaskCompletion` has a test
    suite but no importer anywhere in the app. Tested-but-unwired code is a trap for the next reader. (S)

**Docs drift (main-session verified)**

19. `DEPLOY_FIRESTORE_RULES.md:8-38` — "Current security model (as of 2026-06-21)" last edited
    2026-07-02; omits the hierarchy closure, pay-rate pins, `durationMinutes` validation,
    `decision_log`, and the 2026-07-31 hardening. The doc that tells a human what they are deploying
    describes a ruleset that no longer exists. (S–M)
20. `docs/design/DESIGN_SYSTEM.md:137-139` says "~150 existing uses" of sub-12 px text remain — the
    real count is **0** (the single grep hit is a comment saying "was text-[10px]"). Good news
    recorded wrongly. (S)
21. `docs/design/DESIGN_SYSTEM.md:98` still flags the call-state blue/sky drift as "a bug to fix";
    `bg-sky` count in `src/` is 0. (S)
22. `docs/roadmap/r04-r06-closure-roadmap.md:12-14` cites `AuthContext.jsx:404` and a
    `timerEngineEnabled=false` default; the flag is now derived from the live engine status
    (`:606`) and the engine is on for everyone. Stale narrative in a dated roadmap. (S)
23. `.claude/workflows/triage-sweep.js` finder prompts — stale facts listed under item 11. (S)
24. `docs/design/tokens.md:344-365` "active tailwind.config.js" sample vs. the real file —
    **plausible, not verified** (skeptics never ran; a key-level spot check was inconclusive). (S to check)

**Runtime hygiene**

25. `useUndescribedQuickWork.js:53-85` opens a second always-on `onSnapshot` on
    `tasks where assignedUserId == uid`. The SDK coalesces *identical* queries into one listen
    target, so the cost is client-side re-filtering, not double reads — real but minor. (S)
26. `AuditDashboard.jsx:313-319` renders the nightly scan's raw `e.message` to the admin. Admin-only
    diagnostic surface, but the "never render raw err.message" rule has no exception clause. (S)
27. 18 unguarded `console.log` calls ship in the production bundle (`AuthContext.jsx:95-273`,
    `TaskModal.jsx:1067`, `TaskTimerControls.jsx:844`…), including the signed-in user's e-mail on
    every login — PII in the browser console of shared/kiosk devices. Seen live in the smoke pass. (S)
28. `qs` 6.15.3 (functions, moderate ×2) — the one advisory that runs in prod, under Express in
    `firebase-functions`; low exposure, non-breaking fix, deploy human-only. (S)
29. ESLint 8.57.1 is end-of-life in both packages (flat-config migration needed). (M)
30. Vite warning: `sessionAdmin.js` is `import()`-ed by `taskActions.js` but statically imported
    elsewhere, so the dynamic import splits nothing — comment the intent or make it static. (S)

**Missing guards (see `04-tests.md`)**

31. `sessionColors.js` — no test locks the `SESSION_COLORS` shape (the signature invariant). (S)
32. `calendarApproval.js` — client-only enforcement with no test. (S)
33. `useModalA11y.js` — THE dialog hook, untested; a regression breaks keyboard access everywhere. (S)
34. `useManagerData.js` — manager `onSnapshot` fan-in, untested. (S)

## ℹ️ Informational

- Major dependency drift is deliberate and coupled: `firebase` 10→12 must move with
  `@firebase/rules-unit-testing` and the vendored `public/__/auth/*` helper; `react` 18→19 with
  `@vitejs/plugin-react` + hooks plugin; `vite`/`vitest` together; `tailwindcss` 3→4 with
  `tailwind-merge`. Nine in-range minor/patch bumps are held back by the lockfile.
- Splash PNGs are 53 % of `dist/` but not precached; first load ≈ 331 KB gzip.
- `uuid`/`@google-cloud/storage` moderate chain: `npm audit`'s only "fix" is a four-major
  **downgrade** of `firebase-admin`; already accepted, not applicable (v4 only).
- Smoke pass details: `lang="lt"`, `display: standalone`, 4 icons, SW active and controlling,
  no DEV login panel in the production bundle, no horizontal overflow at 375 px, the
  `HEAD /?_clock=` probe shows `ERR_ABORTED` in devtools by design (only the `Date` header is read).

## Rejected / not issues (with evidence)

| Claim | Why not |
|---|---|
| `shift_logs` / `daily_stats` orphan rules | Deliberate `if false` locks, documented in `DEPLOY_FIRESTORE_RULES.md:31` and two prior sweeps; 0/3 skeptics. |
| `UserManagement.jsx:1173` bespoke clear-search button | 0/3 — not bespoke on inspection. |
| `TaskTimeLimitPopup.jsx:202, 273` bespoke buttons | 1/3 — minority. |
| `sessionActions.js:389-423` crash-recovery drops nested `pausedSession` | 1/3 — the modern path handles it; minority. |
| `WorkPlanner.jsx:466-490` sequential per-day writes "should be a batch" | By design: per-item `failed`/`queued` outcome tracking and offline queueing would be lost in a `writeBatch`; 5–7 writes/week. |
| `useManagerData.js:38-40` no `limit()` for admins | By design: `tasks` is the live active set, bounded by the nightly archive (measured 185 docs). |
| `Login.jsx:149` raw `err.code` | DEV-only panel, dead-code-eliminated from production (confirmed absent in the smoke pass). |
| "`sessions` collection has no rule" | Long fixed (`firestore.rules:848-855`); the finder prompt is stale (item 11). |

## What this sweep could NOT verify

- ~~Live Firebase state~~ — **verified on 2026-09-06** after the founder re-authenticated the CLI:
  rules identical, 14/14 indexes, 24/24 functions, bundle uploaded after the last change. The
  `firebase` MCP server itself is still unreachable (a startup problem, not credentials) — worth a
  separate look, since `/firebase-status` depends on it.
- **Authenticated visual QA** — the QA test account is parked disabled and the MCP path to enable
  it was down; only the unauthenticated production shell was exercised.
- **16 reasoning findings** lost their skeptics to the usage limit; the main session verified 14
  by direct grep/read (verdicts above) and left 1 plausible-unverified (item 24) and 1 minor (25).

## Prioritised fix list

| # | Item | Effort | Who |
|---|---|---|---|
| 1 | ~~Re-auth Firebase CLI → verify live parity (items 3, 4)~~ **DONE 2026-09-06 — in sync, nothing to deploy.** Follow-up: find out why the `firebase` MCP server times out; promote `06-fetch-live-rules.cjs` into `scripts/` as the `/firebase-status` fallback | S | agent |
| 2 | Disposition R-10 payRate read exposure: fix (private subdoc) or accept in the register (item 1) | M | agent + human rules deploy |
| 3 | `computeWorkerStats` manualMinutes parity + fixture (item 2) | S | agent |
| 4 | Remove the `/deploy-netlify` mention from CLAUDE.md (item 10) | S | agent |
| 5 | Sweep tooling: `.gitattributes eol=lf`, `unverified` bucket, prompt refresh (items 11, 23) | S | agent |
| 6 | Lockfile bumps for browserslist / fast-uri / qs (items 5, 6, 28) | S | agent (+ human functions deploy for qs) |
| 7 | Tests for the two recovery hooks and the elapsed-display hooks (items 7–9) | M | agent |
| 8 | UI trio: IconButton in TaskModal, break colour token, TaskHistory touch targets (12–14) | S | agent |
| 9 | Dead-code removal ×4 (15–18) and console.log hygiene (27) | S | agent |
| 10 | Docs refresh: DEPLOY_FIRESTORE_RULES model section, DESIGN_SYSTEM two stale notes, roadmap (19–22) | S–M | agent |

## Cost of this sweep (measured)

Reasoning track: **find 289k · verify 351k · total ~640k output tokens** (workflow-measured);
harness total 5.50 M tokens across 98 agents (11 finders + 87 skeptics, 50 of which failed on the
usage limit), 1020 tool calls, ~100 min wall clock. Deterministic track ≈ 5 min of CLI time.
Whole sweep 19:59Z → 22:15Z ≈ 2 h 15 min including the wait.
