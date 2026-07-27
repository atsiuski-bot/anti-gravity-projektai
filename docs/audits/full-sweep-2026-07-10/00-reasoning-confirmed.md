# Reasoning track — confirmed findings

**Status:** ✅ COMPLETE  
**Findings:** 🔴 6 · 🟠 14 · 🟡 21 · ℹ️ 2  
**Verification:** independent finder scopes plus adversarial cross-checks. Every critical finding below was retained by at least two reviewers; the final accessibility, dependency-graph, and live-failure passes were independently challenged before synthesis.  
**Measured token cost:** unavailable — this Codex collaboration runtime did not expose per-agent token counters.

## 🔴 Critical

### R-01 — A newly authenticated user can provision their own admin-trusted profile

- **Evidence:** `firestore.rules:26-35`, `firestore.rules:215-223`; normal client defaults at `src/context/AuthContext.jsx:107-123`.
- **Mechanism:** the rule lets an authenticated principal create `users/{theirUid}` without pinning a safe schema. A hostile client can win first write with `role: "admin"` and `isDisabled: false`; subsequent `isUserActive()` / `isAdmin()` checks trust that same document. Client-side worker/pending defaults are not an authorization boundary.
- **Consequence:** full privilege escalation across every admin-gated collection and operation.
- **Fix:** provision profiles server-side, or require an exact safe create shape (`worker`, pending/disabled) and make role/status/scope/pay/test/server-owned fields immutable to the owner. Add emulator tests for first-login and delete/recreate races.

### R-02 — Attachment cleanup is an Admin-SDK confused deputy for cross-user deletion

- **Evidence:** `functions/index.js:340-363`, `functions/index.js:383-393`; task-owner create/delete rules at `firestore.rules:295-318`; direct Storage isolation at `storage.rules:16-24`.
- **Mechanism:** cleanup extracts `/o/<path>` from client-controlled attachment URLs without validating host, bucket, task, owner, prefix, or object metadata, then deletes that path with Admin SDK. An attacker can put a known victim `attachments/{uid}/...` path in their own task and delete the task; Admin bypasses the Storage rule that would block the direct delete.
- **Consequence:** arbitrary cross-user attachment deletion and irreversible data loss.
- **Fix:** never authorize deletion from a URL. Persist/derive canonical object keys server-side and require the exact default bucket plus immutable owner/task prefix and metadata before deleting. Keep cleanup idempotent; also constrain attachment shape in Firestore rules.

### R-03 — Heartbeat recovery bypasses the single-run 16-hour credit ceiling

- **Evidence:** `src/utils/timerTransitionPlan.js:1311-1320`, `:1341-1386`, `:1403-1428`.
- **Mechanism:** the heartbeat-proven segment and post-heartbeat gap are each independently clamped to 16 hours and then summed into two ledger rows and the task projection. A run from hour 0 with a heartbeat at hour 15 and recovery at hour 30 credits 15 + 15 = 30 hours. Heartbeat does not start a new `runId`.
- **Consequence:** one orphaned timer can overstate reports, badges, and payable time far beyond the intended safety ceiling.
- **Fix:** clamp the entire `recoveryEnd - oldStart` interval once, then partition only that single 16-hour budget between proven and gap rows. Add a >16-hour split-heartbeat regression test asserting total credit ≤ 960 minutes.

### R-04 — Workers can mint unlimited canonical paid-time rows

- **Evidence:** per-row cap at `firestore.rules:173-176`; worker-owned `work_sessions` create at `firestore.rules:327-336`; downstream badge consumption at `functions/index.js:696-707` and report/pay surfaces.
- **Mechanism:** the rule limits one row to 0–1,440 minutes but does not bind a worker-created row to a revisioned close command, `runId`, deterministic ID, server-derived timestamps, non-overlap, or an approved manual correction. A direct client can create unlimited plausible rows on arbitrary dates.
- **Consequence:** direct time/payroll fraud; reports and achievement counters consume forged canonical history.
- **Fix:** make worker ledger creation contingent on the same-batch canonical close command/run, deterministic one-row-per-run ID, and derived duration/date. Keep manual/backdated session creation on a distinct admin/reviewed path.

### R-05 — Owners can forge the server-owned manager visibility stamp

