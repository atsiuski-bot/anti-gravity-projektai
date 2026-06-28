# Reasoning track — confirmed findings (triage-sweep, verified)

**Status:** ✅ COMPLETE (with a verification-coverage cap — see remainder note)
**Workflow:** `triage-sweep` · 11 dimensions · 131 agents · 1851 tool calls · 35.7 min wall
**Confirmed:** 🔴 0 · 🟠 5 · 🟡 10 (15 total) — **25 rejected as false positives**

## Measured cost
| Phase | Output tokens |
|---|---|
| Find (11 finders, Sonnet) | 204,699 |
| Verify (40 findings × 3 skeptics, Opus) | 356,146 |
| **Total** | **560,845** |

(The workflow's own `tokens` field. The notification's 6.39 M `subagent_tokens` counts
input+output across all 131 agents; the 560 k here is the output-token measure the workflow
attributes to this sweep.)

## ⚠️ Verification-coverage cap (uncovered remainder)
`counts: raw 90 · deduped 90 · verified 40 · confirmed 15`. The finders produced **90 unique
findings** (no duplicates removed), but only the **first 40** (dedup/arrival order, NOT
severity order) were sent to the adversarial-verify stage — `maxFindings` defaults to 40.
**50 findings were never verified.** The observed false-positive rate among the 40 verified
was **62.5 %** (25 of 40 rejected), so the 50 unverified plausibly contain on the order of
~15–20 real issues that this run did not confirm. This is the deliberate cost cap, not a bug.

To cover the remainder (a single, bounded follow-up — NOT a loop):
`Workflow({ name: 'triage-sweep', args: { maxFindings: 90 } })` — re-runs the finders and
verifies all 90. It is opt-in because it roughly doubles the verify spend; the sweep does not
auto-escalate scope.

