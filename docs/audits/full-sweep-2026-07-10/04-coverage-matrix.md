# R-01–R-14 regression coverage matrix

**Result:** 0 fully covered · 9 partial · 5 absent.  
“Partial” means adjacent happy-path/client-convention coverage, not an exploit oracle.

| ID | Coverage | Existing evidence | Minimal missing regression |
|---|---|---|---|
| R-01 | **Absent** | Emulator fixtures pre-create users with rules disabled (`legacyTimerFailures.integration.test.js:26-33,54-61`; `revisionedTimerEngine.integration.test.js:52-58,111-124`). | Fresh authenticated UID creating `role: admin` must fail; exact safe worker/pending profile must pass; delete/recreate escalation must fail. |
| R-02 | **Absent** | No test executes Functions attachment cleanup; root Vitest excludes Functions. | Attacker task references `attachments/{victim}/...`; cleanup must refuse victim delete while canonical own/default-bucket deletion remains idempotent. |
| R-03 | **Partial** | Recovery tests cover 1/5/120 min (`timerTransitionPlan.test.js:577-638`) and emulator recovery 1+119 min (`revisionedTimerEngine.integration.test.js:752-821`). Generic clamp tests do not sum two recovery segments. | Start at 0 h, heartbeat 15 h, recover 30 h; combined rows and task projection must credit ≤960 min. |
| R-04 | **Partial** | One 2,040-minute row and one invalid-ledger batch are rejected (`legacy...:168-215`; `revisioned...:273-315`); replay dedupes one ID (`:318-351`). | Worker creates multiple individually plausible rows without matching command/run: reject all; canonical close bundle may create exactly one. |
| R-05 | **Absent** | `UserProfileModal.eligibility.test.js:135-170` consumes `teamManagerIds` as trusted query data only. | Owner removing a legitimate manager or adding an unrelated one must fail; drifted stamps must be repaired across live/archive/session collections. |
| R-06 | **Partial** | Client convention tests produce unapproved worker tasks and block ordinary UI approval (`taskStatus.test.js:5-9`; `completeTask.test.js:46-73`; `taskPermissions.test.js:7-24,40-43`). | Hostile worker create with confirmed/approved fields must fail; safe unapproved create passes; reassignment to another UID fails. |
| R-07 | **Absent** | No `isTest` mutation test exists. | Worker self-update to `isTest: true` fails; ordinary profile edit passes; trusted admin/server change passes. |
| R-08 | **Partial** | Manager force-end happy path exists (`revisioned...:417-468`) without a scoped subtree fixture; scoped tests cover reads, not writes. | Table-driven out-of-scope user/active-session/timer/calendar writes fail; identical in-subtree writes pass. |
| R-09 | **Partial** | Registry/copy/link and calendar key semantics only (`notifications/registry.test.js:18-58`; `firebaseConsistency.test.js:394-487`; `calendarNotifications.test.js:55-66`). | Unrelated recipient spoof fails; recipient update changes read-state only; foreign `managerIds` cannot fan out; repeated event creates one delivery. |
| R-10 | **Absent** | `payRate.test.js:13-17` and remaining tests cover arithmetic only. | Worker A can read B's public profile but cannot read B's compensation document/rate. |
| R-11 | **Partial** | UI progress math and catalog lockstep only (`useAchievements.test.js:20-107`; `firebaseConsistency.test.js:865-907`). | Process the same work-session/signup CloudEvent ID twice: one counter increment, one badge, one notification. |
| R-12 | **Partial** | Planner declares marker/finish plan; emulator proves an invalid-ledger batch rejects atomically (`timerTransitionPlan.test.js:33,641`; `revisioned...:273-315`). | Batches that advance revision/marker while omitting ledger, task, or user projection must each be rejected by rules. |
| R-13 | **Partial** | Persistence/status and basic replay are covered (`timerOutbox.test.js:14-47`; `timerCommandEngine.test.js:45-58`). | Dependent start/stop with equal or reversed `issuedAt` must preserve causal order and deterministic terminal state. |
| R-14 | **Partial** | Current unsafe consequence is characterized: backward/future delta → 0; large delta → 960 (`timeUtils.test.js:24-48,185-196`; `taskActions.test.js:184-214`; secondary analogues `sessionActions.test.js:228-290`). | Hostile timestamps far from `request.time` must be rejected or replaced by trusted server-derived boundaries. |

## Gate-level gaps

- General Firestore authorization coverage is absent outside the timer-engine suites.
- Functions runtime has no integrated test script/gate.
- Storage emulator/Admin cleanup coverage is absent.
- Production composite-index requirements are not parity-tested against query specifications.
- `writeFail:reconcileTaskTimerFromSessions` has no targeted role/rules test. Its unit tests fully mock Firestore and therefore miss the production-proved `taskId`-only query denial for workers and scoped managers.
- No test covers the other task-centric private-session readers (hard-delete cleanup, scoped time correction, scoped history export) or asserts ledger/task-projection equality after partial-failure paths.
- `EarningsModal` has no component/rules test; pure pay-rate arithmetic tests do not detect that a denied monthly query silently supplies zero prior hours.
- The deterministic gate has no JSX semantic/accessibility lint plugin, rendered axe check, or ARIA composite keyboard test, so invalid row roles, undersized targets, and incomplete tab/radio behavior all pass.
