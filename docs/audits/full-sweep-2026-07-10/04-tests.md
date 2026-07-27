# Phase 04 — Automated tests and coverage gaps

**Status:** ✅ COMPLETE  
**Findings:** 🔴 0 · 🟠 3 · 🟡 0 · ℹ️ 2

## Method

Ran both test modes at the recorded SHA: `npm test` and the isolated demo-project Firestore emulator suite, `npm run test:firestore`. Then mapped every confirmed R-01–R-14 finding to exact test coverage.

## Execution result

- Unit mode: 67 files / 847 tests passed; 2 files / 13 tests conditionally skipped because `FIRESTORE_EMULATOR_HOST` is absent.
- Emulator mode: those same 2 files / all 13 tests passed.
- Combined unique result: **69 files / 860 tests passed**. No `it.skip`, `todo`, or `only` exists; the apparent skips are intentional mode selection.

## Findings

### 🟠 Likely

- **Authorization suite gap:** R-01, R-05, R-07, and R-10 have no direct test; R-04, R-06, R-08, and R-09 have only adjacent happy-path coverage. The emulator suite currently concentrates on timer-engine state and does not test hostile profile creation, self-owned privileged fields, task approval/reassignment, manager-scope writes, compensation confidentiality, or notification recipient authority. **Fix:** add a table-driven Firestore authorization suite whose negative cases reproduce each exploit.
- **Functions/Storage gate gap:** R-02 has no test at all; R-11 only has UI/catalog arithmetic coverage. Root Vitest does not include Functions runtime tests, `functions/package.json` has no test script, and there is no Storage emulator suite. Attachment cleanup, trigger-event idempotency, signup notification dedupe, and stamp repair are not executed by a gate. **Fix:** add Functions unit/integration tests and a Storage/Admin cleanup harness, then wire them into the quality gate.
- **Timer boundary gap:** R-03 and R-12–R-14 are only partially covered. Existing tests prove ordinary clamp/CAS/batch/replay behavior but do not cover split recovery exceeding the total 16-hour budget, intentionally incomplete multi-document bundles, equal/backward outbox timestamps, or hostile clock skew against a trusted time boundary. **Fix:** add the exact adversarial cases, including the 15 h + 15 h recovery oracle (`total <= 960`).

### ℹ️ Info

- Coverage matrix for R-01–R-14: **0 fully covered · 9 partial · 5 absent**. Every item lacks an exact exploit-regression oracle even though all existing tests pass.
- Live runtime errors `writeFail:reconcileTaskTimerFromSessions` and the `useWorkerStats` missing-index failure have no targeted regression coverage. The emulator does not reliably model production composite-index requirements, so query-spec ↔ `firestore.indexes.json` parity needs a static test or production smoke gate.

## Key evidence

- `src/integration/firestore/legacyTimerFailures.integration.test.js:21-22` — conditional emulator suite, 3 tests.
- `src/integration/firestore/revisionedTimerEngine.integration.test.js:34-35` — conditional emulator suite, 10 tests.
- `src/utils/timerTransitionPlan.test.js:577-638` — recovery tests cover short intervals, not a split total above 16 hours.
- `src/utils/timerOutbox.test.js:14-47` and `src/utils/timerCommandEngine.test.js:45-58` — persistence/replay covered, dependency ordering under clock rollback is not.
- `vitest.config.js:10` — only `src/**/*.test.{js,jsx}` is included; Functions tests are outside this gate.

Raw outputs: `04-tests-raw.txt` and `04-firestore-raw.txt`.
Full per-finding matrix: `04-coverage-matrix.md`.
