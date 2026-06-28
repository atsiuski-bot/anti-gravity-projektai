# Phase 04 — Tests (vitest)

**Status:** ✅ COMPLETE
**Findings:** 🔴 0 · 🟠 3 · 🟡 4 · ℹ️ 1

## Method
`npm test` → `vitest run` (vitest v4.1.9). Raw output in `04-tests-raw.txt`. Coverage gaps
derived by diffing the tracked `*.test.js` set against the `src/utils/` + critical-path
modules (`git ls-files '*.test.js'` vs `src/utils/*.js`). A failing test → 🔴; a critical
path with no guarding suite → 🟠/🟡 "unguarded against regression" (named per-module).

## Result
- **52 test files passed (52) · 631 tests passed (631) · 0 failed.** Duration 4.5 s.
- No failing or skipped tests. The suite is green at HEAD `bb42809`.
- Coverage is broad: `timeUtils`, `sessionActions`, `sessionLock`, `sessionEditActions`,
  `sessionAdmin`, `taskActions`, `taskPermissions`, `taskStatus`, `taskSort`, `errorLog`,
  `recurrence`, `automationUtils`, `reportAggregate`, `workerStats`, the entire
  `src/domain/commands/` command layer, the notification `registry`, and a
  `firebaseConsistency` lockstep test all carry suites.

## Findings
### 🔴 Critical
_(none — suite is fully green)_

### 🟠 Likely — critical-path modules with NO co-located unit test
- `src/utils/calendarNotifications.js` — **time-math, untested.** The skill names this an
  explicit time-integrity module (week-boundary detection, Europe/Vilnius vs UTC). A
  timezone or week-cutoff regression here would silently misfile calendar-change
  notifications with no test to catch it. WHY 🟠: time correctness is WORKZ's core and this
  module has zero direct guard. FIX: add a suite covering the week boundary at the Vilnius
  DST transitions and the UTC/local split.
- `src/utils/payRate.js` — **money math, untested.** Tiered NET hourly rates + after-tax
  earnings (LT ~29.22%) drive the earnings popup (ADR 0012). No co-located test guards the
  tier selection or the tax arithmetic — a rounding or tier-boundary regression would
  mis-state pay. FIX: add a suite over tier boundaries and the net→gross calc.
- `src/utils/taskCompletionActions.js` — **session-lifecycle write path, untested.** The
  finish/complete flow (split out of `taskActions`, which IS tested) writes the credited
  duration + completion fields. No direct suite. FIX: cover the completion-status
  resolution and duration write.

### 🟡 Risk — secondary modules with no co-located test
- `src/utils/recurringActions.js` — the Firestore WRITE side of recurrence (the pure
  `recurrence.js` generator is well-tested; the action layer that persists is not).
- `src/utils/reportData.js` — multi-worker report data assembly (the pure
  `reportAggregate.js` is tested; the fetch/shape layer is not).
- `src/utils/teamScope.js` — the scoped-manager / senior-overseer visibility closure (ADR
  0005/0007). Security-adjacent; a closure bug widens/narrows who sees what. No direct test.
- `src/utils/boardOrder.js` — priority-board fractional `boardRank` arithmetic (drag
  reorder). The canonical sort `taskSort.js` is tested; the rank-insertion math is not.

### ℹ️ Info
- The plan's preamble and the triage-sweep header still claim WORKZ has "no test runner."
  That is **stale** — there is a full vitest suite (52 files / 631 tests). Recorded here for
  the `docsdrift` dimension; the live finding is in `00-reasoning-confirmed.md` if confirmed.
