# Whole-app audit synthesis — 2026-07-27

## Anti-pattern verdict

**PASS — the product does not look AI-generated.** The interface uses familiar operational
patterns, restrained hierarchy, explicit timer states, and a coherent session-color system.
The remaining anti-patterns are isolated: broad `transition-all`, one glass/gradient error
surface, and documentation drift between the current product and old WORKZ-era guidance.

## Overall result

**NEEDS WORK — 14/20 ("Good"), with ten P1 findings.**

The interface-quality score is not a time-credit safety rating. On the employee time-credit
question, the result is **red** until the P1 paths below are repaired and exercised.

| Dimension | Score | Evidence |
|---|---:|---|
| Accessibility | 3/4 | Strong touch-target and color-plus-text foundations; critical sync status changes are not announced |
| Performance | 2/4 | Repeated roster-driven listener churn and multiple overlapping timer clocks on the worker route |
| Responsive design | 3/4 | Mobile-first cards and controls; authenticated 360 px visual QA remains incomplete |
| Theming | 3/4 | Centralized semantic/session colors and dark-mode support; manifest launch colors remain fixed white |
| Anti-patterns | 3/4 | Intentional product UI overall; isolated motion/glass patterns and canonical-doc drift |
| **Total** | **14/20** | **Good, but not safe to call complete** |

### Issue counts

| Severity | Count |
|---|---:|
| P0 | 0 |
| P1 | 10 |
| P2 | 11 |
| P3 | 1 |

## P1 — must fix

### 1. Worker corrections can split the canonical ledger from the task total

**Where:** `src/utils/sessionEditActions.js`, especially the owner-scoped fallback and the
backdate, recovered-gap claim, and recovered-gap discard paths.

A plain worker cannot run the broad `taskId` session query required to recompute the full task
projection. The code correctly recognizes the owner-scoped fallback as partial and refuses the
projection write, but all three public actions ignore that failed reconciliation and still
return success.

**Consequence:** Reports and pay calculations can use the changed canonical `work_sessions`
row while TaskCard, TaskDetail, time-limit monitoring, and later earnings feedback retain the
old task counter. The "I did not work" path also hard-deletes the canonical row without an
auditable tombstone.

**Required direction:** make the correction and projection delta one concurrency-guarded
operation based on the concrete session being changed; use a reversible/tombstoned opt-out;
never report success while projection reconciliation is incomplete; add emulator tests for all
three worker paths.

### 2. Offline copy promises durability and credit before either is confirmed

**Where:** `src/components/Layout.jsx`, `src/components/TimerSyncNotice.jsx`,
`src/firebase.js`, and `src/utils/timerCommandEngine.js`.

The UI says data will be saved on the phone and that time will not be lost. The storage layer
can fall back to memory-only Firestore, and a queued timer command can later be rejected,
including when a missing transition is older than the bounded replay window.

**Consequence:** a worker can continue working under the false belief that paid time is safe.

**Required direction:** distinguish "saved on this device" from "confirmed by the server";
show persistent degraded-storage state; never use unconditional credit/durability promises for
queued commands.

### 3. A late rejection does not identify which time was lost

**Where:** `src/components/TimerSyncNotice.jsx` and `src/utils/timerOutbox.js`.

The outbox retains the full command and transition plan, but the failure notice exposes only a
generic action label and generic warning. It omits the task/session, local issue time, expected
interval, and duration.

**Consequence:** the worker cannot reconstruct the missing part of a shift or give a
coordinator enough information to correct it.

**Required direction:** show the affected task/session, issued time, expected start/end and
duration, plus a direct recovery or "report to coordinator" action.

### 4. Critical offline and sync outcomes are silent to screen readers

**Where:** `src/components/Layout.jsx` and `src/components/TimerSyncNotice.jsx`.

Dynamic offline, queued, rejected, and conflicted messages have labels but no live-region
semantics. An `aria-label` names an element; it does not announce that the element appeared.

**Consequence:** a screen-reader user may not learn that a timer action was rejected. This
fails the project's mandatory WCAG 2.1 AA status-message gate.

**Required direction:** use polite status semantics for offline/queued/reconnected state and
alert semantics for rejected/conflicted outcomes, without creating repetitive announcements.

### 5. Session ownership stamping fails open on dependency errors

**Where:** `functions/index.js` session-stamp helpers and `firestore.rules` access based on
`teamManagerIds`.

The ownership-closure lookup converts Firestore read failures into an empty list. The
create-only trigger then exits successfully without writing a stamp. That transient failure is
not retried or reconciled. When the legitimate closure is empty, a non-admin create can also
supply a forged manager stamp that the trigger does not authoritatively clear.

