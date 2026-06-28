# Fixes applied — full-sweep 2026-06-27 findings

> Applied in this worktree (`claude/stupefied-bell-8b343e`) by a 19-agent parallel fix
> workflow (one file-owner agent per file; each re-verified its finding before editing).
> **Nothing committed, pushed, or deployed.** Quality gate run centrally after all edits.

## Quality gate — ✅ all green (post-fix)
- **Lint:** `eslint --max-warnings 0` → 0 warnings.
- **Tests:** `vitest run` → **690 passed / 690** across **55 files** (was 631/52 — +59 tests,
  +3 files: `payRate`, `taskCompletionActions`, `calendarNotifications`, + timeUtils regression).
- **Build:** `vite build` → ✅ PWA SW + manifest generated.

## Outcome: 18 fixed · 1 partial · 0 skipped (false positives) · 20 files touched

### Correctness — time-math (Vilnius)
- **`src/utils/timeUtils.js`** — `getCurrentWorkDayCutoff` now compares the instant against the
  DST-safe `getLithuanian3AMCutoff(cutoffDate)` instead of device-local `getHours() < 3`. The
  work-day boundary is now Vilnius-correct on any device TZ. **+ regression tests** in
  `timeUtils.test.js` (TZ-independent UTC-ISO assertions).
- **`src/components/WorkPlanner.jsx`** — `isApprovalFeatureActive` reads weekday+hour from one
  `Intl.DateTimeFormat('Europe/Vilnius')` pass (was browser-local `getDay()/getHours()`); the
  Fri-13:00 → Sun-21:00 window semantics are preserved exactly.

### Security — Firestore rules ⚠️ (human-only deploy, post-merge)
- **`firestore.rules` — `calendar_requests` update:** added the `userId` owner-pin
  (`request.resource.data.get('userId','') == resource.data.get('userId','')`), mirroring
  work_sessions/break_sessions/work_hours — blocks the re-point/graft vector.
- **`firestore.rules` — `work_hours` create/update/delete:** replaced the blanket
  `isManagerOrAdmin()` escape with the scoped pattern
  `…ownsUserId() || canSeeWholeTeam() || (isScopedOverseer() && overseesUser(<owner uid>))`,
  preserving the shape guard + the update userId-pin. **Deliberate deviation:** uses
  `overseesUser()` not `inCallerTeam()` — `work_hours` is the one owned collection with **no
  `teamManagerIds` Cloud-Function stamp**, so `inCallerTeam()` would read `[]` and deny every
  scoped-overseer write. `overseesUser()` reads the target user's `overseerIds` closure instead
  (documented in-file). **NEEDS FOUNDER CONFIRMATION** of scoped-manager intent before deploy
  (this is a real behavior tightening: a scoped manager can no longer touch hours outside their
  subtree). Residual: `calendar_requests`' `isManagerOrAdmin()` branch was left unscoped (the
  finding's primary issue — the graft — is fixed by the pin; manager-branch scoping is a smaller,
  separate follow-up).

### Crash-safety — durable logging (silent-error cluster)
- **`src/utils/taskActions.js`** (`pauseOtherTasks`), **`src/utils/notify.js`** (the app-wide
  notify funnel), **`src/utils/sessionActions.js`** (partial-session rename ×2) — all three
  `console.error`/`console.warn`-only catches now also route through `logError` (durable ring
  buffer + `error_logs`). Control flow unchanged (still non-throwing / best-effort).

### a11y (WCAG AA)
- **`src/components/TaskTimeLimitPopup.jsx`** — photo-remove button hit area expanded to ≥44 px
  (`min-h-touch min-w-touch`, small visible glyph kept) + added a focus-visible ring.
- **`src/components/CompletionPhotoModal.jsx`** — photo-remove button hit area extended to 44 px
  via a `before:` pseudo-element (visible 24 px badge kept).
- **`src/components/TaskDetailsModals.jsx`, `TaskModal.jsx`, `WorkPlanner.jsx`** — `focus:ring-*`
  → `focus-visible:ring-*` on all affected inputs/textareas (ring no longer fires on mouse click).

### Discipline / design-system
- **`src/components/TaskDetailsModals.jsx`** — raw "Skelbti" submit `<button>` → canonical
  `<Button variant="primary">`.
- **`src/components/ManagerNotifications.jsx`, `Reports.jsx`** — hand-rolled card wrappers →
  canonical `<Card>` (visually identical; all other classes preserved).
- **`src/components/ActiveWorkSessions.jsx`** — `text-xs` → `text-caption` token (×2).

### i18n / docs
- **`vite.config.js`** — PWA manifest `description` → Lithuanian, `lang: 'lt'`.
- **`docs/audits/FULL_SWEEP_PLAN.md` + `.claude/workflows/triage-sweep.js`** — corrected the stale
  "no test runner / no Cloud Functions / no firestore.indexes.json" claims (all three now exist).
  _Residual: some same-drift claims outside the scoped regions remain — a fuller doc
  reconciliation is a separate pass._

### ⚠️ 1 partial
- **`src/components/TaskTimeWarningPopup.jsx`** — the hand-rolled amber dismiss button was
  replaced with canonical `<Button variant="primary">` (discipline fix done), but the **amber
  header gradient was left raw** (the session-color Rule-B tokenization, a 2/3 finding, was
  skipped). Worth a quick **visual check**: a brand-colored button now sits on the amber popup —
  confirm that reads well, or add a `warning` Button variant + tokenize the header in a follow-up.

## Human-only follow-ups (NOT done by this sweep)
1. **Deploy `firestore.rules`** — post-merge, from an up-to-date `main` checkout, then re-verify
   live via the Firebase MCP. Confirm scoped-manager `work_hours` intent first.
2. **Visual-QA** the `TaskTimeWarningPopup` button and the two a11y hit-area changes on a phone.
3. Optional: the `maxFindings=90` reasoning follow-up (50 finds were never verified — see
   `00-SYNTHESIS.md`), the live-Firebase re-auth/diff, and the deeper docs reconciliation.
