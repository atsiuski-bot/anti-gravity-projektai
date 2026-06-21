# Reasoning track — confirmed findings (triage-sweep)

**Status:** ✅ COMPLETE (with a coverage cap — read the caveat)
**Confirmed:** 🔴/high 11 · 🟠/medium 14 · 🟡/low 2 = **27** (false positives filtered: 13)

## Method

`Workflow({ name: 'triage-sweep' })` — 11 read-only finders (one per dimension, Sonnet) →
dedup by `file:line:title` → up to 3 adversarial skeptics per finding (Opus, three lenses:
correctness / hidden-purpose / reproducibility), strict majority confirms. Raw confirmed +
rejected data is preserved in `_triage-raw-slim.json` (this run's slim export).

**Measured cost:** find **126,576** · verify **410,425** · **total 537,001** output tokens.
131 subagents, 1461 tool uses, ~23 min wall-clock.

> ⚠️ **COVERAGE CAP — the most important caveat.** The find phase produced **104** deduped
> findings but verification was capped at **`maxFindings=40`**. Because findings are verified
> in dimension order, the 40 verified items came **only from the first 5 dimensions**
> (`discipline`, `timetracking`, `crashsafety`, `session-color`, `security`). The remaining
> **64 findings were never verified**, and dimensions **6–11 — `firebase-coupling`,
> `ux-a11y`, `i18n-brand`, `perf`, `docsdrift`, `deadcode` — received essentially zero
> adversarial scrutiny** in this run. The deterministic track partially backstops two of
> them (Firebase rules in `06-firebase.md`, the DEPLOY-doc drift), but `firebase-coupling`
> (the missing-rule / `FAILED_PRECONDITION` index risk), `perf` (onSnapshot listener leaks),
> `ux-a11y`, `i18n-brand`, and `deadcode` are **uncovered**. See the synthesis follow-up for
> the scoped re-run that closes this gap — it was **not** auto-launched (cost discipline:
> the reasoning track runs once, never loops).

> **Note on overlap:** the two `session-color` confirmations (ActiveWorkSessions,
> CombinedHoursSummary) are the **same defects** as discipline findings #3/#4 — two
> independent finders + two verifier panels both confirmed them, which *strengthens* the
> signal. They are merged in `00-SYNTHESIS.md`; both are listed here for fidelity.

---

## 🔴 High (11)

### Security — privilege / authorization (3)
- `firestore.rules:59-116` — **Lateral read/write across every per-user collection — no
  ownership scope** [security · 3/3] — every collection holding per-user work data (`tasks`,
  `shift_logs`, `work_sessions`, `break_sessions`, `daily_stats`, `work_hours`,
  `archived_tasks`, `deleted_tasks`, `calendar_notifications`, `calendar_requests`,
  `request_notifications`, `task_templates`) is guarded only by `isUserActive()` with **no**
  `request.auth.uid == resource.data.userId` check. Any active worker can read/write/delete
  any other worker's documents — falsify timer minutes, forge shift logs, delete a
  colleague's tasks — FIX: add per-document ownership predicates (owner uid + manager/admin
  escape) to each collection; this is the headline data-integrity hole.
- `firestore.rules:84-86` — **Worker can self-approve `work_hours` requests** [security · 3/3]
  — the approval workflow decides auto-approve via a *client-side* `isManagerRole()` check
  (`WorkPlanner.jsx:495-536`), but the rule is the flat `isUserActive()`. A direct SDK write
  bypasses the React app entirely and adds/updates/deletes any `work_hours` doc without
  manager approval — FIX: enforce the worker-vs-manager distinction in the rule, not only in
  the client.
- `firestore.rules:59-61` — **Worker can mark any task `confirmed` as if a manager**
  [security · 3/3] — completion/confirmation fields (`status:'confirmed'`, `confirmedBy`,
  `isApproved`) are written client-side from the client-resolved `userRole`; with `allow
  write: if isUserActive()` and no field-level constraint, a forged SDK call confirms any
  task, defeating manager approval — FIX: field-level rule constraints gating the
  approval fields to managers/admins.

### Time-tracking integrity (2)
- `src/utils/sessionActions.js:209-211` — **`endSession` writes `durationMinutes` with no
  negative/skew guard** [timetracking · 2/3] — `(now - start)/60000` is written
  unconditionally; a backward device-clock (or a stale future `startTime`) makes it
  negative, then it permanently corrupts the `work_sessions` log row and is subtracted from
  the running break total. `pauseTask` guards the identical math with `elapsedMinutes >= 0`
  (`taskActions.js:95`); `endSession` does not — FIX: apply the same `>= 0` (and an upper
  sanity cap) before persisting.