- **Evidence:** update branches at `firestore.rules:305-312`, `:341-346`, `:452-457`, `:525-532`; `functions/index.js:809-816`, `:822-835`.
- **Mechanism:** owner updates do not pin `teamManagerIds`. The repair function exits when the owner is unchanged and an array merely exists; session restamping is create-only. An owner can remove legitimate overseers or add an unrelated scoped manager and the forged array persists.
- **Consequence:** oversight evasion plus unauthorized disclosure/write reach across a server-enforced confidentiality boundary.
- **Fix:** make all scope arrays server-owned and immutable in client creates/updates; recompute the canonical closure on every relevant write and repair value drift, not just missing fields, across live/archive/session collections.

### R-06 — Worker task rules permit forged approval state and horizontal reassignment

- **Evidence:** worker create branch at `firestore.rules:292-299`; owner updates at `firestore.rules:305-312`; archive equivalent at `firestore.rules:520-532`; approval guard at `firestore.rules:149-154` is not applied to worker create.
- **Mechanism:** a worker can create a task already carrying privileged approved/confirmed/completed and audit fields. On update the branch proves only that the old assignee is the caller; it does not require the new assignee to remain the caller, so the worker can inject/reassign the forged task into another user's queue.
- **Consequence:** manager authority and horizontal task ownership are bypassed.
- **Fix:** define an exact safe worker-created initial state, pin privileged/audit/scope fields, and require both old and new `assignedUserId` to equal the caller for owner updates. Route privileged transitions through manager/server command rules.

## 🟠 Likely / high

### R-07 — Workers can self-classify as test accounts and disappear from reports

- **Evidence:** owner user update at `firestore.rules:239-271` does not pin `isTest`; exclusion at `src/components/Reports.jsx:62,1341` and `src/components/DailyStatistics.jsx:552-553`.
- **Consequence:** accountability and payroll/reporting evasion while underlying sessions remain. **Fix:** make `isTest` admin/server-only and pin it on self-update.

### R-08 — Scoped managers can operate on users outside their subtree

- **Evidence:** blanket manager paths at `firestore.rules:239-240`, active-session force-idle at `:399-404`, timer-command force-end at `:424-429`, and calendar manager mutations at `:564-591`.
- **Mechanism:** these branches check manager role but not the target user's overseer closure. Secondary force-end needs only active-session, user, and marker writes, so an out-of-scope manager can end another team's break/call/quick-work; calendar decisions have the same missing scope predicate.
- **Fix:** require the target user to be inside the caller's canonical overseer scope and pin calendar ownership; couple force-end effects atomically.

### R-09 — Notification writes permit spoofing, arbitrary recipients, and push abuse

- **Evidence:** `firestore.rules:611-622`; push triggers `functions/index.js:284-329`.
- **Mechanism:** `request_notifications` create lacks a recipient relationship, type allowlist, complete shape/length limits, rate limit, and dedupe. Recipient update can mutate more than read state. `calendar_requests` fan-out trusts client-supplied `managerIds`.
- **Consequence:** forged notifications, lock-screen spam, and arbitrary push fan-out.
- **Fix:** move delivery through a server/callable registry; validate recipient relationship, immutable provenance, type/schema/length, rate, and deterministic event IDs. Limit recipient updates to read-state fields.

### R-10 — Pay rates are disclosed to every active user

- **Evidence:** broad user-document reads at `firestore.rules:220-221`; `payRate` lives on that document and is protected only for writes at `:259-262`; sensitivity is documented in `docs/security/threat-model-checklist.md:53-54`.
- **Consequence:** company-wide compensation disclosure because Firestore cannot hide selected fields within an allowed document read.
- **Fix:** move compensation into an owner/admin-scoped document or collection and expose only a deliberately public user profile separately.

### R-11 — At-least-once Functions can double-count achievements and duplicate signup notifications

- **Evidence:** counter increment at `functions/index.js:524-535`; tier dedupe only after threshold at `:448-491`; nondeterministic pending-signup notification creation at `:971-1010`.
- **Mechanism:** Firestore triggers are at-least-once, but neither path records the event ID. A retry can increment again or create another notification.
- **Consequence:** prematurely awarded achievements and duplicate operational alerts.
- **Fix:** transact on a deterministic trigger-event marker and use deterministic notification IDs.

### R-12 — ADR-0020's atomic command contract is conventional, not rule-enforced

