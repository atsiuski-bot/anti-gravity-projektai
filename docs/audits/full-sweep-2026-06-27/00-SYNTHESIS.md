# Full Sweep — Synthesis & prioritized fix list (2026-06-27)

> Read this file first. It aggregates the deterministic track (lint · build · tests · deps ·
> firebase) and the verified reasoning track (`triage-sweep`) into one prioritized list.
> **The sweep changed nothing** — it is read-only findings only.

## Verdict: ✅ **AUDIT CLEAN — 0 critical**
All deterministic gates pass (lint clean · build ok · **631/631 tests** · 0 high/critical
deps). No 🔴 (prod-break / data-loss / privilege-escalation) finding survived verification.
What remains is a backlog of **8 🟠 likely** + **16 🟡 risk** items — none blocks shipping, but
the two security rule gaps and the time-math bugs are worth scheduling.

| | 🔴 Critical | 🟠 Likely | 🟡 Risk | ℹ️ Info |
|---|---|---|---|---|
| Deterministic | 0 | 3 | 6 | several |
| Reasoning (verified) | 0 | 5 | 10 | — |
| **Total** | **0** | **8** | **16** | — |

False positives filtered by the verify stage: **25**. Verification was **capped at 40 of 90**
findings — **50 went unverified** (see §Remainder).

---

## 🟠 Likely — schedule these (8)

