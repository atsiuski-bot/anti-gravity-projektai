# WORKZ full sweep: worker-time reliability focus

## Anti-pattern verdict

**FAIL under the mandatory Impeccable test.** Gildija has a distinctive, meaningful session-color identity and does not resemble a generic SaaS card grid. It still contains three explicit banned patterns: systemic side-stripe callouts, decorative glass blur in persistent chrome, and bounce motion. No gradient text, sub-12px user copy, `rounded-3xl`, or repetitive hero-card grid was found.

## Audit health score

| # | Dimension | Score | Key finding |
|---|---|---:|---|
| 1 | Accessibility | 2/4 | Critical past-time action is below the binding 44px target |
| 2 | Performance | 2/4 | Eager worker dialogs/images and layout-width animation |
| 3 | Responsive design | 3/4 | Strong mobile-card structure, with target and select exceptions |
| 4 | Theming | 3/4 | Strong variable-backed light/dark system, isolated literals remain |
| 5 | Anti-patterns | 1/4 | Side stripes, glass blur, and bounce |
| **Total** |  | **11/20** | **Acceptable: significant work required** |

## Executive summary

- **Worker timer trust:** **5/10**
- **Focused confirmed findings:** P0 4 · P1 16 · P2 15 · P3 1
- **Release-level P0 total:** **8**, including four non-time security blockers carried forward from the exact same `HEAD`
- **Deterministic gates:** lint pass · 869 unique tests pass · Firestore emulator pass · build pass · Functions lint pass
- **Verdict:** **AUDIT FAIL**

The online, one-device happy path is understandable, and the revisioned engine has the right core primitives: revision checks, stable run IDs, atomic client batches, and a persistent outbox. Reliability breaks at ownership boundaries around that core. Deletion and secondary recovery can bypass the canonical engine; recovery can exceed its own maximum-credit budget; the rollout gate can temporarily or deliberately re-enable legacy writes; and durable command outcomes are not durable in the worker's UI.

The green suite is valuable but incomplete. It proves the expected paths and current rule assertions. It does not cover running-task deletion, revisioned secondary orphan recovery, split-budget recovery above 16 hours, gate bootstrap/rollback, post-reload rejection visibility, or false-online service-worker cleanup.

## Highest-priority failure traces

1. **Running task delete:** revisioned run R starts -> manager deletes task -> legacy pause/log runs -> task disappears -> `active_sessions` still points to R -> recovery/start/force-end refuse the missing task.
2. **Secondary orphan recovery:** canonical break/call/quick-work R crosses recovery threshold -> always-on legacy hook clears the user projection -> UI shows idle -> canonical R remains active -> next start is blocked.
3. **Split recovery budget:** start at hour 0 -> heartbeat at hour 15 -> recover at hour 30 -> two independently clamped 15-hour rows -> one run credits 30 hours.
4. **Feature-gate bootstrap:** authenticated UI becomes interactive while timer config is still false/unknown -> legacy command writes -> config resolves true -> canonical state becomes authority again.
5. **Reload after offline intent:** outbox persists the command -> next boot replay rejects/conflicts it -> no global subscriber surfaces the outcome -> worker never receives an explanation.
6. **False-online app update:** chunk/update fetch fails while `navigator.onLine` remains true -> current worker and Workbox cache are removed -> reload has no usable offline shell.
7. **Manager force-end:** a manager closes a canonical call/quick-work/break -> canonical state becomes idle -> no matching interval record is written.
8. **Workday mismatch:** a 01:00 to 02:00 Vilnius session is stored under the calendar date, while the report assigns it to the prior 03:00-based workday.

## Recommended action sequence

1. **[P0] `/harden` timer lifecycle authority.** Add failing tests first, then route running-task deletion and all secondary recovery through canonical transitions; apply one 960-minute recovery budget.
2. **[P0] `/harden` credited-time authorization.** Bind worker ledger creation to the canonical close/run/marker bundle or move it to a trusted server transaction.
3. **[P1] `/harden` rollout and outbox semantics.** Introduce a tri-state, sticky gate; keep canonical observation and outbox replay alive during rollback; make command outcomes globally persistent and visible.
4. **[P1] `/harden` rule and clock boundaries.** Enforce the atomic bundle in rules, add monotonic command sequencing, use trusted time, and repair role-aware private session queries plus earnings error handling.
5. **[P1] `/optimize` PWA recovery.** Never remove a working shell until a fresh build is positively reachable; test captive-portal and update-rejection paths.
6. **[P1] `/adapt` field controls.** Fix all sub-44px time actions, replace the backdate native select, and add the mobile navigation landmark.
7. **[P2] `/distill` status language.** Remove side stripes, decorative glass, and bounce; unify recovery and outbox state presentation.
8. **[P3] `/polish` and re-audit.** Close token literals, run 360px plus reduced-motion visual QA, then repeat the full deterministic and emulator gates.

## Positive findings to preserve

- Wall-clock display recomputation survives phone sleep and process suspension.
- Revision and run-ID conflict checks are a substantial improvement over last-write-wins.
- The persistent outbox is the correct durability foundation.
- Session state is not communicated by color alone.
- Canonical UI primitives centralize focus, dialog semantics, and most touch sizing.
- Mobile workers receive cards while dense tables remain desktop-oriented.
- The production build is healthy and the PWA precache is about 1.8 MiB.

## Verification and scope notes

- Current live Firebase parity was not re-read because no callable Firebase connector was available. The prior 2026-07-10 sweep verified exact live parity at this same commit; current rules, indexes, and tracked Functions files have no local diff.
- Registry-backed dependency checks were blocked by the environment's external-data policy. Historical advisory counts are recorded only as context in `19-deps.md`.
- No application source, rules, Functions, production data, deployment, commit, branch, or remote state was changed by the audit.
- The audit added report files under this directory and `PRODUCT.md`, which the explicitly invoked audit methodology required because no root product context existed.
