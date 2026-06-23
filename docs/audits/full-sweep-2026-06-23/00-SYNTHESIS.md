# Full Sweep — Synthesis & prioritized fix list

**Date:** 2026-06-23 · **SHA:** `d3a7bd7` · **Branch:** `claude/stoic-proskuriakova-aad0bf`
**Verdict:** ✅ **No 🔴 critical findings.** The build, lint, and test gates are green; the
deployed Firebase rules are functionally in sync with the repo. The confirmed findings are
contract-drift, time-zone, design-discipline, and bounded-integrity items — none is a
data-loss or privilege-escalation vector that breaks production today.

## Totals (after cross-track dedup + rubric re-map)
| | 🔴 Critical | 🟠 Likely | 🟡 Risk | ℹ️ Info |
|---|---|---|---|---|
| Deterministic | 0 | 2 | 3 | 5 |
| Reasoning (confirmed) | 0 | 6 | 14 | — |
| **Merged total** | **0** | **8** | **~14** | **5** |

- Reasoning track: **90 raw → 90 deduped → 40 verified → 20 confirmed** (20 false positives
  filtered by the adversarial-verify stage).
- **Reasoning cost (measured):** find 132,680 + verify 398,256 = **530,936 output tokens**
  (131 agents · ~21 min wall-clock).

> **Severity mapping note.** triage-sweep emits high/medium/low; this synthesis re-maps onto
> the sweep's §5 rubric. Most "high" discipline items are **🟡 pattern-violations** (they
> render and behave correctly — they violate the canonical-component rule, not correctness).
> The time-zone and rules-integrity items are **🟠** (silent drift / bounded tampering).

---

## 🟠 LIKELY — fix in the next maintenance pass (8)

### Security / data-integrity (rules)
1. **`work_hours` UPDATE does not pin `userId` — an owner can re-assign their record to
   another user.** `firestore.rules:270` — `ownsUserId()` checks the *existing* doc's owner
   but the update may rewrite `userId` to a colleague's uid, moving planned/logged hours onto
   someone else's record and polluting their reports. Confirmed 3/3. **The most concrete
   integrity gap in the sweep.** → FIX (S): add
   `request.resource.data.userId == resource.data.userId` to the `work_hours` update rule
   (and audit the other owned collections for the same unpinned-owner pattern).
2. **A worker can self-forge a `confirmed`/`approved` task on CREATE via the raw Firestore
   API.** `firestore.rules:200-204` — `changesApprovalFields()` guards UPDATE only; CREATE is
   deliberately unguarded so the call/quick-work auto-log can write an already-confirmed task.
   Confirmed 3/3. This is a **documented tradeoff** (see the rule comment), not an oversight,
   but it lets a worker bypass the approval workflow for self-created tasks. → FIX (M): if the
   approval workflow's integrity matters, gate CREATE to reject client-set
   `status in ['confirmed','approved']` *except* on the auto-log path (e.g. require a
   `source:'auto'` marker the auto-logger sets), without breaking call/quick-work.

### Time-zone correctness (the heart of WORKZ)
3. **`archiveOldTasks` compares a UTC date against a Vilnius date string → archives a day
   early.** `src/utils/automationUtils.js:153-154` — `relevantDate.split('T')[0]` yields the
   **UTC** calendar date; it is compared against a Vilnius cutoff. In summer (UTC+3) a task
   confirmed 21:00–24:00 Vilnius gets a UTC date one day earlier and is archived one cycle too
   soon. Confirmed 3/3. → FIX (S): bucket `relevantDate` through
   `getLithuanianDateString(new Date(relevantDate))` first — exactly what
   `checkAndPromoteTasks` already does for deadlines (line 40).
4. **Calendar-notification `weekId` is computed in browser-local time on both sides → silent
   cross-device notification loss.** `src/utils/calendarNotifications.js:11-12` (write) and
   `src/components/ManagerNotifications.jsx:52-54` (read) independently derive
   `${uid}_${weekId}` from each device's **local** clock (note: `getLithuanianNow()` is a
   no-op `new Date()` wrapper). Near the Monday boundary, a worker and manager in different
   offsets compute different week strings and the notification document never matches.
   Confirmed (2/3 + 3/3 — same root cause, two sites; **fix together**). → FIX (M): derive the
   week key from `getLithuanianDateString` + Monday-of-week arithmetic so both sides agree.

### Crash-safety observability
5. **`startTask` / `resumeTask` throw without `logError` — timer-start failures never reach
   the durable ring buffer.** `src/utils/taskActions.js:73-76`. Confirmed 3/3. A failed start
   is invisible to the crash log that exists precisely to catch these. → FIX (S): wrap the
   throw paths in `logError` before rethrowing.
6. **`pauseTask` catch does not call `logError` — the failure that *causes* ghost time is
   invisible.** `src/utils/taskActions.js:165-170`. Confirmed 2/3. When a pause write fails,
   the timer keeps running and credits ghost time on the next pause, yet nothing is logged. →
   FIX (S): add `logError` in the catch.

### Test coverage (deterministic)
7. **`react-router-dom` open-redirect XSS (HIGH) — the one advisory that ships.** Pinned
   `^6.22.1`; the lockfile already wants the patched 6.30.4. → FIX (S): `npm audit fix` (NOT
   `--force`), re-run lint+build+test, commit the lockfile. (Full dep triage in
   [19-deps.md](19-deps.md) — the other 46 advisories are dev/build/admin tooling that never
   ships to the browser, incl. both "criticals" — `vitest`, `protobufjs`.)
8. **Stateful time-credit / orphan-recovery paths have zero test coverage.** The new suite
   (86 passing tests) is pure-`utils`-only; `sessionActions.js` / `taskActions.js`
   pause/resume credit math and `errorLog.js` remain unguarded — the exact paths findings
   5–6 above touch. → FIX (L): add integration tests for pause/resume credit math and orphan
   recovery; wire `npm test` into the deploy gate.

