# Full Sweep Synthesis - 2026-06-28

## Verdict

Audit result: **needs hardening before release confidence**. No P0 blocker was confirmed, and deterministic gates pass, but timer lifecycle coordination has multiple P1 risks. The main issue is not arithmetic; it is state ownership across Firestore documents and optimistic UI.

## Audit Health Score

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3/4 | Focus labels and 44px controls are broadly present; side-stripe alerts and some raw patterns remain. |
| 2 | Performance | 3/4 | Build size is acceptable and listeners mostly clean; dependency advisories and many live listeners remain watch items. |
| 3 | Responsive Design | 3/4 | Mobile-first patterns are present; no live visual QA was performed in this run. |
| 4 | Theming | 3/4 | Token system is mostly wired; manifest and some raw/legacy literals remain. |
| 5 | Anti-Patterns | 2/4 | Widespread `border-l-4` alert styling and `transition-all` usage violate loaded design rules. |
| **Total** | | **14/20** | **Good, but timer hardening is the release risk.** |

## Executive Summary

- P0: 0
- P1: 5
- P2: 7
- P3: 3
- Root lint: pass.
- Root tests: pass, 87 tests.
- Root build: pass.
- Functions lint: pass.
- Root production dependency audit: fail, 15 advisories including 1 critical and 4 high.
- Functions audit: fail, 8 moderate advisories.

## Top Findings

### P1 - Timer/session transition can split truth across documents

`startSession` and `startTask`/`resumeTask` can move the user into a new active state while the old running task fails to pause. The consequence is two incompatible records: the user profile says one session is active, while a task still says it is running. That is the classic ghost-time/double-counting failure mode.

Fix direction: fail closed for timer transitions. The old running thing must be durably paused before the new thing becomes active, or the system must perform an explicit compensation/revert.

### P1 - `endSession` hides critical write failure from callers

`endSession` logs failures but does not reject after the critical user-doc update fails. Callers already set optimistic "ended" state, and `AuthContext` can keep that optimistic state while the real snapshot still shows an active session.

Fix direction: rethrow critical user-state update failure after `logError`, while keeping non-critical logging fire-and-forget.

### P1 - Timer lifecycle tests miss the actual risky layer

The current tests prove many pure helpers are healthy, including timezone and clamp logic. They do not exercise the cross-document timer state machine, race conditions, duplicate taps, or orphan recovery.

Fix direction: add mocked Firestore tests for session/task transitions before changing timer behavior.

### P1 - Dependency advisories remain in production tree

The production-only root audit still reports 1 critical and 4 high advisories, including Firebase-chain advisories via transitive packages.

Fix direction: run a dependency maintenance lane, separating client runtime upgrades from dev-tool upgrades.

## Positive Findings

- The time math layer is much healthier than older audit notes implied: negative and implausibly long deltas are clamped.
- `work_sessions` and `break_sessions` have Firestore rule duration guards.
- `firestore.indexes.json` exists and covers major scoped-manager query shapes.
- Root and Functions lint pass.
- Tests exist and pass; previous "zero tests" documentation is stale.
- PWA build succeeds and emits the service worker and manifest.

## Recommended Actions

1. **[P1] `$impeccable harden timer lifecycle`** - Make session/task transitions fail closed, surface critical `endSession` failures to callers, and add tests for cross-document timer state.
2. **[P1] `$impeccable optimize dependencies`** - Upgrade/retire root dependencies that produce production advisories; remove root debug/admin dependency surface where possible.
3. **[P2] `$impeccable clarify PWA metadata`** - Fix manifest language and install copy.
4. **[P2] `$impeccable document full sweep plan`** - Update the durable sweep plan so future audits include tests, functions, and Firestore indexes.
5. **[P2] `$impeccable polish alerts`** - Replace side-stripe alert styling and `transition-all` with canonical tokenized patterns.

Re-run `$impeccable audit` after fixes to see the score improve.