- **Evidence:** client batch at `src/utils/timerTransitionExecutor.js:6-23`; independent rule clauses at `firestore.rules:381-439`.
- **Mechanism:** the client batches active session, command marker, user/task projection, and ledger, but rules do not use `getAfter` / `existsAfter` to require the matching bundle. A buggy or custom client can advance canonical revision without all required effects.
- **Consequence:** canonical state, projections, and credited ledger can diverge despite the ADR naming rules as a correctness boundary.
- **Fix:** bind command ID/revision/run and required post-write documents in rules, or process the command in a trusted server transaction.

### R-13 — Offline command replay ordering depends on wall-clock timestamps

- **Evidence:** `src/utils/timerOutbox.js:24-26`, `:123-139`; `src/utils/timerCommandEngine.js:128-157`.
- **Mechanism:** there is no monotonic per-user sequence/dependency; replay sorts only by `issuedAt`. Clock rollback or equal-millisecond commands can reorder dependent start/stop operations.
- **Consequence:** conflicts can strand the timer in the wrong state and accumulate ghost time.
- **Fix:** allocate a monotonic per-user sequence transactionally, record dependencies, and block dependent replay until predecessors terminate.

### R-14 — Canonical session boundaries trust client clocks

- **Evidence:** `src/utils/timerTransitionPlan.js:297-300`, `:340-352`, `:388-395`; `firestore.rules:359-378`.
- **Mechanism:** start/stop boundaries come directly from client `issuedAt`; rules only require strings and do not constrain skew against `request.time`.
- **Consequence:** clock changes or multi-device offsets silently zero time or inflate it up to the clamp, and a hostile client can forge plausible boundaries.
- **Fix:** use a trusted server time/offset model, reject implausible deltas explicitly, and route corrections through an audited flow.

### R-27 — Task-history export performs one Firestore query per displayed task

- **Evidence:** `src/components/TaskHistory.jsx:307-313`.
- **Mechanism:** export issues a separate `work_sessions where taskId == ...` query for every displayed task.
- **Consequence:** N tasks produce N extra network requests, increasing export latency, read cost, and parallel request pressure.
- **Fix:** load the date-range sessions once and group by task ID, or batch task IDs through bounded `in` queries.

### R-28 — Weekly hours summary subscribes to the entire work-hours history

- **Evidence:** `src/components/CombinedHoursSummary.jsx:71-79`.
- **Mechanism:** the realtime query has no date or user bound; current-week filtering happens only after every `work_hours` document reaches the client.
- **Consequence:** each mount and update scales with the full lifetime dataset.
- **Fix:** constrain the server query to the week interval and caller scope.

### R-35 — Private session-read migration left task-centric readers permanently denied

- **Evidence:** `src/utils/sessionEditActions.js:77-111,150-153,197-200,328-331,398-402,425-427`; `src/domain/commands/deleteTask.js:69-80`; `src/components/TaskHistory.jsx:306-369`; `src/components/TaskDetailsModals.jsx:370-390`; private rule at `firestore.rules:327-330`; contradictory rule comment at `firestore.rules:117-130`.
- **Mechanism:** all four readers query `work_sessions` by `taskId` only. Workers and scoped/senior managers may read only rows provably owned by them or stamped for their team, but the queries carry neither `userId == uid` nor `teamManagerIds array-contains uid`. Firestore rules are not row filters, so the whole query is rejected. In reconciliation, this is the first operation; task reads and the five-field update are never reached. The canonical session mutation has already succeeded and the error is swallowed.
- **Consequence:** production recorded 16 deterministic reconciliation denials across three workers and one scoped manager. Backdate/edit/delete/recovered-gap actions can report success while the task counter disagrees with the canonical ledger; hard-delete can remove a task while leaving its sessions reportable; scoped time correction and history export fail. A non-atomic read/sum/write also retains a TOCTOU stale-projection window after authorization is repaired.
- **Fix:** do not broaden private reads. Centralize role-aware session queries, move cross-document reconciliation and delete cascade to an authorized idempotent server path, and test worker/scoped/admin role matrices plus ledger-projection equality in the emulator.

### R-36 — The earnings popup silently prices every task from the first monthly tier