---

## 🟡 RISK — design-discipline & polish (grouped; ~14 findings)

These render and behave correctly; they violate the **canonical-component / token** rules in
`DESIGN_SYSTEM.md`, drift from the `SESSION_COLORS` map, or miss an a11y affordance. Best
fixed as **two coherent sweeps**, not piecemeal. Full detail in
[00-reasoning-confirmed.md](00-reasoning-confirmed.md).

**A. Bespoke modal shells → route through canonical `Modal` / `ConfirmDialog` (effort M–L).**
Four components hand-roll their own `fixed inset-0 … bg-feedback-scrim` shell instead of the
one canonical shell (`src/components/ui/Modal.jsx`):
- `src/components/TaskDetailsModals.jsx` (3 shells: details, image-viewer, delete-confirm)
- `src/components/TaskModal.jsx:695` (top-level frame)
- `src/components/WorkPlanner.jsx` (3 modal scaffolds + 2 raw `<select>`)

  Nuance: `DeleteConfirmationModal` has a 3-way branch `ConfirmDialog`'s 2-button API can't
  express — route its custom body through `Modal` with `bare`, don't force `ConfirmDialog`.

**B. Color-token / session-palette drift → read from `SESSION_COLORS` / feedback tokens
(effort M).** Raw Tailwind colors instead of tokens:
- `ActiveSessionReadout.jsx:11-30` (duplicates the session palette in a local map)
- `CallTimer.jsx:229`, `QuickWorkTimer.jsx:49,284,323`, `BreakTimer.jsx:157` (session ring/
  border/text colors hardcoded — also a §4 Rule-B session-color drift)
- `ManagerNotifications.jsx:623-626` (raw amber vs `feedback-warning`),
  `CombinedHoursSummary.jsx:269` (raw `bg-blue-300`)
- `Reports.jsx:1333,1521` (bare inline loading strings vs canonical `Loading`)

**C. Accessibility (effort S).** `Reports.jsx:1068-1092` tab bar is missing
`role="tablist"` / `aria-current` — screen-reader users can't tell which report tab is active.

**D. Rules hardening, low (effort S, optional).** `request_notifications` CREATE
(`firestore.rules:363-374`) can't rate-limit in-rules, so any active user can ring any
manager's device. The rule comment already acknowledges this needs a **sender-side throttle**
— track as a product hardening item, not a rules change.

**E. Bundle (effort —, watch only).** `firebase-firestore` chunk is 479 KB raw / 114 KB gz —
already code-split; flag only if a firebase major pushes it past 500 KB. ([05-build.md](05-build.md))

---

## ℹ️ INFO — context & what the verify stage caught

1. **The sweep plan itself is stale.** `FULL_SWEEP_PLAN.md` / the `/full-debug-sweep` skill
   assert WORKZ has *no test runner, no `firestore.indexes.json`, no Cloud Functions, a single
   root `package.json`.* **All four are now false:** vitest + 4 test files (86 passing),
   `firestore.indexes.json` (11 composite indexes), a `functions/` codebase (FCM senders +
   storage cleanup) with its own `package.json`/lockfile. → The plan should be updated so
   future sweeps run the test gate and audit `functions/` by default. (See
   [04-tests.md](04-tests.md), [06-firebase.md](06-firebase.md).)
2. **Live Firestore/Storage rules == repo — functionally identical.** The only diff is a
   comment renumber (ADR 0006 → 0007); every executable rule body is byte-identical. No
   deployment gap. ([06-firebase.md](06-firebase.md))
3. **The index file is effectively verified complete.** The reasoning track's
   `firebase-coupling` dimension raised **7 "missing composite index" findings — all rejected
   0/3.** The finders misunderstood Firestore: equality-only multi-field queries (and
   same-field range+orderBy) are served by automatic indexes and need no composite. This
   cross-track result **resolves** the deterministic 06-firebase 🟡 "index completeness
   asserted, not verified" — the client compound queries were enumerated and none needs an
   index beyond the 11 present.
4. **Other notable false positives the verify stage filtered** (full list in
   [00-reasoning-confirmed.md](00-reasoning-confirmed.md)): "hardcoded Firebase API key"
   (rejected 0/3 — web API keys are public client config, not secrets); nested `pausedSession`
   overwrite, orphan-recovery-runs-once, and several other crashsafety claims (rejected 0/3 on
   false premises). **This is the verify stage earning its cost** — a flat sweep would have
   reported all 40.
5. **Deferred / out-of-scope:** `functions/` subtree not dep-audited (a second lockfile with
   `firebase-admin`/`google-gax` advisories); major dep drift (firebase 10→12, react 18→19,
   router 6→7) is migration work, not `audit fix`. ([19-deps.md](19-deps.md))

---

## Recommended order of attack
1. **One-line rule fix** (S): pin `work_hours.userId` on update (#1) — highest integrity/effort ratio.
2. **`npm audit fix`** (S): clears the shipped react-router XSS (#7) + dev-tool advisories.
3. **Two time-zone fixes** (S+M): `archiveOldTasks` UTC→Vilnius (#3) and the `weekId` pair (#4).
4. **Crash-log gaps** (S): add `logError` to the start/resume/pause throw paths (#5, #6).
5. **Design-discipline sweeps** (M–L): modal-canonicalization (A) and color-token drift (B) as two focused PRs.
6. **Decide on the CREATE approval gate** (#2) — needs a product call on the auto-log tradeoff.

*The sweep changed nothing in the codebase except these findings files under
`docs/audits/full-sweep-2026-06-23/`.*