- `src/utils/automationUtils.js:132-137` — **03:00 archive cutoff uses browser-local
  `getHours()`, not Vilnius time** [timetracking · 3/3] — `getLithuanianNow()` returns a
  plain `new Date()`, so `now.getHours() < 3` reads the *browser* timezone. Off-Vilnius
  workers roll the cutoff a full day the wrong way → yesterday's confirmed tasks either
  fail to archive or archive two hours early — FIX: derive the Vilnius hour via
  `Intl.DateTimeFormat` (the pattern already used by `getLithuanian3AMCutoff`).

### Crash-safety (2)
- `src/utils/timeUtils.js:70-80` — **No crash/reload recovery for an orphaned running task
  → ghost-time accumulation** [crashsafety · 3/3] — `calculateCurrentTotalMinutes()` adds
  `(now - timerStartedAt)` whenever `timerStatus==='running'`, uncapped, and **nothing**
  on app load detects a task left `running` after a crash and auto-pauses it. The next
  manual Pause credits the entire offline interval as real work (crash 09:00 → reload 17:00
  = 8 ghost hours written to `work_sessions`) — FIX: on load, detect stale `running` +
  old `timerStartedAt`, auto-pause and cap the credited elapsed to a sane bound.
- `src/utils/sessionActions.js:50-54` — **`pauseTask` failure during `startSession`
  silently swallowed — task stays `running` with stale start** [crashsafety · 3/3] — the
  `.catch` only `console.warn`s and resolves `undefined`, so `Promise.all(...)` always
  "succeeds"; if the task-pause write actually failed (offline/Firestore error), the task
  keeps `timerStatus:'running'` + the pre-break `timerStartedAt` and later credits the whole
  break as work. The failure also never reaches `logError` — FIX: surface the failure
  (retry/durable log) instead of swallowing; route it to `logError`.

### Design-system discipline (4)
- `src/components/TaskModal.jsx:534` — **Bespoke full-screen dialog instead of canonical
  `Modal`** [discipline · 3/3] — hand-rolled `fixed inset-0 z-[100] bg-black bg-opacity-50`
  shell re-implementing portaling/focus/Escape/sizing that `ui/Modal.jsx` already
  centralizes; `z-[100]` is off the managed z-ladder — FIX: replace with `<Modal size="xl">`.
- `src/components/TaskDetailsModals.jsx:7-57` — **`DetailsModal` bespoke shell, cascading to
  4 children** [discipline · 3/3] — own overlay with `z-50` + `bg-black bg-opacity-50`, own
  focus-trap/Escape; `LinksModal`, `CommentsModal`, `DescriptionModal`,
  `TimeAdjustmentsModal` all compose it, so the violation multiplies — FIX: route all four
  through the canonical `Modal`.