**Consequence:** a valid employee session can remain invisible to the scoped manager, or a
forged scoped manager can receive update/delete authority over another worker's canonical time.

**Required direction:** require absent/empty client stamps, write the authoritative result even
when it is empty, distinguish "no manager" from dependency failure, and add retry/reconciliation
plus create-forgery emulator tests.

### 6. The integrity scan can report `ok` when parts of the scan failed

**Where:** `functions/index.js` daily integrity scan helpers and report assembly.

Several Firestore read failures are converted into `null`, zero, or empty results. Severity is
derived only from found anomalies, while incomplete scan state is not represented. A failed
count can also overwrite the previous numeric baseline with `null`.

**Consequence:** canonical time corruption can coincide with a transient backend failure and
produce a clean report. This weakens the compensating control explicitly relied on for accepted
ledger risk R-04.

**Required direction:** emit `scanErrors` and `complete:false`, make any degraded scan at least
a warning, preserve the last valid baseline, retry failed runs, and test dependency-failure
branches.

### 7. Demoting a senior manager does not reliably revoke inherited write authority

**Where:** `src/components/UserManagement.jsx`, ownership-closure/stamp triggers in
`functions/index.js`, and `overseesUserDoc` in `firestore.rules`.

Demotion changes the role, but the senior closure is trusted without confirming the current
role. The role-change restamp cascade follows direct team-manager membership and does not cover
managers whose `seniorManagerIds` still contain the demoted user.

**Consequence:** a former senior who is now a worker can retain update authority over a former
subordinate manager's user document, including legacy active-session/work-status projections.

**Required direction:** validate current roles when using senior closure data, cascade both
membership directions on role changes, and prove immediate revocation with an emulator test.

### 8. An offline rollout cache miss can briefly select the legacy timer engine

**Where:** `src/context/AuthContext.jsx`, the timer-engine rollout listener and timer-control
branching.

The rollout is modeled as a careful tri-state gate, but the first config snapshot does not
inspect `snapshot.metadata.fromCache`. A cache-only "document missing" result immediately
becomes `disabled` instead of remaining unknown. An allowlisted worker can therefore issue a
legacy start before the server snapshot enables the canonical engine.

**Consequence:** a newly started shift can exist only in legacy user/task projections and become
invisible when canonical `active_sessions` takes authority moments later.

**Required direction:** treat a cache-only config miss as unknown, matching the canonical
session listener; never choose either write engine until the rollout state is server-confirmed
or a deliberately safe offline migration policy is applied; add metadata-aware listener tests.

### 9. A legacy secondary-to-secondary switch can lose the new activity offline

**Where:** `src/utils/sessionActions.js`, interrupted quick-work/call/break banking before the
new `activeSession` update.

The interrupted secondary segment is written and awaited before the new activity mutation is
even issued. Firestore mutation promises settle on server acknowledgement, so an offline
partial-ledger write can remain pending indefinitely. The timeout guard used for interrupted
task pauses does not cover these secondary writes.

**Consequence:** if the PWA is closed before reconnect, the call/break/quick-work the employee
selected never entered the durable Firestore queue; the server keeps the old activity running
and later attributes the interval to the wrong type.

**Required direction:** enqueue the deterministic partial row and the new-session intent
without waiting for network acknowledgement, preserving local write order; keep late rejection
telemetry; add a never-settling Firestore test for every secondary-to-secondary combination.

### 10. The server's task auto-stop is not one atomic, concurrency-guarded transition

**Where:** `functions/index.js`, `readCanonicalRun`, `autoStopForgottenTimers`, credit writes,
and canonical release.

Three independent failure modes share the same root:

1. The task projection is stopped first; the canonical ledger is written later as best-effort.
   A transient ledger failure is swallowed, then the canonical run is still released. The task
   is no longer `running`, so the next scan cannot retry the missing paid-time row.
2. A failed canonical probe is interpreted as "legacy". The net writes a legacy deterministic
   ID and leaves the canonical run active. A later canonical close can create `sess_run_*` for
   the same physical interval, double-crediting it.
3. The projection update uses an old query snapshot without a transaction or precondition. If
   the worker closes the old run and starts a new one in the same task during the scan, the stale
   update can pause the new projection. The canonical release correctly preserves the new run,
   leaving the two authorities split.

**Consequence:** the safety net itself can underpay, double-pay, or hide a newly running task.

**Required direction:** make candidate revalidation, projection update, deterministic ledger
creation, and canonical release one transactionally coherent state transition; dependency
errors must defer/retry, never choose a different engine; add failure-injection and concurrent
replacement tests.

## P2 — should fix

