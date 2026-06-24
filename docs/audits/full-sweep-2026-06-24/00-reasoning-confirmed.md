# Reasoning track — confirmed findings (triage-sweep)

**Status:** ⚠️ PARTIAL (verify stage hit a session limit — see Coverage caveat)
**Workflow run:** `wf_2a74548a-2c0` · 131 agents · 22m11s · 6.13M subagent tokens
**Measured cost (output tokens):** find **152,541** · verify **300,960** · **total 453,501**
**Pipeline counts:** raw 78 → deduped 78 → verified 40 → **confirmed 11** (29 voted-down,
of which **11 were not actually verified** — verify-blocked, see below)

## Coverage caveat (why this is PARTIAL)

The adversarial-verify stage exhausted the session token limit (resets 04:50 Europe/Vilnius)
**before the `firebase-coupling` and `ux-a11y` verifiers could run.** Those two dimensions'
findings were defaulted-to-rejected with **0/0 votes** — i.e. *no skeptic actually
evaluated them*. They are **unverified leads, not confirmed issues and not genuine
false-positives.** They are recorded separately below (§ Unverified leads) at lower
confidence. The other 9 dimensions completed verify normally.

To complete coverage, re-run **only** those two dimensions after the limit resets — do **not**
re-run the whole sweep (the 9 completed dimensions are done).

---

## ✅ Confirmed findings (11) — survived adversarial majority verify

### 🔴 High (2)

**H1 · crashsafety · `src/utils/sessionActions.js:481-483`** — *endLegacySession swallows
critical failures with `console.error` only* (3/3)
The `endLegacySession` catch logs to `console.error` but does **not** call `logError` and
does **not** rethrow. The critical `updateDoc` it guards (clearing
`isTakingBreak`/`isCalling`/`isQuickWorking`) is the write the code itself labels "CRITICAL
FIX: clear the legacy state flags so the user doesn't get stuck." On a permission/network
failure the user keeps the stuck flag **and no durable trace is recorded** — neither the
30-entry localStorage ring buffer nor remote `error_logs`. Callers use
`return await endLegacySession(...)`, so the swallowed rejection never triggers the outer
`endSession` catch or `unhandledrejection`.
**Chesterton's-fence check (verifiers, 3/3):** the twin main-path catch in the same file
was *deliberately* upgraded to `logError` with a comment condemning exactly this pattern;
~10 other write-fail sites route through `logError`. This catch is the lone holdout — an
oversight, not an exemption.
**FIX:** `logError(err, { source: 'endLegacySession', userId, sessionType: type })` in the
catch. (`logError` is already imported and never throws.) Minor caveat: orphan-recovery may
re-clear the flag later, so "permanently stuck" is slightly strong — but the **durable-trace
gap is the load-bearing, fully-real part.**

**H2 · crashsafety · `src/pages/WorkerView.jsx:64-68` (gap in `ManagerView.jsx`)** —
*Orphan-recovery hooks missing for manager-role users* (3/3)
`useOrphanedTaskRecovery` + `useOrphanedSessionRecovery` are mounted **only** in `WorkerView`.
Routing is mutually exclusive (`Dashboard.jsx`: `isManagerRole ? <ManagerView/> : <WorkerView/>`),
so a manager mounts neither. Yet managers **do** start quickWork/call/break sessions via the
shared `BottomNavigation`/`SideRail` (mounted for all roles in `Layout.jsx`), and
`handleLegacyLogging` branches on `isManager`. A manager who crashes/reloads mid-session has
no auto-close of a `running` timer or active secondary session → **ghost time accrues with no
recovery notice.**
**FIX:** mount both recovery hooks in `ManagerView` too (or hoist them to `Layout`/a shared
shell so every role gets recovery regardless of view).

### 🟠 Medium (7)

**M1 · timetracking · `src/components/Reports.jsx:426-428`** — *date filter uses
browser-local midnight for a UTC-ISO `completedAt` comparison* (3/3)
`end.setHours(23,59,59)` sets the boundary in the **browser's** local timezone, not UTC and
not Vilnius. Near the `endDate` boundary, tasks completed between browser-local midnight and
Vilnius midnight are wrongly included/excluded. No `getLithuanianDateString` /
`getLithuanian3AMCutoff` is used in this block.
**FIX:** build both boundaries from the Vilnius calendar day (reuse the existing
`getLithuanian*` helpers) instead of `new Date(str)` + local `setHours`.