- `src/components/ActiveWorkSessions.jsx:46-94` — **Session color palette hard-coded, not
  read from `SESSION_COLORS`** [discipline · 3/3] — switch literals (`bg-amber-100`,
  `bg-blue-100`, `bg-red-100`, `bg-green-100`) for break/call/quickWork/task; `sessionColors.js`
  exists *specifically* to kill this drift — FIX: source from `getSessionColors()`. *(Same
  defect as session-color #1.)*
- `src/components/CombinedHoursSummary.jsx:201-243` — **Second, divergent hard-coded session
  palette** [discipline · 3/3] — uses `bg-orange-100` for break and `bg-sky-100` for call —
  disagreeing with both `SESSION_COLORS` *and* ActiveWorkSessions — FIX: source from
  `getSessionColors()`. *(Same defect as session-color #2.)*

---

## 🟠 Medium (14)

### Time-tracking (3)
- `src/utils/timeUtils.js:70-82` — **Live elapsed added from a stale `timerStartedAt` with
  no cross-device skew cap** [timetracking · 2/3] — device-B opens a task device-A left
  `running`; `(now - timerStartedAt)` is added uncapped → wildly inflated total that even
  trips the auto-pause limit alarm — FIX: cap implausibly large positive elapsed.
- `src/components/DailyStatistics.jsx:86-92` — **`break_sessions` queried by naive ISO
  string range on `startTime`** [timetracking · 3/3] — `${date}T00:00:00`..`T23:59:59`
  (no TZ) compared lexically against UTC `toISOString()` values → post-midnight Vilnius
  breaks vanish, and 00:00–03:00 breaks (previous Vilnius work-day) wrongly included.
  `Reports.jsx` correctly uses the `date` field — FIX: query the `date` field, not raw
  `startTime`.
- `src/utils/automationUtils.js:25-41` — **Deadline promotion compares local-midnight
  `Date`s, not Vilnius dates** [timetracking · 2/3] — `new Date(todayStr)` and
  `new Date(task.deadline)` extracted at browser-local midnight; a UTC-stamped deadline lands
  on the wrong calendar day → priority promotion fires a day late — FIX: do the date math in
  Vilnius consistently.

### Crash-safety (2)
- `src/utils/sessionActions.js:174-177` — **`startSession` catch logs to console, never
  `logError`** [crashsafety · 3/3] — every caller re-catches with `console.error` only, so a
  Firestore/permission/network failure never reaches the durable ring buffer or remote
  `error_logs` — invisible in the field — FIX: route to `logError`.
- `src/utils/sessionActions.js:365-367` — **`endSession` catch swallows failure (no rethrow,
  no `logError`)** [crashsafety · 3/3] — if the critical `updateDoc(userRef,...)` throws,
  session state is left in limbo with no durable record — FIX: `logError` + surface to caller.

### Security (1)
- `firestore.rules:41-43` — **Disabled user can still read the entire `users` collection**
  [security · 3/3] — `/users` read is gated on `isAuthenticated()` not `isUserActive()`; a
  just-disabled account keeps a valid token up to ~1 h and can read every user's name, email,
  role, `activeSession`, `breakState` — FIX: gate read on `isUserActive()` (writes already do).

### Session-color (2) — *merged with discipline #3/#4 in synthesis*
- `src/components/ActiveWorkSessions.jsx:45-94` — **Rule B drift: hard-coded color classes
  bypass `getSessionColors`** [session-color · 3/3].
- `src/components/CombinedHoursSummary.jsx:200-244` — **Rule B drift: duplicated mapping with
  values that disagree with `SESSION_COLORS`** [session-color · 3/3].

### Design-system discipline (6)
- `src/components/TaskDetailsModals.jsx:391-473` — **`ImageLightbox` uses unmanaged
  `z-[9999]`/`z-[10000]` + `bg-black bg-opacity-95`, raw `<button>`s** [discipline · 3/3] —
  far off the z-ladder; FIX: token z-values, token scrim, `IconButton`.
- `src/components/ManagerNotifications.jsx:428-630` — **Action CTAs are raw `<button>`s
  duplicating the `Button` contract** [discipline · 3/3] — Patvirtinti/Atmesti/Supratau/etc.
  re-implement `rounded-control min-h-touch` styling inline — FIX: `<Button variant=…>`.
- `src/components/CallTimer.jsx:59-63` — **Raw hex in inline style** (`#e5e7eb`, `#000`)
  [discipline · 3/3] — FIX: token classes (`border-line`, `text-ink-strong`).
- `src/components/QuickWorkTimer.jsx:61-65` — **Same raw-hex inline style** (copy of CallTimer)
  [discipline · 3/3] — FIX: token classes.
- `src/components/AllUsersCalendar.jsx:19,235` — **Raw hex `VACATION_COLOR='#A5B4FC'` +
  grid `#e5e7eb` in inline styles** [discipline · 3/3] — FIX: route through tokens.
- `src/components/DailyWorkProgress.jsx:195,238,246` — **Raw `bg-blue-500`/`bg-indigo-500`
  passed as colorClass args** [discipline · 2/3] — FIX: session/brand tokens.

---

## 🟡 Low (2)
- `src/components/CallTimer.jsx:282` — **Active call card mixes token surface with raw
  `border-blue-200 text-blue-900 ring-blue-200`** [discipline · 3/3] — split sourcing; FIX:
  use `SESSION_COLORS.call` tokens for the foreground too.
- `src/utils/sessionActions.js:54` — **Fire-and-forget task-pause failure not sent to
  `logError`** [crashsafety · 3/3] — intentional fire-and-forget, but unlike the analogous
  `pauseTask` write it never reaches the durable log — FIX: add `logError` in the `.catch`.

---

## False positives filtered (13 rejected — recorded for transparency)

The adversarial pass rejected 13 finder claims; the notable ones:

- **Hardcoded Firebase web API key in `src/firebase.js:7-13`** [security · 0/3] — rejected:
  Firebase *web* API keys are not secrets (they identify, not authenticate; access is gated
  by the security rules). Real exposure is the missing ownership scope, not the key. *(The
  committed debug scripts `fetch_task.*` were also rejected as a security finding for the
  same reason — but note the deps phase flags `firebase-admin`'s presence in production
  `dependencies` as a real supply-chain issue; different angle, see `19-deps.md`.)*
- **`DeleteConfirmationModal` duplicates `ConfirmDialog`** [discipline · 1/3] — rejected by
  majority despite looking similar to the confirmed modal findings (one skeptic agreed).
- **Partial quickWork/call work_session double-count** [timetracking · 0/3] — rejected: the
  resumed-session start time is handled correctly; no real double-count.
- **`pausedSession` nesting overwritten on second interruption** [crashsafety · 0/3],
  **`calendarNotifications` weekId local-clock** [timetracking · 1/3],
  **Rule C red header in `TaskTimeLimitPopup`** [session-color · 0/3],
  **`TaskModal` raw `error.message` in reject string** [discipline · 0/3] — all rejected
  (Chesterton's-fence / mitigated / not reachable).

Full reject detail with per-skeptic reasoning is in `_triage-raw-slim.json`.