- **Evidence:** `src/components/EarningsModal.jsx:33-52,60-64`; private session read at `firestore.rules:327-330`; tier oracle at `src/utils/payRate.test.js:153-168`.
- **Mechanism:** the worker popup queries the month by `date` only and filters `userId` in JavaScript. The private read rule deterministically rejects it; the catch converts failure into `priorMinutes = 0`, after which marginal earnings are computed over `0 → taskHours` rather than `actualPrior → actualPrior + taskHours`.
- **Consequence:** a worker with 38 prior hours and a six-hour task under the existing €10/€15 test tiers should see €80 but is shown €60 — 25% low — with no degraded-data warning. Other tier shapes can err in the opposite direction. Canonical payroll data is not mutated, but the user-facing money estimate is false.
- **Fix:** constrain the query by the authenticated `userId` (the required index already exists), preserve an explicit loading/error state, and add a component/rules test that proves the 38 h + 6 h boundary case.

### R-37 — Clickable table rows replace native row semantics with button semantics

- **Evidence:** `src/components/task/TaskRow.jsx:40-52`; `src/components/DailyStatistics.jsx:1432-1439`.
- **Mechanism:** both native `<tr>` elements are changed to `role="button"`, made focusable, and given activation handlers. Keyboard activation exists, but overriding the row role breaks the row/cell relationship assistive technology relies on to navigate and announce a table.
- **Consequence:** report/history data loses dependable structure for screen-reader and table-navigation users even though pointer and keyboard activation work.
- **Fix:** preserve the native row role and place one labelled real button/link in a cell; keep whole-row pointer click only as a redundant shortcut.

### R-38 — The binding 44 × 44 px interaction gate is violated across core surfaces

- **Evidence:** representative confirmed targets at `src/pages/ProfilePage.jsx:520-527`, `src/components/ui/SearchBox.jsx:180-184`, `src/components/reports/PeriodPicker.jsx:48-52,74-89`, `src/components/TaskModal.jsx:1547-1555`, `src/components/task/TaskDetailModal.jsx:397-410`, `src/components/UserProfileModal.jsx:490-531`, `src/components/TaskHistory.jsx:599-603,796-817`, `src/components/TaskTable.jsx:46-58,84-94,503-510`, and `src/components/task/ReorderableTaskTable.jsx:49-60`; mandatory contract at `docs/design/DESIGN_SYSTEM.md:165-184,418-423`.
- **Mechanism:** active controls range from roughly 22 to 40 px and many deliberately bypass the canonical minimum-touch component. Additional undersized drag handles and dismiss/recovery controls repeat the pattern on board, checklist, history, report, and authentication surfaces.
- **Consequence:** materially higher mistap and motor-access burden for the app's phone/gloves/outdoors audience. The 44 px threshold is the project's binding gate and WCAG 2.1 SC 2.5.5 AAA; it must not be misreported as a standalone AA conformance failure.
- **Fix:** make the hit area `min-h-touch min-w-touch` without necessarily enlarging the glyph, migrate icon-only controls to `IconButton`, and add a regression check for raw undersized interactive classes.

## 🟡 Risk

### R-15 — Call and quick-work ledger IDs are timestamp-derived, not run-derived

- **Evidence:** `src/utils/timerTransitionPlan.js:824-950`.
- **Consequence:** two distinct runs with the same client start millisecond overwrite the same history row. **Fix:** derive every new-engine ledger ID from `runId` and persist that ID in the row.

### R-16 — Terminal outbox records are never pruned

- **Evidence:** `src/utils/timerOutbox.js:64-152`.
- **Consequence:** IndexedDB grows without bound until storage/performance pressure can break enqueue on long-lived mobile installs. **Fix:** TTL/count-prune only terminal records while retaining queued items and a bounded diagnostic window.

### R-17 — Completion photos are outside attachment cleanup

- **Evidence:** upload field at `src/components/CompletionPhotoModal.jsx:83-88`; cleanup only reads attachment fields at `functions/index.js:366-393`.
- **Consequence:** task/archive deletion and upload→Firestore failure leave permanent Storage orphans. **Fix:** include `completionPhotoUrls` in cleanup and the periodic orphan janitor.

### R-18 — A modal bypasses the canonical Select

- **Evidence:** `src/components/BackdateTimeModal.jsx:183-194`; binding rule in `docs/design/DESIGN_SYSTEM.md` §8.
- **Consequence:** phone/modal presentation, language, width, focus restoration, and interaction behavior drift from the one approved control. **Fix:** use canonical `Select` with modal-sheet presentation.