1. **The ship gate does not require the Firestore emulator or standalone Functions tests.**
   The current snapshot passes them when run manually, but a future rules/integrity regression
   can ship under a green default test command because integration suites self-skip.
2. **Every company heartbeat can recreate the worker task subscription.** The all-users
   subscription rebuilds `usersMap`; the worker task effect depends on that map, so one-minute
   heartbeats amplify into repeated task listener teardown/recreation.
3. **The worker route runs overlapping clocks.** Inactive task cards wake every ten seconds,
   while an active timer can have several independent one-second React intervals even when the
   visible value changes only once per minute.
4. **Disabled timer controls hide the blocking reason in `title`/disabled semantics.** Touch
   users cannot hover and disabled controls are not keyboard-focusable.
5. **Any manager can directly read any worker's `active_sessions` and `timer_commands`.**
   Reads do not enforce the scoped-manager subtree used by writes.
6. **A global production migration function is exposed on `window`.** A sufficiently privileged
   user can invoke an unaudited bulk task rewrite from the production bundle.
7. **Canonical documentation conflicts.** Binding design guidance still says WORKZ in places
   while runtime and repository rules require Gildija; the full-sweep skill also describes an
   obsolete test/functions/index state.
8. **ErrorBoundary exposes raw errors and full stacks to users.** This leaks developer jargon
   and potentially internal context despite the product rule against raw exception text.
9. **The timer command module defeats its intended lazy split.** The production build reports
   that the same module is both statically and dynamically imported; broad `transition-all`
   usage adds avoidable worker-route rendering cost.
10. **Credited duration depends on the employee device wall clock.** Start/end ISO values are
    client-authored and validated mainly by broad duration clamps. A clock correction during a
    session can inflate or erase paid minutes even though timezone/DST handling itself is sound.
11. **Historical plain-task manual time is not valued consistently.** Day/CSV hours add legacy
    `manualMinutes`, while total-hours/earnings aggregates use canonical `work_sessions` only;
    one report period can therefore show hours that are absent from its pay calculation.

## P3 — polish

1. **The PWA manifest launch colors remain white in dark mode.** Runtime browser chrome adapts,
   but Android can show a bright white cold-start splash.

## Known accepted residual risks — not counted as new defects

- **ADR 0021 R-04:** a worker can author canonical `work_sessions` within bounded rules. The
  project explicitly accepted this until a server-authored online path exists.
- **ADR 0022 R-06 create rail:** a worker can create a confirmed task with chosen manual
  minutes while offline behavior prevents fully server-authoritative creation.
- **Abandoned secondary-session policy:** quick-work/call sessions can be credited up to the
  documented 16-hour cap. This is an explicit product trade-off. Its recorded premise says
  secondary sessions had no heartbeat mechanism; the client now has one while the server close
  still ignores it, so the decision should be consciously revalidated rather than silently
  treated as current evidence.

These risks increase the importance of fixing finding 6: the integrity scan is a named
compensating control and must fail closed.

## Verification gap requiring live evidence

The repository includes an idempotent, guarded migration for historical session documents that
have `workerId` but no `userId`. Source inspection cannot prove it was run. A read-only live
count is required before historical employee totals can be declared complete.

## Controls that worked well

- `work_sessions` is consistently treated as the canonical time ledger.
- Task close rules bind task state and a corresponding ledger write atomically with
  `existsAfter`/`getAfter`.
- Timer commands carry expected revision/run guards, deterministic ledger IDs, monotonic local
  sequence, bounded replay, and durable rejected/conflicted outcomes.
- Session colors are centralized and paired with text/icons rather than being the sole signal.
- Core buttons and icon buttons generally meet the 44 px target and visible-focus rules.
- Reduced-motion handling and PWA navigation fallback are present.
- The latest over-estimate notification function is present in both source and the live
  function inventory.
- Lint, production build, 1,131 unit tests, 74 Firestore emulator tests, and both standalone
  Functions test programs passed on the audited commit.

## Recommended command sequence

1. `/harden` — repair correction/projection atomicity, rollout authority, offline secondary
   switching, auto-stop transactionality, session stamping, integrity failure semantics, role
   revocation, scoped reads, and the critical test gate.
2. `/clarify` — make queued/confirmed/rejected states truthful and make lost intervals
   recoverable; expose disabled-control reasons.
3. `/optimize` — decouple roster heartbeats from task listeners and consolidate timer clocks.
4. `/adapt` — complete authenticated 360 px timer-state QA and correct any reproduced overflow.
5. `/polish` — remove residual transition/glass inconsistencies and align launch theming.

You can ask for these one at a time, all at once, or in any order. Re-run `/audit` after fixes
to measure the score again.