## Method
Each dimension = one read-only Explore finder (Sonnet) → dedup by `file:line:title` → 3
skeptics per finding (Opus), each on a distinct lens (correctness / hidden-purpose /
reproducibility), **strict majority** confirms. The skeptics are told to default to
`real=false` and to check for a deliberate design reason (Chesterton's fence) before
condemning — which is why 25 plausible-looking finds were filtered out.

---

## 🟠 Likely (5)

### 1. `timetracking` — `getCurrentWorkDayCutoff` uses browser-local `getHours()` not Vilnius hour
**`src/utils/timeUtils.js:403`** · votes 3/3
The 03:00 work-day boundary derives its DATE correctly via `getLithuanianDateString(now)`
(Intl, Europe/Vilnius) at line 401, but the "before 3 AM → roll back a day" test at line 403
uses `now.getHours()`. `now` defaults to `getLithuanianNow()` (line 219) = a plain
`new Date()`, whose `getHours()` returns the **device-local** hour. So the day is computed in
Vilnius while the boundary hour is in the device's timezone — internally inconsistent. On a
device off Vilnius time (e.g. left on UTC) the work-day boundary lags by up to ~2 h (winter)
/ ~3 h (summer), mis-windowing the personal day window (`scopePersonalDayWindow`,
taskUtils.js) and the shared team list (`scopeActiveTasks`, useTaskFiltering.js). **The exact
anti-pattern was knowingly fixed in `automationUtils.js:71-80`** (which compares
`now < getLithuanian3AMCutoff(todayStr)` and carries a comment describing this very bug);
`getCurrentWorkDayCutoff` is the missed leftover. FIX: mirror the `automationUtils` /
`getLithuanian3AMCutoff` noon-reference pattern. _Real-world blast radius is limited — most
WORKZ devices are physically in Vilnius — but the bug is real and unguarded (no test pins it)._

### 2. `ux-a11y` — Photo-delete button in `TaskTimeLimitPopup` is 20×20 px (below the 44 px floor)
**`src/components/TaskTimeLimitPopup.jsx:192`** · votes 3/3
The "Pašalinti nuotrauką" remove button is `h-5 w-5` (20 px) with no invisible padding
extension and no `min-h-touch`/`min-w-touch`. DESIGN_SYSTEM §7 mandates ≥44×44 px for every
interactive control (WCAG 2.5.5 / AA). A field worker on a phone cannot reliably tap it during
the forced time-limit completion flow. FIX: wrap in a ≥44 px hit area (`min-h-touch min-w-touch`
or a padded `IconButton`). (The finder's cross-reference to `CompletionPhotoModal:134` `h-6 w-6`
is a separate, also-short instance worth the same fix.)

### 3. `timetracking` — `WorkPlanner.isApprovalFeatureActive` uses local `getDay()/getHours()` for the Vilnius business-hours gate
**`src/components/WorkPlanner.jsx:307-314`** · votes 3/3
The weekly free-edit window (Fri 13:00 – Sun 21:00 Vilnius) reads `now.getDay()` /
`now.getHours()` in browser-local time. On an off-Vilnius device the gate is off by 2–3 h, so a
manager can be wrongly routed to the approval flow when they are inside the free window, or
wrongly allowed to skip it. Because this gate controls calendar writes that feed planned-hours
into the report "Skirtumas" calc, a mis-routed approval can let unapproved backdated time affect
totals. FIX: compute the gate against Vilnius wall-clock (same Intl/offset pattern as `timeUtils`).

### 4. `crashsafety` — `pauseOtherTasks` swallows network/permission failures without `logError`
**`src/utils/taskActions.js:293-320`** · votes 3/3
Called inside `startTask`/`resumeTask` to stop all other running timers before starting a new
one. Its outer catch (≈316-319) calls only `console.error` — never `logError` — and on a
`getDocs` failure it returns `{docs:[]}` (≈282), so **zero tasks get paused and the caller
continues**. The previously-running task stays `timerStatus:'running'` with its original
`timerStartedAt` while the new task is also `running` — a concurrent-running / ghost-time window
that persists until the next reload's orphan recovery, with **no trace in the crash log**. FIX:
route the catch through `logError` and surface/handle the "could not pause others" case.

### 5. `security` — Scoped manager can write `work_hours` for any user outside their team
**`firestore.rules` — `work_hours` block at 383-401** (create 389, update 397-399, delete 400)
· votes 2/3 _(corrected from the finder's cited "328-339")_
`work_hours` create/update/delete gate on `isManagerOrAdmin()`, which is true for ANY manager —
including a `scopedManager` whose visibility is supposed to be limited to their subtree
(ADR 0005). `tasks`, `work_sessions`, and `break_sessions` correctly add
`isScopedOverseer() + inCallerTeam()/overseesUser()` for scoped managers; **`work_hours` does
not**, so a scoped manager can create/update/delete planned/approved hours for anyone in the
company. Breaks the scoped-manager write-isolation guarantee. FIX: apply the same scoped-overseer
+ team-membership branch used on the sibling collections. _(1 skeptic dissented on
Chesterton's-fence grounds — "managers write approved entries for workers" may be intentional —
so weigh whether scoped managers are meant to plan company-wide before changing.)_ **Rules change
→ human-only deploy.**

---

## 🟡 Risk (10)

### 6. `security` — `calendar_requests` update has no `userId` pin (owner can re-point the record)
**`firestore.rules` — `calendar_requests` block 465-474, update at 472** · votes 3/3
_(corrected from the finder's cited "409")_
`allow update: if isUserActive() && (ownsUserId() || isManagerOrAdmin())` — missing the
`request.resource.data.get('userId','') == resource.data.get('userId','')` pin that
`work_sessions` (346), `break_sessions` (369), and `work_hours` (398) all carry. A worker who
owns a `calendar_request` can rewrite its `userId` to a colleague's uid, grafting their
requested hours onto the victim's calendar/reports and re-routing future `ownsUserId()` checks.
The unscoped `isManagerOrAdmin()` also lets a scoped manager approve/deny requests outside their
team. FIX: add the userId pin (one line, mirrors the three siblings) + scope the manager branch.
_Lower than #5 because it requires already owning the doc and touches planning data, not payroll
directly — but it is a real cross-user write vector the codebase guards against everywhere else._
**Rules change → human-only deploy.**

### 7. `discipline` — Bespoke action button in `TaskTimeWarningPopup` instead of `<Button>`
**`src/components/TaskTimeWarningPopup.jsx:47-53`** · votes 3/3
The "Gerai" dismiss is a raw `<button>` with hand-rolled `bg-amber-700`/hover/focus styling;
`Button` is not imported. `Button` has no amber variant, so the fix is to add a `warning`
variant (or use `secondary`), not hand-roll. The modal already uses the canonical `<Modal>` shell.

### 8. `discipline` — Raw `<button>` with `bg-brand` instead of `<Button>` in `CommentsModal`
**`src/components/TaskDetailsModals.jsx:212-218`** · votes 3/3
The "Skelbti" submit button re-implements `Button`'s `bg-brand`/hover/focus/disabled styling,
though `Button` is already imported (line 14) and used elsewhere in the file. FIX:
`<Button type="submit" variant="primary">`.

### 9. `session-color` — Rule B drift: `TaskTimeWarningPopup` uses raw `amber-700/orange-700`
**`src/components/TaskTimeWarningPopup.jsx:31-50`** · votes 2/3
Header `bg-gradient-to-r from-amber-700 to-orange-700` and the dismiss button's amber classes
are raw Tailwind palette, not the `session-break-*` / `feedback-warning*` tokens. DESIGN_SYSTEM
Rule B requires session-related color to read from the one map, or it won't follow theming/dark
mode (ADR 0016) and creates a second uncoordinated amber source next to the break-session shell.

### 10. `ux-a11y` — `focus:ring-2` instead of `focus-visible:ring-2` (ring shows on mouse click)
**`src/components/TaskDetailsModals.jsx:183-209`** (also TaskModal 1405/1580/1771/1888;
WorkPlanner 1056/1066/1371) · votes 3/3
The comment-edit / new-comment textareas and the checklist add-input use `focus:ring-2` with no
`focus-visible` guard, so the ring fires on mouse click too — inconsistent with the project's
`focus-visible:` convention (DESIGN_SYSTEM §7). FIX: swap `focus:` → `focus-visible:` (mechanical).

### 11. `discipline` — `ManagerNotifications` cards bypass `<Card>`
**`src/components/ManagerNotifications.jsx:78, 929, 1360`** · votes 2/3
Notification rows + a skeleton use the literal `rounded-card border border-line bg-surface-card
shadow-sm` combo that `<Card>` encapsulates; `Card` is not imported. FIX: use `<Card>`.

### 12. `discipline` — `Reports.jsx` summary panels bypass `<Card>`
**`src/components/Reports.jsx:1234, 1246, 1389, 1402`** · votes 3/3
`PersonalSummaryPanel`/`TeamSummaryPanel` wrappers inline the same Card token combo instead of
`<Card>` (which is not imported, though `Button`/`IconButton` are). FIX: use `<Card>`.

### 13. `crashsafety` — `notify()` Firestore failures are only `console.error`, never `logError`
**`src/utils/notify.js:57-61`** · votes 3/3
The single notification-write funnel (used for completion, assignment, time-extension, session
auto-close, …) logs `addDoc` failures only to `console.error`. On a field phone with no devtools,
a systematic `request_notifications` failure (rule regression, quota, outage) leaves **no durable
trace** in the ring buffer or `error_logs`. No session-time data loss, but the failure is
invisible to an admin diagnosing "workers aren't getting notified." FIX: route through `logError`.

### 14. `crashsafety` — Partial-session rename failures swallowed with `console.warn`
**`src/utils/sessionActions.js:621-627, 728-734`** · votes 2/3
When a call/quick-work session ends, the retroactive rename of the interrupted `isPartial:true`
`work_sessions` row uses `.catch(console.warn)` not `logError`. Cosmetic (credits already
committed), but a systematic failure leaves partial rows stuck on the generic placeholder title
in timelines/reports with no diagnostic trail. FIX: `logError`.

### 15. `session-color` — Rule B drift: `ActiveWorkSessions` label uses bare `text-xs` not `text-caption`
**`src/components/ActiveWorkSessions.jsx:444`** (also line 508) · votes 2/3
The session-label line uses raw `text-xs` instead of the `text-caption` token. Both are 12 px
today, so the 12 px floor is met, but the non-token class drifts from the system (DESIGN_SYSTEM
§2 P4) — if `text-caption` is later bumped for a11y, this line stays at 12 px. FIX: use `text-caption`.

---

## Dimensions with no confirmed findings
`i18n-brand`, `perf`, `docsdrift`, `deadcode`, and `firebase-coupling` produced no
**confirmed** findings in the verified 40. (Some of their finds may sit in the unverified 50 —
see the remainder note. The deterministic `04-tests.md` separately flags the stale "no test
runner" claim in the plan/workflow headers as a docsdrift ℹ️.) One notable verify-stage
rejection: a finder claimed an overflow-x table at `Reports.jsx:2117-2135`, but the file is only
1489 lines — correctly refuted as a hallucination.