### R-19 — Session labels drift from the binding terminology

- **Evidence:** `src/utils/sessionColors.js:32,65`, consumed at `src/components/QuickWorkTimer.jsx:664-665`; canonical labels at `docs/design/DESIGN_SYSTEM.md:80,83` and `docs/design/tokens.md:79,82`.
- **Consequence:** centralized UI says “Greita veikla” / “Vyksta veikla” while the required vocabulary is “Greitas darbas” / “Vyksta darbas”. Color still has label+icon, so this is not a color-only WCAG failure. **Fix:** align the map or ratify the new wording in the binding docs.

### R-20 — The design system contradicts the Gildija brand boundary

- **Evidence:** `docs/design/DESIGN_SYSTEM.md:59-65`, `docs/adr/0001-visual-design-system.md:68`, `docs/decisions-log.md:137-139`, `.claude/commands/debug.md:96-110`, and `.claude/workflows/triage-sweep.js:26` name WORKZ as the user-facing product, while `AGENTS.md:13-15` / `CLAUDE.md:16-19` make WORKZ internal and Gildija user-facing.
- **Consequence:** the binding UI document encourages reintroducing the wrong public brand. **Fix:** correct §3 to Gildija for user surfaces.

### R-21 — Session-theme comments describe obsolete invariant behavior

- **Evidence:** `src/components/Layout.jsx:79-85`; `src/utils/sessionColors.js:39,50,61,72` versus theme-reactive implementation at `sessionColors.js:11-23` and ADR 0016.
- **Consequence:** future changes can follow stale comments and regress dark-theme contrast. **Fix:** describe light-theme classification plus dark CSS overrides accurately.

### R-22 — AppHeader uses the navigation stacking token

- **Evidence:** `src/components/AppHeader.jsx:53`.
- **Consequence:** header and navigation share a layer, making overlap depend on DOM order. **Fix:** use `z-header`.

### R-23 — Component-local color literals duplicate design tokens

- **Evidence:** `src/components/AllUsersCalendar.jsx:33`; `src/components/UserManagement.jsx:699`.
- **Consequence:** vacation and initial worker/brand colors drift when the design token changes. **Fix:** source semantic shared tokens/constants.

### R-24 — ActiveWorkSessions performs O(users × tasks) lookup work

- **Evidence:** `src/components/ActiveWorkSessions.jsx:107-147`.
- **Consequence:** every realtime update can jank the manager surface as team/task counts grow. **Fix:** build one `Map(taskId → task)` inside the memo and use O(1) lookups.

### R-25 — The full-sweep protocol describes a retired project topology

- **Evidence:** `.agents/skills/source-command-full-debug-sweep/SKILL.md:20-21,48,61-63,121`, `docs/audits/FULL_SWEEP_PLAN.md:15,201,244,250,259`, and executable `.claude/workflows/triage-sweep.js:24` versus `package.json`, `functions/`, and `firestore.indexes.json`.
- **Consequence:** an audit can falsely report zero tests and skip real Functions/index checks. **Fix:** update the skill and the stale lower sections of the durable plan to the current topology.

### R-29 — Global notifications retain all historical manager calendar requests

- **Evidence:** `src/context/NotificationsContext.jsx:130-139`.
- **Mechanism:** the always-mounted provider filters only `managerIds array-contains uid` on the server and counts `status == pending` in the client.
- **Consequence:** network and memory retain an ever-growing history to render one active counter.
- **Fix:** add the server-side pending filter plus its composite index, or maintain a pending rollup.

### R-30 — WorkPlanner subscribes to a user's entire schedule history

- **Evidence:** `src/components/WorkPlanner.jsx:240-245`.
- **Mechanism:** the query filters by user only, not the visible calendar interval.
- **Consequence:** long-lived accounts download and process all historical schedule rows on every mount.
- **Fix:** bind the subscription to the visible week/month and update it as the calendar navigates.

### R-31 — UserManagement duplicates the global users listener

- **Evidence:** `src/context/UsersContext.jsx:30-53`; `src/components/UserManagement.jsx:729-751`.
- **Mechanism:** the global context already subscribes to all users, while the admin screen opens an identical second realtime listener.
- **Consequence:** duplicate snapshot callbacks, transformation work, and render triggers.
- **Fix:** consume `UsersContext` or centralize one purpose-specific query.

