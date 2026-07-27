# Confirmed reasoning findings

**Primary scope:** worker-side trustworthy time credit  
**Focused findings:** P0 4 · P1 16 · P2 15 · P3 1  
**Additional carry-forward blockers:** 4 non-time P0 findings from the exact same audited `HEAD`

## P0: Blocking and critical

### T-01: Deleting a running task bypasses the canonical timer engine

- **Location:** [TaskTable.jsx:259](../../../src/components/TaskTable.jsx#L259), [taskActions.js:674](../../../src/utils/taskActions.js#L674), [useRevisionedTaskRecovery.js:40](../../../src/hooks/useRevisionedTaskRecovery.js#L40), [TaskTimerControls.jsx:216](../../../src/components/TaskTimerControls.jsx#L216), [sessionAdmin.js:37](../../../src/utils/sessionAdmin.js#L37)
- **Category:** Time integrity / crash recovery
- **Mechanism:** the reachable delete flow invokes the legacy `pauseTask` path and continues deletion even when pause fails. It never settles `active_sessions`. If the task is hard-deleted, recovery, a later start, and manager force-end all refuse or return when the referenced task document is missing.
- **Impact:** the worker can be left with a dangling canonical run that no normal UI action can close. The legacy pause may also have created a different ledger row, creating a later double-credit risk if the canonical run is repaired independently.
- **Standard:** ADR 0020 requires active state, affected task, command marker, and ledger effects to move together.
- **Recommendation:** settle the canonical run before deletion in one revisioned lifecycle operation, and teach recovery/force-end to close a missing-task run without losing its ledger and audit semantics. Add a running-task delete emulator test.

### T-02: Revisioned secondary recovery closes only the legacy projection

- **Location:** [WorkerView.jsx:76](../../../src/pages/WorkerView.jsx#L76), [useOrphanedSessionRecovery.js:148](../../../src/hooks/useOrphanedSessionRecovery.js#L148), [sessionActions.js:311](../../../src/utils/sessionActions.js#L311), [BreakTimer.jsx:93](../../../src/components/BreakTimer.jsx#L93)
- **Category:** Time integrity / recovery
- **Mechanism:** task recovery is gated between legacy and revisioned implementations, but break/call/quick-work orphan recovery always invokes the legacy closer. That path clears only user-facing projections and never updates `active_sessions`.
- **Impact:** the screen can show idle while the canonical run remains active. A new start then fails because the canonical engine still sees another run, leaving the worker unable to continue without repair.
- **Standard:** ADR 0020 canonical-state and recovery invariants.
- **Recommendation:** migrate secondary orphan recovery to revisioned transition plans and disable the legacy hook whenever the revisioned engine owns the session.

### T-03: Heartbeat recovery can credit one run beyond the 16-hour ceiling

- **Location:** [timerTransitionPlan.js:1311](../../../src/utils/timerTransitionPlan.js#L1311), [timerTransitionPlan.js:1341](../../../src/utils/timerTransitionPlan.js#L1341), [timerTransitionPlan.js:1403](../../../src/utils/timerTransitionPlan.js#L1403), [timerTransitionPlan.test.js:577](../../../src/utils/timerTransitionPlan.test.js#L577)
- **Category:** Time integrity / payroll
- **Mechanism:** the heartbeat-proven segment and the post-heartbeat gap are each clamped independently, then added as two rows. A run from hour 0 with a heartbeat at hour 15 and recovery at hour 30 credits 15 plus 15 hours although the heartbeat did not create a new run.
- **Impact:** a single forgotten timer can materially overstate payable time, reports, and achievements.
- **Standard:** the documented one-run 16-hour safety ceiling.
- **Recommendation:** apply one 960-minute budget to the entire run, then partition that single budget between proven and gap rows. Add 15h+15h and longer regression cases.

### T-04: A worker can mint unlimited canonical work-session rows

- **Location:** [firestore.rules:173](../../../firestore.rules#L173), [firestore.rules:327](../../../firestore.rules#L327)
- **Category:** Security / time authority
- **Mechanism:** rules cap each row but let a worker create arbitrary owned `work_sessions` rows without binding them to a close command, run ID, deterministic document ID, server-derived boundary, non-overlap rule, or reviewed manual correction.
- **Impact:** the collection documented as the sole credited-time authority can be forged directly, so payroll, reports, and achievements are not trustworthy.
- **Standard:** ADR 0020 sole-ledger and one-row-per-run invariants.
- **Recommendation:** authorize worker ledger creation only as the required same-batch effect of a valid canonical close, or move it to a trusted server transaction. Keep reviewed manual corrections on a separate contract.

## P1: Major

### T-05: The rollout gate conflates unknown, disabled, and failed

- **Location:** [AuthContext.jsx:292](../../../src/context/AuthContext.jsx#L292), [AuthContext.jsx:395](../../../src/context/AuthContext.jsx#L395), [AuthContext.jsx:416](../../../src/context/AuthContext.jsx#L416), [TaskTimerControls.jsx:290](../../../src/components/TaskTimerControls.jsx#L290)
- **Category:** Time integrity / migration
- **Mechanism:** the interactive app can render before the independent timer-config listener resolves. The default and listener-error state are both `false`, so timer controls issue legacy commands during that window. Turning the gate off also disables canonical reads and outbox replay, although ADR 0020 rollback requires existing commands to keep draining.
- **Impact:** one boot or config failure can switch authority mid-session, leave a legacy run invisible behind an existing canonical revision, or lose an outbox intent that was persisted before its Firestore batch was issued.
- **Recommendation:** use a tri-state gate and block timer controls until resolved. Separate `issuanceEnabled` from always-on canonical observation, outbox replay, and outcome visibility. Once enabled for an authenticated session, fail closed instead of silently downgrading.

### T-06: Legacy secondary start can lock out stop while offline

- **Location:** [QuickWorkTimer.jsx:494](../../../src/components/QuickWorkTimer.jsx#L494), [CallTimer.jsx:349](../../../src/components/CallTimer.jsx#L349), [BreakTimer.jsx:168](../../../src/components/BreakTimer.jsx#L168), [legacyTimerFailures.integration.test.js:69](../../../src/integration/firestore/legacyTimerFailures.integration.test.js#L69)
- **Category:** Offline reliability
- **Mechanism:** Firestore applies the local write and the UI can show an active session, but the write promise remains pending until reconnection. The action guard remains held, so the matching stop tap is silently ignored.
- **Impact:** a short offline action can accumulate ghost time until reconnection or reload.
- **Recommendation:** remove the legacy fallback after rollout. Until then, let a locally durable start be followed by a dependent stop and show its queued status explicitly.

### T-07: Outbox outcomes disappear after reload

- **Location:** [timerOutbox.js:146](../../../src/utils/timerOutbox.js#L146), [AuthContext.jsx:416](../../../src/context/AuthContext.jsx#L416), [TaskTimerControls.jsx:179](../../../src/components/TaskTimerControls.jsx#L179), [QuickWorkTimer.jsx:344](../../../src/components/QuickWorkTimer.jsx#L344)
- **Category:** Offline reliability / trust UX
- **Mechanism:** the durable outbox can record queued, confirmed, rejected, and conflicted states, but no global UI subscribes to it and boot replay results are discarded. Component-local React state is lost on reload.
- **Impact:** a worker can believe an offline start or stop succeeded, then never learn that reconnection rejected or conflicted it.
- **Recommendation:** expose a global IndexedDB-backed command-status surface with Lithuanian states for saved-on-device, syncing, confirmed, rejected, and changed-on-another-device.

### T-08: Legacy finish and undo can report success after a partial ledger failure

- **Location:** [TaskTimerControls.jsx:430](../../../src/components/TaskTimerControls.jsx#L430), [TaskTimerControls.jsx:598](../../../src/components/TaskTimerControls.jsx#L598), [legacyTimerFailures.integration.test.js:168](../../../src/integration/firestore/legacyTimerFailures.integration.test.js#L168)
- **Category:** Time integrity / user feedback
- **Mechanism:** finish writes the last ledger interval fire-and-forget, then awaits the task update and shows success. Undo similarly swallows a ledger-void failure and still reports that the task was reopened.
- **Impact:** task state and credited-time authority can disagree while the worker sees a success message.
- **Recommendation:** remove these legacy paths or replace both forward and compensating actions with atomic, revisioned commands. Never convert a partial write into success.

### T-09: The atomic command contract is not rule-enforced

- **Location:** [timerTransitionExecutor.js:6](../../../src/utils/timerTransitionExecutor.js#L6), [firestore.rules:381](../../../firestore.rules#L381)
- **Category:** Firebase integrity
- **Mechanism:** the official client batches active state, command marker, task/user projection, and ledger, but rules validate those documents independently and do not require the matching post-write bundle.
- **Impact:** a buggy or custom client can advance the canonical revision without every required effect, despite rules being documented as the concurrency boundary.
- **Recommendation:** bind command ID, revision, run, marker, projection, and required ledger effects with `getAfter`/`existsAfter`, or process transitions in a trusted server transaction.

### T-10: Replay order depends on wall-clock strings

- **Location:** [timerOutbox.js:123](../../../src/utils/timerOutbox.js#L123), [timerCommandEngine.js:128](../../../src/utils/timerCommandEngine.js#L128)
- **Category:** Offline reliability
- **Mechanism:** dependent commands are sorted only by client `issuedAt`, with no monotonic per-user sequence or dependency edge. Clock rollback or equal-millisecond issuance can reorder start and stop after a crash between outbox persistence and Firestore issuance.
- **Impact:** replay can conflict or leave the wrong run active, creating ghost time.
- **Recommendation:** allocate a monotonic local sequence, persist dependencies, and do not replay a dependent command before its predecessor reaches a terminal outcome.

### T-11: Credited boundaries trust client clocks

- **Location:** [timerTransitionPlan.js:297](../../../src/utils/timerTransitionPlan.js#L297), [timerTransitionPlan.js:340](../../../src/utils/timerTransitionPlan.js#L340), [timerTransitionPlan.js:388](../../../src/utils/timerTransitionPlan.js#L388), [firestore.rules:359](../../../firestore.rules#L359)
- **Category:** Time integrity
- **Mechanism:** start and stop boundaries come from client `issuedAt`; rules require only strings and do not constrain skew against `request.time`.
- **Impact:** a clock correction or two devices with different offsets can silently under-credit, zero, or inflate a real interval.
- **Recommendation:** anchor accepted transitions to trusted server time or a verified offset model, reject implausible skew, and route corrections through an audited flow.

### T-12: "I did not work" irreversibly deletes credited time in one tap

- **Location:** [RecoveryNotice.jsx:86](../../../src/components/RecoveryNotice.jsx#L86), [RecoveryNotice.jsx:233](../../../src/components/RecoveryNotice.jsx#L233), [sessionEditActions.js:410](../../../src/utils/sessionEditActions.js#L410)
- **Category:** Destructive UX / data integrity
- **Mechanism:** the action hard-deletes a canonical `work_sessions` row without confirmation or recoverable undo. The uncredited-gap dismiss path also removes the only visible claim path.
- **Impact:** an outdoor mistap can remove payable minutes or the worker's only way to claim them.
- **Recommendation:** show a forced `ConfirmDialog` with task and exact minutes, prefer soft deletion, and retain an auditable compensating action.

### T-13: False-online stale-build recovery can destroy the working offline shell

- **Location:** [appUpdate.js:111](../../../src/utils/appUpdate.js#L111), [appUpdate.js:139](../../../src/utils/appUpdate.js#L139), [appUpdate.js:155](../../../src/utils/appUpdate.js#L155), [appUpdate.js:163](../../../src/utils/appUpdate.js#L163), [appUpdate.test.js:2](../../../src/utils/appUpdate.test.js#L2)
- **Category:** PWA reliability
- **Mechanism:** a failed service-worker update is swallowed. If `navigator.onLine` is still true, as with a captive portal or dead route, fallback unregisters the app worker, deletes Workbox precaches, and reloads. The isolated reproduced sequence is `update rejection -> unregister -> precache delete -> reload`.
- **Impact:** the worker loses app access until real connectivity returns and cannot see or stop an active timer.
- **Recommendation:** preserve the current shell unless a fresh build is positively reachable or a waiting worker activates. Add update-rejection, captive-portal, unregister, and cache-retention tests.

### T-14: Private session query contracts break reconciliation

- **Location:** [sessionEditActions.js:77](../../../src/utils/sessionEditActions.js#L77), [deleteTask.js:69](../../../src/domain/commands/deleteTask.js#L69), [TaskHistory.jsx:306](../../../src/components/TaskHistory.jsx#L306), [TaskDetailsModals.jsx:370](../../../src/components/TaskDetailsModals.jsx#L370), [firestore.rules:327](../../../firestore.rules#L327)
- **Category:** Firebase coupling / time projection
- **Mechanism:** task-centric readers query private `work_sessions` only by `taskId`. Firestore rules are not row filters, so worker and scoped-manager queries lacking an ownership or team constraint are rejected before reconciliation.
- **Impact:** the canonical ledger can be correct while task totals, correction flows, deletion cleanup, and exports fail or drift. The 2026-07-10 live audit observed 16 deterministic reconciliation denials at the same source revision.
- **Recommendation:** centralize role-aware session queries and move cross-document reconciliation/deletion to an idempotent authorized server path.

### T-15: Earnings silently assume zero prior monthly minutes

- **Location:** [EarningsModal.jsx:33](../../../src/components/EarningsModal.jsx#L33), [EarningsModal.jsx:60](../../../src/components/EarningsModal.jsx#L60), [firestore.rules:327](../../../firestore.rules#L327)
- **Category:** Worker-facing calculation
- **Mechanism:** the monthly query filters only by date and filters user ID in memory, so private rules reject it. The catch converts failure to zero and still calculates marginal earnings from the first tier.
- **Impact:** the displayed amount can be materially wrong with no degraded-data warning.
- **Recommendation:** constrain the query by authenticated user ID, preserve a visible error state, and test a tier-boundary example through rules.

### T-16: Notification failure is presented as timer failure after confirmed credit

- **Location:** [QuickWorkTimer.jsx:344](../../../src/components/QuickWorkTimer.jsx#L344)
- **Category:** Trust UX
- **Mechanism:** the post-confirmation notification is awaited in the same chain as the timer outcome. Its rejection displays "failed to change quick-work state" although time is already committed.
- **Impact:** a worker may retry a completed action and create confusion or duplicate follow-up effects.
- **Recommendation:** make notification delivery a separately reported best-effort effect that can never rewrite the primary timer outcome.

### T-17: Legacy switching can leave two simultaneously creditable timers

- **Location:** [taskActions.js:77](../../../src/utils/taskActions.js#L77), [taskActions.js:402](../../../src/utils/taskActions.js#L402), [sessionActions.js:82](../../../src/utils/sessionActions.js#L82), [sessionActions.js:171](../../../src/utils/sessionActions.js#L171)
- **Category:** Time integrity / legacy migration
- **Mechanism:** `pauseOtherTasks` uses `Promise.allSettled` and suppresses failures before the next task starts. Secondary start similarly suppresses a failed task pause and proceeds. Partial interruption logging and the later user transition are also independent.
- **Impact:** the old task can remain running while the new task or secondary session accrues time, or the interrupted portion can be logged twice or dropped.
- **Recommendation:** remove legacy switching after cutover. Until then, failure to close the old run must abort the new start, with old close, partial ledger, new run, and projections in one atomic transition.

### T-18: Manager force-end discards revisioned call, quick-work, and break intervals

- **Location:** [sessionAdmin.js:32](../../../src/utils/sessionAdmin.js#L32), [timerTransitionPlan.js:1227](../../../src/utils/timerTransitionPlan.js#L1227), [timerTransitionPlan.js:1238](../../../src/utils/timerTransitionPlan.js#L1238)
- **Category:** Time integrity / administrative recovery
- **Mechanism:** `planManagerForceEnd` creates a ledger row for a task run only. For call, quick-work, and break it moves canonical state to idle and clears projections without writing the interval.
- **Impact:** a manager's recovery action silently drops payable call/quick-work minutes and break history.
- **Recommendation:** every run type needs a deterministic force-end record. Quick work may use an auto-stopped placeholder that the worker can describe later.

### T-19: Session day keys disagree with the 03:00 workday boundary

- **Location:** [timerTransitionPlan.js:327](../../../src/utils/timerTransitionPlan.js#L327), [timerTransitionPlan.js:864](../../../src/utils/timerTransitionPlan.js#L864), [timerTransitionPlan.js:942](../../../src/utils/timerTransitionPlan.js#L942), [timeUtils.js:245](../../../src/utils/timeUtils.js#L245), [DailyStatistics.jsx:404](../../../src/components/DailyStatistics.jsx#L404)
- **Category:** Time calculation / reporting
- **Mechanism:** revisioned writers assign the whole interval to the Vilnius calendar date at its end, while reports define a workday as 03:00 to 03:00 and query by that stored `date`. A 01:00 to 02:00 interval belongs to the previous workday but is stored under the new calendar day; a run crossing 03:00 is not split.
- **Impact:** daily totals and corrections can appear on the wrong workday even when total duration is correct.
- **Recommendation:** use one canonical `getVilniusWorkdayKey(instant, cutoff=03:00)` contract in writers and readers, and deterministically split intervals that cross the cutoff.

### UI-01: Critical time-recovery controls are below 44 by 44 pixels

- **Location:** [TaskDetailModal.jsx:397](../../../src/components/task/TaskDetailModal.jsx#L397), [ProfilePage.jsx:520](../../../src/pages/ProfilePage.jsx#L520), [SearchBox.jsx:180](../../../src/components/ui/SearchBox.jsx#L180), [PeriodPicker.jsx:84](../../../src/components/reports/PeriodPicker.jsx#L84)
- **Category:** Accessibility / responsive field use
- **Impact:** the worker's "log past time" recovery action is easy to miss with gloves, sunlight, or reduced motor precision.
- **Standard:** binding `DESIGN_SYSTEM.md` 44px gate and WCAG 2.5.5 target-size criterion.
- **Recommendation:** route text actions through `Button`, icon actions through `IconButton`, and add a rendered target-size regression gate.

## P2: Bounded but real

1. **Recovery notice dedupe hides a second recovery for the same task.** [recoveryNotice.js:55](../../../src/utils/recoveryNotice.js#L55). Key by recovery/run/session ID, not only type and task ID.
2. **Recovery copy says the timer stopped although revisioned recovery continues it.** [RecoveryNotice.jsx:211](../../../src/components/RecoveryNotice.jsx#L211), [timerTransitionPlan.js:1395](../../../src/utils/timerTransitionPlan.js#L1395).
3. **Finish undo is hidden, contradictory, and reload-volatile.** [TaskTimerControls.jsx:778](../../../src/components/TaskTimerControls.jsx#L778), [ToastContext.jsx:98](../../../src/context/ToastContext.jsx#L98).
4. **Quick-work and call dialogs remain dismissible while saving.** [QuickWorkTimer.jsx:106](../../../src/components/QuickWorkTimer.jsx#L106), [CallTimer.jsx:68](../../../src/components/CallTimer.jsx#L68).
5. **Terminal outbox entries are never pruned and replay reads every entry for a user before filtering.** [timerOutbox.js:64](../../../src/utils/timerOutbox.js#L64), [timerOutbox.js:123](../../../src/utils/timerOutbox.js#L123). Bound retention and keep only compact terminal audit metadata.
6. **Mobile primary navigation lacks a `nav` landmark.** [BottomNavigation.jsx:92](../../../src/components/BottomNavigation.jsx#L92).
7. **Modal-only worker features are eagerly imported on the primary task path.** [WorkerView.jsx:6](../../../src/pages/WorkerView.jsx#L6), [WorkerView.jsx:409](../../../src/pages/WorkerView.jsx#L409).
8. **Progress bars animate layout width through `transition-all`.** [DailyWorkProgress.jsx:283](../../../src/components/DailyWorkProgress.jsx#L283), [TaskCard.jsx:440](../../../src/components/TaskCard.jsx#L440), [TaskTable.jsx:844](../../../src/components/TaskTable.jsx#L844).
9. **Task galleries eagerly load original images.** [TaskDetailModal.jsx:645](../../../src/components/task/TaskDetailModal.jsx#L645), [TaskDetailModal.jsx:689](../../../src/components/task/TaskDetailModal.jsx#L689).
10. **The backdated-time flow retains the only native select.** [BackdateTimeModal.jsx:175](../../../src/components/BackdateTimeModal.jsx#L175).
11. **Side-stripe alerts are systemic across timer and recovery surfaces.** [RecoveryNotice.jsx:151](../../../src/components/RecoveryNotice.jsx#L151), [BreakTimer.jsx:276](../../../src/components/BreakTimer.jsx#L276), [QuickWorkTimer.jsx:682](../../../src/components/QuickWorkTimer.jsx#L682), [CallTimer.jsx:522](../../../src/components/CallTimer.jsx#L522).
12. **Persistent chrome uses decorative glass blur and one bounce motion.** [BottomNavigation.jsx:79](../../../src/components/BottomNavigation.jsx#L79), [AppHeader.jsx:53](../../../src/components/AppHeader.jsx#L53), [ActiveSessionReadout.jsx:87](../../../src/components/ActiveSessionReadout.jsx#L87), [TaskDetailModal.jsx:708](../../../src/components/task/TaskDetailModal.jsx#L708).
13. **Call and quick-work deterministic IDs use client timestamp rather than `runId`.** [timerTransitionPlan.js:824](../../../src/utils/timerTransitionPlan.js#L824), [timerTransitionPlan.js:876](../../../src/utils/timerTransitionPlan.js#L876). A repeated timestamp can overwrite an earlier valid row; derive every task and ledger ID from the stable run ID.
14. **A rejected recovery remains deduped for the rest of the process.** [useRevisionedTaskRecovery.js:38](../../../src/hooks/useRevisionedTaskRecovery.js#L38), [useRevisionedTaskRecovery.js:67](../../../src/hooks/useRevisionedTaskRecovery.js#L67). Clear the handled marker or create a persistent conflict state when settlement is not confirmed.
15. **Task total projection can overwrite a concurrent correction.** [timerTransitionPlan.js:292](../../../src/utils/timerTransitionPlan.js#L292). The canonical session revision does not protect the independently edited task total; make the projection server-owned and ledger-derived.

## P3: Polish

### UI-02: Isolated palette literals bypass semantic theme tokens

- **Location:** [TaskTimeWarningPopup.jsx:32](../../../src/components/TaskTimeWarningPopup.jsx#L32), [AllUsersCalendar.jsx:33](../../../src/components/AllUsersCalendar.jsx#L33)
- **Impact:** current behavior is bounded, but future light/dark or brand changes can drift.
- **Recommendation:** introduce semantic warning-header and calendar-inline tokens.

## Non-time P0 carry-forward blockers

These were adversarially confirmed in the 2026-07-10 sweep at the exact same `HEAD`. The current dirty application changes do not touch their source surfaces.

1. **Newly authenticated user can provision an admin-trusted profile.** [firestore.rules:26](../../../firestore.rules#L26), [firestore.rules:215](../../../firestore.rules#L215).
2. **Client-controlled attachment URLs drive Admin-SDK cross-user deletion.** [functions/index.js:340](../../../functions/index.js#L340), [functions/index.js:383](../../../functions/index.js#L383).
3. **Owners can forge server-owned manager visibility stamps.** [firestore.rules:305](../../../firestore.rules#L305), [firestore.rules:341](../../../firestore.rules#L341), [firestore.rules:452](../../../firestore.rules#L452).
4. **Worker task rules permit forged approval state and horizontal reassignment.** [firestore.rules:292](../../../firestore.rules#L292), [firestore.rules:305](../../../firestore.rules#L305).

## Positive assurance

- Timer display derives elapsed time from persisted wall-clock boundaries, not accumulated UI ticks, so phone suspension does not freeze the displayed duration.
- Revisioned commands use stable run IDs, expected revisions, deterministic marker IDs, and atomic client batches.
- The IndexedDB outbox is a sound durability primitive and permits stop-after-offline-start once all paths use it.
- Firestore emulator coverage proves revision conflict, atomic batch, replay, finish, force-end, secondary, and normal recovery cases currently encoded by the suite.
- Session color is paired with text and icon, and the primary timer controls generally use canonical 44px, focus-visible components.
- Light/dark theming is centralized through CSS variables and one session-color vocabulary.

## Unverified high-priority hypothesis

The deployed server-side forgotten-session closer predates ADR 0020, while revisioned transitions dual-write legacy user/task projections. The source inventory found no `active_sessions` reference under `functions/`, but the shell approval limit prevented a complete line-by-line re-read of the closer. If it does not explicitly skip revisioned projections, it can close only the legacy side of a canonical run. This is not counted as a finding until the exact function branch and tests are verified.