### Security (rules — human-only deploy) — do first
1. **`work_hours` not scoped for scoped-managers** — `firestore.rules` work_hours block
   (383-401). create/update/delete gate only on `isManagerOrAdmin()`; a `scopedManager` can
   write any user's hours. `tasks`/`work_sessions`/`break_sessions` already scope this. **Fix:**
   add the `isScopedOverseer() + inCallerTeam()/overseesUser()` branch. **Effort: M** (rule +
   test + deploy). _One skeptic flagged this may be intentional ("managers write approved
   entries") — confirm the product intent for scoped managers before changing._
2. **`calendar_requests` update missing `userId` pin** — `firestore.rules` line 472. Owner can
   re-point `userId` to a colleague (graft). The sibling collections (346/369/398) all pin it.
   **Fix:** add `request.resource.data.get('userId','') == resource.data.get('userId','')` +
   scope the manager branch. **Effort: S** (one line, mirrors siblings) + deploy.

### Time-math (correctness — WORKZ's core)
3. **`getCurrentWorkDayCutoff` boundary uses device-local `getHours()`** —
   `src/utils/timeUtils.js:403`. Day computed in Vilnius, boundary hour in device TZ → wrong
   work-day window for ~2–3 h/day on off-Vilnius devices. **Fix already exists** in
   `automationUtils.js:71-80` — mirror it. **Effort: S.** _Limited real-world blast radius
   (most devices are in Vilnius), but unguarded by any test._
4. **`WorkPlanner.isApprovalFeatureActive` Vilnius gate uses local `getDay()/getHours()`** —
   `src/components/WorkPlanner.jsx:307-314`. Off-Vilnius devices mis-route the Fri–Sun free-edit
   approval window; feeds planned-hours into report Skirtumas. **Fix:** compute against Vilnius
   wall-clock. **Effort: S–M.**

### Crash-safety
5. **`pauseOtherTasks` swallows failures + leaves concurrent-running tasks** —
   `src/utils/taskActions.js:293-320`. On a `getDocs` failure it pauses nothing and the caller
   proceeds → two tasks `running` (ghost-time window) with no `logError` trace. **Fix:** route
   the catch through `logError`; handle the "couldn't pause" case. **Effort: S.** _Most impactful
   of the crash-safety cluster (the other two are diagnostic-only)._

### Test-coverage gaps (unguarded critical paths)
6. **`calendarNotifications.js` — no test** (time-math: week boundary, Vilnius). **Effort: M.**
   _Reinforces #3/#4: WORKZ's time core has live TZ bugs AND coverage gaps._
7. **`payRate.js` — no test** (tiered NET rates + LT tax math, ADR 0012; money correctness).
   **Effort: M.**
8. **`taskCompletionActions.js` — no test** (finish/complete write path, credited duration).
   **Effort: M.**

---

## 🟡 Risk — backlog (16), grouped by cluster

**Crash-safety: swallowed-error cluster** (theme: fire-and-forget Firestore writes log only to
`console.*`, never `logError` → invisible on a field phone). _Fix the whole cluster together._
- `notify.js:57-61` — the app-wide notification funnel (votes 3/3). **S.**
- `sessionActions.js:621-627, 728-734` — partial-session rename (cosmetic; votes 2/3). **S.**

**Discipline: canonical-component bypass** (DESIGN_SYSTEM — use `Button`/`Card`).
- `TaskTimeWarningPopup.jsx:47-53` — raw amber dismiss button → add a `warning` `Button` variant. **S.**
- `TaskDetailsModals.jsx:212-218` — raw `bg-brand` submit → `<Button variant="primary">`. **S.**
- `ManagerNotifications.jsx:78, 929, 1360` — card combo → `<Card>`. **S.**
- `Reports.jsx:1234, 1246, 1389, 1402` — summary panels → `<Card>`. **S.**

**a11y**
- **HIGH-priority 🟡:** `TaskTimeLimitPopup.jsx:192` — photo-delete button 20×20 px, below the
  44 px floor (DESIGN_SYSTEM §7, WCAG 2.5.5). Worker can't reliably tap it in the forced
  completion flow. _Listed 🟡 only because it's a single control, but treat as near-🟠._
  **S.** (Also `CompletionPhotoModal:134` 24 px.)
- `focus:ring-2` → `focus-visible:ring-2` — `TaskDetailsModals.jsx:183-209`, plus
  `TaskModal` 1405/1580/1771/1888 and `WorkPlanner` 1056/1066/1371 (mechanical sweep). **S.**

**Session-color: Rule B token drift**
- `TaskTimeWarningPopup.jsx:31-50` — raw `amber-700/orange-700` not `session-break-*`/`feedback`. **S.**
- `ActiveWorkSessions.jsx:444, 508` — `text-xs` not `text-caption` token. **S.**

**Test-coverage (secondary)**
- `recurringActions.js`, `reportData.js`, `teamScope.js`, `boardOrder.js` — no co-located test
  (the pure layers `recurrence.js`/`reportAggregate.js`/`taskSort.js` are tested; the action/
  fetch/closure/rank layers are not). **M each.**

**Firebase**
- **Live deploy state unverifiable + documented pending deploys** — `06-firebase.md`. The MCP
  token expired, so live rules/indexes/functions could not be diffed. Memory flags
  client-live-but-deploy-pending changes (VERY_LOW→4-tier priority incl. **rules**; multi-week
  recurrence functions; badge thresholds). **Action (human-only):** `firebase login --reauth`,
  then verify live state post-merge per the CLAUDE.md deploy protocol. **S** (verify) + deploy.

**Deps**
- 6 moderate + 1 low advisory in the `firebase-admin`/`@google-cloud/storage` **dev** chain;
  the only "fix" is a breaking `firebase-admin` downgrade. Prod browser tree = 0 vulns. **Leave
  as-is** (documented accepted residual; do NOT `npm audit fix --force`). **—**

---

## ℹ️ Baseline / info
- Lint clean (`--max-warnings 0`); functions/ lint clean. Build ok; `dist/` 5.9 MB; PWA SW +
  manifest (icons 192/512 any+maskable) present. Tests 631/631 across 52 files.
- `manifest.webmanifest` has English placeholders (`description:"Productivity App"`, `lang:"en"`)
  for a Lithuanian product — cosmetic i18n nit.
- **Docs drift:** `FULL_SWEEP_PLAN.md` preamble and the `triage-sweep` workflow header still
  claim WORKZ has "no test runner / no Cloud Functions / no firestore.indexes.json" — all three
  are now false (52-file vitest suite, 21 Cloud Functions, 12 composite indexes). Worth a
  one-line correction in those headers.
- `caniuse-lite` is 6 months stale (build warning) — `npx update-browserslist-db@latest`.

---

## Measured reasoning cost (size future runs from this)
**560,845 output tokens** total — find 204,699 (11 Sonnet finders) · verify 356,146 (40×3 Opus
skeptics). 131 agents, 35.7 min wall. The deterministic track is negligible by comparison.

## Remainder (uncovered)
Verification was capped at `maxFindings=40`; **50 of 90 unique finds were never verified**
(arrival order, not severity). At the observed 62.5 % false-positive rate, ~15–20 real issues
may remain unconfirmed. A single bounded follow-up covers them (opt-in, ~doubles verify spend):
`Workflow({ name: 'triage-sweep', args: { maxFindings: 90 } })`. The sweep does **not**
auto-escalate — this is left to the founder's call.

## Suggested fix order
1. **Security rules #1, #2** (cross-user write vectors) → one rules change, one human deploy,
   MCP-verify live.
2. **Crash-safety #5** + the swallowed-error cluster → one `logError` pass.
3. **Time-math #3, #4** → mirror the existing Vilnius pattern; add the `calendarNotifications`/
   time tests (#6) alongside.
4. **a11y** (44 px button + `focus-visible` sweep) and the **discipline/session-color** clusters
   → low-effort, high-consistency cleanups, batchable.
5. Decide on the **maxFindings=90 follow-up** and the **live Firebase re-verify**.