### R-32 — PWA update polling leaks an interval and turns transient failures into crash logs

- **Evidence:** `src/components/PwaUpdatePrompt.jsx:36-40`; global rejection capture at `src/utils/errorLog.js:142`.
- **Mechanism:** `registration.update()` has no rejection handler and the hourly `setInterval` handle is never cleared.
- **Consequence:** remounts can stack update loops; transient SW/CDN/network failures become noisy global `unhandledrejection` records. Six such failures occurred on production in the newest live error window.
- **Fix:** own the interval in an effect teardown and handle/classify/rate-limit update failures.

### R-33 — Worker-facing progress copy uses informal singular address

- **Evidence:** `src/components/DailyWorkProgress.jsx:211-212`.
- **Consequence:** “Gera pradžia, tęsk!” and “Pradėk dieną…” violate the binding formal “Jūs” voice. **Fix:** use “tęskite” / “Pradėkite dieną…”.

### R-34 — ADR-0015 still presents the command substrate as an unwired Phase 1

- **Evidence:** `docs/adr/0015-ai-native-command-substrate.md:3,90,224` versus the UI-wired increments in `docs/decisions-log.md:23`.
- **Consequence:** an implementer can believe the command layer is inert and reintroduce direct writes. **Fix:** update the ADR status/current-state section while retaining the original Phase 1 text as history.

### R-39 — Active drag and filter affordances fall below 3:1 non-text contrast

- **Evidence:** `src/components/board/PriorityBoard.jsx:74-77`, `src/components/task/ChecklistEditorList.jsx:52`, `src/components/task/ReorderableTaskTable.jsx:51-59`, and `src/components/TaskTable.jsx:84-94`; `ink.muted` token `#6B7280` is rendered at 40–50% opacity.
- **Mechanism:** compositing the muted token over the white/sunken surfaces yields roughly 1.7–2.0:1. These glyphs are the visible active drag/filter affordance, not decorative or disabled graphics.
- **Consequence:** the control boundary/function is difficult to perceive and misses WCAG 1.4.11's 3:1 non-text contrast threshold. Several of the same controls are also undersized under R-38.
- **Fix:** use a semantic control-foreground token that remains at least 3:1 in every theme/state and verify the computed composite, not just the base hex.

### R-40 — ARIA tabs and radios omit their composite-widget keyboard model

- **Evidence:** tab sets at `src/pages/ManagerView.jsx:307-422,725-762`, `src/components/ManagerNotifications.jsx:718-749`, `src/components/Reports.jsx:793-830`, and `src/components/UserProfileModal.jsx:487-531`; radio sets at `src/components/CallTimer.jsx:86-100`, `src/components/QuickWorkTimer.jsx:131-144,231-243`, `src/components/QuickWorkDescribePrompt.jsx:90-100`, `src/components/ReportExportModal.jsx:259-270`, and `src/pages/ProfilePage.jsx:584-646`.
- **Mechanism:** ordinary buttons carry `role="tab"` or `role="radio"`, but there is no roving tab stop or Arrow/Home/End behavior expected for those ARIA composite roles.
- **Consequence:** every option remains reachable with Tab plus Enter/Space, so this is not a proven keyboard lockout; it is an APG interaction mismatch that makes keyboard navigation verbose and surprising.
- **Fix:** implement the relevant WAI-ARIA APG pattern centrally, including roving `tabIndex`, arrow movement/selection, Home/End for tabs, and correct selected/controlled relationships.

### R-41 — The mandatory accessibility gate has no automated semantic regression control

- **Evidence:** `.eslintrc.cjs:4-13`; `package.json:29-44`; the only focus-related test is a class-string equivalence check at `src/components/ui/SessionToggleButton.test.js:1-10`.
- **Mechanism:** lint enables React/hooks rules but has no `eslint-plugin-jsx-a11y`; the dependency/test surface has no axe or DOM accessibility runner and no ARIA/keyboard interaction assertions. Therefore green lint/tests cannot detect R-37, R-38, or R-40.
- **Consequence:** the documented mandatory gate depends entirely on manual review and can regress while every deterministic quality gate remains green.
- **Fix:** add semantic lint rules plus targeted rendered-component axe and keyboard tests; retain manual/visual checks for contrast, responsive hit areas, and assistive-technology behavior.

