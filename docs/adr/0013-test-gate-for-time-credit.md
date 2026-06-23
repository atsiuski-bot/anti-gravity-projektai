# ADR 0013 — Automated test gate for the stateful time-credit paths

**Date:** 2026-06-23
**Status:** Accepted

## Context

WORKZ computes *credited work time*, which feeds reports and pay. The dangerous failure mode is
**"ghost time"**: if a task or session is left `running` with a stale `timerStartedAt`/`startTime`
after a crash, reload, or a failed pause write, the next pause/end credits the entire elapsed gap
as worked time. The 2026-06-23 full-sweep ([finding #8](../audits/full-sweep-2026-06-23/00-SYNTHESIS.md))
recorded that the test suite was **pure-`utils`-only**: the stateful pause/resume/end credit math
(`taskActions.js`, `sessionActions.js`), the orphan-recovery accounting (the two
`useOrphaned*Recovery` hooks), and the durable crash log (`errorLog.js`) had **zero** coverage —
the exact paths findings #4/#5 had just hardened with `logError`.

Separately, the `/ship` quality gate ran **lint + build only**. `npm test` was deliberately
excluded: WORKZ work happens in git worktrees under `.claude/worktrees/`, which have **no local
`node_modules`** and resolve binaries by walking up to the primary checkout's `node_modules`.
`eslint` and `vite` resolve there, but `vitest` did **not** — the parent install predated the test
suite, so `vitest` was absent from it and `npm test` failed *spuriously* (a missing-runner error,
not a real test failure). Excluding it avoided the false red but left tests un-gated.

## Decision

**1. Add coverage for the stateful time-credit paths.** New Vitest files exercise the credit math
directly against mocked Firestore (matching the established `sessionEditActions`/`automationUtils`
convention — neutralise the firebase module graph, keep `timeUtils` real except an injectable
`getLithuanianNow`):

- `taskActions.test.js` — pause credit math (`now − timerStartedAt`), the clamp, the
  double-credit guard (a paused task clears `timerStartedAt`), orphan-task recovery (a multi-day
  stale timer credits the 16 h ceiling, not the gap), and `logError` on the start/resume/pause
  failure paths.
- `sessionActions.test.js` — start/end session, single-level `pausedSession` nesting and its
  partial-segment log, the `endSession` clamp (negative/large), and the orphan-session recovery
  call (`skipResume`, no task resume), plus the durable-log-on-failure path.
- `errorLog.test.js` — the localStorage ring buffer (capped at 30), the Firestore sink, the
  dedupe window, uid stamping, and the never-throws isolation. Runs in the node environment with
  `vi.stubGlobal` for `localStorage`/`window`/`navigator` — no jsdom dependency added.
- `useOrphanedSessionRecovery.test.js` — `getSecondarySession` (exported pure, no behaviour
  change) decides *which* live session the hook hands to `endSession`.
- `timeUtils.test.js` — extended `calculateCurrentTotalMinutes` cases (the `timeChanged`
  double-count guard, combined composition, NaN-skew, non-running).

The orphan-recovery hooks' React wiring is **not** rendered: the project has no React test
harness, and the recovery *time accounting* — "an orphan is recovered with clamped credit and no
resume" — is proven at the action layer the hooks delegate to (`pauseTask`/`endSession` with
orphaned inputs). This keeps the suite pure-node and dependency-light, consistent with the
existing convention. (See the residual note below.)

**2. Wire `npm test` into the `/ship` gate, guarded by a runner-resolvability preflight.** Step 5
of `/ship` now runs `npm run lint` → `npm run build` → the test gate. The test gate first checks
`node -e "require.resolve('vitest/package.json')"`:

- **resolves** → run `npm test` (`vitest run`); a non-zero exit **STOPs** the ship.
- **does not resolve** → **STOP** with a one-line remediation (`npm install` in the worktree, or
  refresh the primary checkout's `node_modules` so worktrees resolve `vitest` from the parent like
  lint/build). The gate never silently skips and never fails spuriously.

## Alternatives considered

- **Auto-`npm install` inside the gate when vitest is missing.** Rejected: a worktree `npm install`
  materialises a full local `node_modules` (slow, hundreds of MB) as a side effect of a
  production-deploy command — opaque and surprising. The preflight is transparent and the install
  is one-time per worktree (the developer already runs it to test locally).
- **CI-only test gate.** The repo deploys on push-to-`main` with **no PR gate**, so a CI workflow
  runs *post-merge* — a safety net, not a pre-deploy block. To actually block a bad deploy, the
  tests must run inside `/ship` before the push. CI is **recommended as a clean-room backstop**
  (a `.github/workflows` job running `npm ci` + lint + build + test on push/PR) but is deferred:
  it cannot be verified without pushing and it adds an always-on surface, which is a separate
  human-initiated decision.
- **Adding jsdom + `@testing-library/react` to render the hooks.** Rejected for now: it widens the
  devDependency surface the gate must install everywhere and the project has no React test
  infrastructure; the payroll-safety property is fully covered at the action layer. Revisit if/when
  component tests are introduced.

## Consequences

- Every `/ship` from a worktree where the runner resolves now runs the full suite (152 tests)
  before pushing to production; a real failure stops the ship.
- A fresh worktree stops **once**, with actionable remediation, instead of silently skipping the
  tests or failing spuriously. The frictionless long-term path is keeping the **primary checkout's**
  `node_modules` current — `vitest` then resolves from the parent for all worktrees, exactly like
  `eslint`/`vite`, and the preflight passes with no per-worktree install.
- No production code behaviour changed (only a pure `export` added to `getSecondarySession`); no
  Firestore rules/index/functions impact.

## Follow-ups

- **(Recommended)** Add a `.github/workflows` CI job (`npm ci` + lint + build + test) as the
  clean-room backstop — independent of any local install state.
- **(Residual)** The hooks' `APP_LOAD_TIME` orphan-detection gate (live-vs-orphan) is not rendered;
  if a React test harness is later added, render the two `useOrphaned*Recovery` hooks to assert the
  gate directly.