**M2 · timetracking · `src/components/Reports.jsx:625-629`** — *grouped-view date key uses
the raw UTC date, not the Vilnius calendar day* (3/3)
`dateStr.split('T')[0]` takes the **UTC** date of the ISO timestamp. A task finished
00:00–03:00 Vilnius groups to the **previous** day, disagreeing with `DailyStatistics`' 03:00
work-day boundary. Same off-by-one `getLithuanianDateString` was introduced elsewhere to fix.
**FIX:** key the group by `getLithuanianDateString(dateStr)` so the tasks report and the
day-statistics view agree.

**M3 · crashsafety · `src/utils/taskActions.js:27-29`** — *`updateUserWorkStatus` failure
reaches only `console.error`, not the durable log* (2/3)
Called from `pauseTask` and `deleteTask`. A failure leaves the user doc inconsistent with the
task doc (task `paused`, user doc still `running` + stale `activeTaskId`) and **invisible in
`error_logs`** — undiagnosable in production. No direct ghost-time vector (the next
`pauseOtherTasks` keys off the task doc), but a permanent silent inconsistency.
**FIX:** route the catch through `logError` (same pattern as H1).

**M4 · crashsafety · `src/utils/sessionActions.js:376-378`** — *`doResume` race-safeguard
fetch failure silently proceeds* (2/3)
If the guard `getDoc` (latest user doc) throws, the catch leaves `userStartedAnotherTask =
false` and resumes the queued task anyway — bypassing the entire race guard. If the user had
rapidly started a different task, the **new** task gets paused and the **old** one resumed.
Logged only as `console.warn`, invisible in the ring buffer.
**FIX:** on safeguard-fetch failure, fail safe (do **not** resume) and `logError` it, rather
than proceeding as if no race occurred.

**M5 · discipline · `src/components/TaskTimeLimitPopup.jsx:94-108`** — *bespoke `<button>`s
instead of canonical `Button`* (3/3)
The "Nutildyti garsą" and "Supratau" actions hand-roll focus-ring/disabled/sizing/hover that
`ui/Button.jsx` owns; "Supratau" also uses raw `bg-red-600/700` instead of `variant="danger"`.
**FIX:** replace with `<Button variant="danger">` / appropriate variant.

**M6 · discipline · `src/components/BreakTimer.jsx:102-122`** — *bespoke session-toggle
`<button>`s* (2/3)
Both the compact and desktop toggles hand-roll `min-h-touch`, focus-ring, `transition-all`,
`active:scale-95`. The same divergence repeats in `CallTimer.jsx` (300, 344) and
`QuickWorkTimer.jsx` (363, 407) — **a shared pattern, likely because `Button` has no
session-state "active ring" variant yet.**
**FIX:** add a session-active variant to `Button` and migrate all three timer components
(removes the duplication at its root rather than per-file).

**M7 · session-color · `src/components/TaskTimeLimitPopup.jsx:105` (+ header gradient :51)**
— *acknowledge button uses raw `red-600` utilities instead of the `feedback-danger` token*
(2/3) — Rule B (every state color from the single token map).
**FIX:** `bg-feedback-danger hover:bg-feedback-danger-hover focus-visible:ring-feedback-danger`;
swap the `from-red-600 to-red-700` header gradient for danger tokens too. *(Overlaps M5.)*

### 🟡 Low (2)

**L1 · session-color · `src/components/QuickWorkDescribePrompt.jsx:40`** — *raw
`border-red-200` instead of `border-session-quickWork-soft`* (3/3) — Rule B. The sibling
`QuickWorkTimer.jsx:61` already uses the correct token; this one will drift if the palette
changes. **FIX:** swap to `border-session-quickWork-soft`. *(Confirmed present on inspection.)*

