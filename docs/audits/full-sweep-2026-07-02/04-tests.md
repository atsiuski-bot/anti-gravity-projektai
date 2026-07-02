# 04 — Test gate (deterministic)

**Command:** `npm test` (`vitest run`)
**Result:** ✅ PASS — 60 test files, **745 tests, 745 passed**, 0 failed. Duration 9.0 s.

## Coverage-gap notes (for the reasoning track to weigh)

The suite is pure unit tests over `src/utils/*` (time math, session/report logic, firebase
consistency invariants). Not exercised by any test:

- 🟠 **Hook-level timer orchestration** — the heartbeat interval, visibility handlers, and
  recovery-modal wiring in `src/hooks/` run only in the browser; regressions there are
  invisible to the gate. (Partially mitigated by `resolveUntrackedGap` extraction + 7 tests
  in `524fc16`.)
- 🟡 **Cloud Functions** (`functions/index.js`, ~2000 lines, 21 exports incl. the
  `dailyIntegrityScan` → `autoStopForgottenTimers` path) — no test harness at all; only lint.
- 🟡 **Firestore rules** — no rules-emulator tests; invariants are locked client-side via
  `firebaseConsistency.test.js` only.

Raw output: `04-tests-raw.txt`.