### R-42 — DailyStatistics maintains unread scheduled-task state on every snapshot

- **Evidence:** `src/components/DailyStatistics.jsx:121,124,189,192-194,297-315,391-394`.
- **Mechanism:** the `scheduledTasks` value is discarded during state destructuring, but each task snapshot still filters/rebuilds a new array and calls its setter. The fresh reference defeats React's identity bailout and schedules a render of the large statistics surface even though no render reads the value.
- **Consequence:** unnecessary O(tasks) filtering and rerenders stack with the component's other live listeners. The neighbouring `dailyStats` null setter normally bails out and is only dead scaffolding, not the same rerender defect.
- **Fix:** remove the unused state/filter path or consume one memoized derived value; delete the no-op daily-stats scaffolding separately.

## ℹ️ Information

### R-26 — Session color map carries unused contract fields

- **Evidence:** `src/utils/sessionColors.js:37,39,48,50,59,61,70,72`.
- `accentBg` and `onShell` have declarations but no consumers; current callers use `accentBorder` and CSS controls on-shell foreground. Remove them or make them the actual centralized contract.

### R-43 — One orphan module and a bounded set of zero-consumer exports remain

- **Evidence:** orphan barrel `src/components/icons/index.js:1-21`; glyphs reachable only through it at `src/components/icons/connectionGlyphs.jsx:34` and `src/components/icons/metricGlyphs.jsx:20`; zero-consumer declarations at `src/components/TaskDetailsModals.jsx:19`, `src/components/ui/Loading.jsx:18`, `src/config/navTabs.js:70`, `src/utils/formatters.js:41`, `src/utils/sessionAdmin.js:96`, `src/utils/timeUtils.js:207,217`, and `src/utils/timerOutbox.js:146`; dead daily-stats placeholder at `src/components/DailyStatistics.jsx:121,189,236-241`.
- A Babel import/export graph parsed 307 project modules with zero failures. All 232 application runtime modules are reachable from `src/main.jsx` except the icon barrel; Functions handlers, dynamic/test imports, maintenance scripts, PWA assets, configs, and intentional test seams were excluded from false-positive classification. These declarations are maintenance debt only: there is no proved runtime defect and Rollup can tree-shake the pure unused surface.

## Explicitly rejected / clean checks

- The timer executor does commit one generated plan in a Firestore batch; network partial commit is not the bug.
- Recovery's two ledger rows do not overlap; the defect is two independent clamp budgets.
- Direct negative `durationMinutes` values are clamped; clock skew still causes silent loss/inflation.
- Task ledger IDs are correctly run-derived; only call/quick-work rows retain timestamp IDs.
- `useRevisionedTimerSession` returns its `onSnapshot` unsubscribe; sampled session/listener paths and online/offline listeners clean up correctly.
- Session shell, persistent label/icon, active readout, and offline neutral slate use the centralized session system; no color-only or red-offline defect was found.
- No live `window.confirm` / `window.alert`, banned sub-12 arbitrary text classes, or unmanaged arbitrary z-index was found in the completed searches.
- Local `firestore.indexes.json` matches all 12 live READY composites; `decision_log`, `integrity_reports`, direct Storage owner paths, and disabled-user gating passed their focused checks. Public Firebase web/VAPID config was not misreported as a secret; no real secret leak was confirmed.

## Completed final-enumeration coverage

The final resume inspected every JSX candidate for nonsemantic click behavior, accessible names, touch size, visible focus, text floor, mobile table alternatives, reduced motion, and color-only signaling. It also parsed the complete JS/JSX/CJS import/export graph (307 modules, zero parse failures) and classified runtime entrypoints, dynamic imports, tests, Functions handlers, maintenance scripts, configs, and PWA assets. The last two high accessibility findings were independently challenged and retained; false positives with an equivalent real button, canonical `IconButton`, enlarged pseudo hit areas, mobile card fallbacks, global reduced-motion protection, or textual/icon state cues were rejected.

The only tooling limitation after evidence collection was the final duplicate shell confirmation: the desktop command quota closed before another `git status` and duplicate `rg` pass. No unverified candidate is promoted above, and all assistant writes remained inside this audit directory.