**L2 · security · `firestore.rules:474-479` (error_logs create)** — *any authenticated user
may create `error_logs` docs with no field-shape/size validation* (2/3)
Client writes `navigator.userAgent` + `window.location.href` verbatim, unbounded. A
compromised client could flood the collection or inject long strings into manager-visible
crash reports. (Rules can't rate-limit — acknowledged elsewhere in the file.) `update:false`
immutability is already correct.
**FIX:** add permissive shape guards mirroring the `request_notifications`/`decision_log`
idiom — require the create-time fields to be strings and clamp the free-form ones (e.g.
`userAgent`/`url`/`message` `size() <= N`). Keep it permissive so a broken session can still
record its failure.

---

## ⚠️ Unverified leads (verify-blocked — lower confidence, NOT confirmed)

### firebase-coupling — **4 "missing composite index" HIGH claims → REFUTED by me**

The finder flagged 4 HIGH `FAILED_PRECONDITION` index risks; **none survive a deterministic
Firestore-indexing check** (I read each query site and applied the index rules, since the
verify agents could not):

| Finder claim | Query (read at source) | Verdict |
|---|---|---|
| tasks `assignedUserId + timerStatus` (`taskActions.js:274-278`) | two `==` filters, **no orderBy** | **Refuted** — multiple equality filters on different fields are served by single-field index **merge join**; no composite needed |
| request_notifications `recipientId + isRead` (`NotificationsContext.jsx:97-101`) | two `==` filters, no orderBy | **Refuted** — same merge-join rule |
| request_notifications `recipientId + isRead` (`ManagerNotifications.jsx:141-144`) | identical two `==` | **Refuted** — duplicate of the above |
| calendar_requests `createdAt` range (`CalendarChangeHistory.jsx:43-46`) | range `>=`/`<=` **+ orderBy on the *same* field** `createdAt` | **Refuted** — same-field range+orderBy is served by the automatic single-field index (the finder itself conceded "ordinarily this would be fine," then speculated incorrectly about scale) |

Corroboration: `firestore.indexes.json` has `fieldOverrides: []` (automatic single-field
indexing is **on**), and all four are **core live-production queries** (notification bell,
multi-task pause, calendar history) that run daily without error — they would be visibly
broken if any threw `FAILED_PRECONDITION`. Consistent with the deterministic
[`06-firebase.md`](06-firebase.md): rules/indexes/functions are clean and in sync. **No
action.** (One genuine low note: `daily_stats` / `shift_logs` are orphan locked rules — see
06-firebase §Info, intentional.)

### ux-a11y — **6 leads, code-pattern confirmed present, AA-math not adversarially verified**

These need contrast/measurement judgement the blocked stage would have applied. I spot-read
the cited lines — **the code patterns are real** (not hallucinated), but whether each truly
crosses the 4.5:1 / 44px AA threshold is unverified:
- **`ActiveWorkSessions.jsx:432-435`** — session sub-labels at `text-xs` + `opacity-70`
  (confirmed present). Plausible <4.5:1 on the inherited ink color. *(medium-ish)*
- **`ManagerNotifications.jsx:889,918,963,996,1157,1221`** — decision copy at
  `text-xs opacity-80`. *(plausible AA fail on manager-facing content)*
- **`DailyStatistics.jsx:1464-1478`** — session-timeline table rows hard-coded `text-xs`,
  static `hidden md:block` breakpoint (vs the JS-`viewMode` pattern used elsewhere).
- **`DailyStatistics.jsx:2005,2052,2057,2083,2090`** — `MobileStatsCard` description/labels at
  the 12px floor.
- **`TaskDetailsModals.jsx:153-155`** — comment timestamps at `text-xs`, dense string.
- **`AllUsersCalendar.jsx:317-327`** — drill-down bar **~42px** tap target (self-documented in
  the code comment as "toward the 44px AA floor"); **2px short** of AA. One-char fix:
  `-inset-y-[9px]` → `-inset-y-[10px]` = 44px. *(confirmed present — the most clear-cut lead)*

**Recommendation:** treat the ux-a11y set as a small, self-contained polish pass; re-run the
`ux-a11y` dimension verify after the limit resets, or hand-verify contrast with the design
tokens. None are correctness/data bugs.

---

## Genuine false-positives filtered (18 verified-and-voted-down)

The verify stage earned its cost — it rejected, with real votes, several plausible-but-wrong
claims. Notable correct rejections:
- **"Hardcoded Firebase API key committed to git" (0/3)** — correct: the web `apiKey` is
  **public client config** (CLAUDE.md), not a secret.
- **"Worker can self-confirm a task on CREATE" (1/3)** — correct: the documented
  call/quick-work auto-confirm design; the real escalation (flipping an *existing* task) is
  already rule-guarded.
- **"TaskTimeLimitPopup full-saturation red outside quick-work — Rule C" (0/3)** — rejected;
  the danger/warning red here is acceptable (distinct from the confirmed **M7** token-discipline
  point about *sourcing* that red from the `feedback-danger` token).
- **`calculateCurrentTotalMinutes` double-count (0/3)**, **`pausedSession` one-level nesting
  (0/3)**, **clock-skew on `timerStartedAt` (0/3)** — all examined and refuted.

Full lists: `_genuinely-rejected.json` (18 with votes) · `_unverified.json` (11 verify-blocked).
