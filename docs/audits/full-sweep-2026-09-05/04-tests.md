# 04 — Test gate (deterministic)

**Commands:** `npm test` (vitest) · `npm run test:functions` (bare node) · `npm run test:firestore`
(Firestore emulator, `demo-workz-timer`) — i.e. the full `test:all` release gate.
**Raw:** `04-tests-raw.txt`, `04-tests-functions-raw.txt`, `04-tests-firestore-raw.txt`
**Findings:** 🔴 0 · 🟠 3 · 🟡 4 · ℹ️ 2

## Result — all green

| Suite | Files | Tests | Time | Exit |
|---|---|---|---|---|
| `vitest run` (unit + jsdom) | 95 passed · 5 skipped | **1433 passed** · 118 skipped | 54.2 s | 0 |
| `test:functions` (integrityScans · decisionLog · workDay · discovery) | 4 passed | all assertions | ~1 s | 0 |
| `test:firestore` (emulator: adminSdk 6 checks + 5 integration files) | 5 passed | **118 passed** | 35.6 s | 0 |

The 118 "skipped" in the plain `npm test` run are exactly the 5 emulator files
(`src/integration/firestore/*.integration.test.js`) that self-skip without
`FIRESTORE_EMULATOR_HOST`; `test:firestore` ran them and all 118 pass. So the whole gate is
**1551 tests, 0 failures**, 105 test files on disk (100 vitest + 5 `.cjs`).

Notable evidence from the run:

- `discovery.test`: `functions/index.js` loads under firebase-admin 14.3.0 / firebase-functions
  7.3.2 → 24 endpoints (15 event, 3 callable, 6 schedule), all gcfv2 `europe-west1`.
- `securityRules.integration.test.js` loaded `firestore.rules` into the emulator → the ruleset
  **compiles** (this is the only rules-validity evidence available this run, since the Firebase
  MCP was unreachable — see `06-firebase.md`).
- No warnings, deprecations or unhandled rejections in any of the three raw logs.

## Coverage gaps (named per module — "no tests" is no longer true for WORKZ)

Method: every `src/utils/*.js` and `src/hooks/*` module was checked for a `*.test.*` with the
same basename anywhere under `src/`; the hits below have none. Severity follows the plan's rule:
time-tracking / session / crash-safety paths without a guarding suite are 🟠.

### 🟠 Likely — unguarded against regression on the time-tracking path

- 🟠 **`src/hooks/useRevisionedTaskRecovery.js` (195 LOC) — no dedicated suite.** This is the
  device-scoped recovery of orphaned *task* runs for the revisioned timer engine (which is now on
  for everyone): it awaits the server-clock anchor, filters to runs owned by this device
  (`isOwnedByThisDevice`), plans a recover via `planTaskRecover`, and raises refused-gap claims.
  The engine beneath it is covered (`timerCommandEngine.test.js`,
  `revisionedTimerEngine.integration.test.js`, `timerTransitionPlan.test.js`), but the hook's own
  sequencing — anchor-first, this-device-only, notice/claim side effects — is exactly the ADR 0026
  contract and has no test that would fail if it were loosened. Effort M.
- 🟠 **`src/hooks/useRevisionedSecondaryRecovery.js` (153 LOC) — same gap for quick-work / call
  / break sessions.** Same reasoning; a regression here silently drops or double-credits a
  secondary session after a crash. Effort M.
- 🟠 **`src/hooks/useTimerState.js` (169 LOC), `useActiveTaskElapsedMinutes.js` (66),
  `useActiveSecondarySession.js` (74) — the displayed-elapsed derivation has no tests.** The
  ledger math is locked (`timeUtils.test.js` 806-LOC module, `sessionProjection.test.js`), but the
  hooks that turn ledger + running anchor into the number the worker sees are not. A wrong
  displayed elapsed is the class of bug the founder gets reported as "the timer shows the wrong
  time" and cannot triage from the ledger. Effort S–M (pure-function extraction + tests).

### 🟡 Risk

- 🟡 **`src/utils/sessionColors.js` (96 LOC) has no test locking the `SESSION_COLORS` map
  shape.** This is the signature whole-screen invariant (DESIGN_SYSTEM §2/§4); a one-line test
  that every session kind has `bg`/label/icon entries and that no two kinds share a hue would make
  Rule B drift a test failure instead of a visual regression. Effort S.
- 🟡 **`src/utils/calendarApproval.js` (85 LOC) untested.** Approval is keyed to affected time
  ("future = free") and the enforcement is client-only (a known pre-existing gap) — so the client
  logic *is* the control, and it has no guard. Effort S.
- 🟡 **`src/hooks/useModalA11y.js` (129 LOC) untested.** It is THE dialog hook (focus trap,
  escape, inert background, two deliberately split effects). A regression breaks keyboard access
  in every modal at once; jsdom can exercise it. Effort S.
- 🟡 **`src/hooks/useManagerData.js` (121 LOC) untested.** The manager's `onSnapshot` fan-in;
  the perf dimension's listener-cleanup rule has no test backing here. Effort S.

### ℹ️ Informational

- ℹ️ Other untested utils are leaf/plumbing modules where a unit test adds little:
  `priority.js` (labels/colours), `reportData.js` (`gatherReportData` I/O shell over the tested
  `reportAggregate`), `boardOrder`, `badgeCatalog` (data), `messaging`/`localNotify`/`notify`
  (browser push APIs), `soundUtils` (429 LOC audio), `imageUtils`, `migrateDB` (legacy),
  `haptics`, `download`, `cn`, `colors`, `formUtils`, `statsPeriods`, `taskConstants`,
  `workLocation`, `callContacts`, `aiActions`, `recurringActions`, `timerTransitionExecutor`
  (24-LOC executor over the 1959-LOC tested plan), `dndA11y`, `linkify` (component-level
  `Linkify.test.js` exists). Untested hooks of the same kind: `useAssigneeAffinity`,
  `useFullBleed`, `useInstallPrompt`, `useIsTaskRunning`, `useMediaQuery`,
  `useNotificationPermission`, `usePendingApprovalsCount`, `useReorderableTasks`,
  `useRovingFocus`, `useSessionNotification`, `useSimilarTaskHistory`, `useSpeechDictation`,
  `useUndoableAction`.
- ℹ️ There are no component render tests beyond helper-level suites (`TaskTable.selfDirected`,
  `UserManagement.roster`, `AllUsersCalendar.timeline`, …). That matches the project's testing
  philosophy (utils + Firestore integration), and the design-system invariants are enforced by
  `sourceConsistency.test.js` instead.
