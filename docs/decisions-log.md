# WORKZ — Decisions log

Chronological index of major decisions (ADRs) and notable inline decisions.
**AI agents read this first for orientation.**

## ADRs

| # | Date | Status | Decision |
|---|---|---|---|
| [0001](./adr/0001-visual-design-system.md) | 2026-06-20 | Accepted | Visual design system & tokens — keep the bold whole-screen session color (with mandatory text labels), indigo brand accent, system font, WCAG AA as a mandatory gate, dual density, canonical component set. |
| [0002](./adr/0002-agent-operating-model.md) | 2026-06-20 | Accepted | Agent operating model — `AGENTS.md`/`CLAUDE.md` entry points, free-write + `[ai-author]` audit, English artifacts / Lithuanian UI, Netlify hosting + Firebase backend, `docs/` + ADR structure. |
| [0003](./adr/0003-push-notification-strategy.md) | 2026-06-22 | Superseded by 0004 | Notification strategy — originally deferred FCM background push; reversed same day. The permission-on-first-interaction change still stands. |
| [0004](./adr/0004-notification-infrastructure.md) | 2026-06-22 | Accepted | Notification infrastructure — **build the full stack**: Cloud Functions (`functions/`) as FCM sender + Storage-orphan janitor, client token registration + dedicated FCM service worker, a `ToastProvider`, and a global `NotificationsProvider` (unread count → OS badge + foreground toast). Requires Blaze + a VAPID key + human-run `functions`/rules deploys — see `docs/runbooks/fcm-notifications-deploy.md`. |
| [0005](./adr/0005-scoped-manager-hierarchy.md) | 2026-06-22 | Accepted (senior-manager follow-up superseded by 0007) | Scoped manager hierarchy — a **real** (server-enforced) confidentiality boundary so a scoped manager sees/assigns only their assigned people's tasks & reports. **Many-to-many** `teamManagerIds` array on the user doc + denormalized onto private rows (`tasks`/`archived_tasks`/`work_sessions`/`break_sessions`/`deleted_tasks`); read rule `isAdmin() \|\| owner \|\| uid in teamManagerIds`, query via `array-contains` (no 30-id cap). Admin stays global; scoped manager = view+assign+reports only; **full history** kept live by a re-stamp Cloud Function; the **shift calendar stays public**. Three-phase rollout (membership+stamp+migrate → self-scope queries → tighten rules+indexes); rules deploy + index creation are founder-run. |
| [0006](./adr/0006-notification-bell-and-two-way-feed.md) | 2026-06-23 | Accepted | Notification bell, top bar & two-way feed — a calm top `AppHeader` (active-session pill + bell with unread count + avatar; **no** brand/role, which stay in the rail) opens a single **hybrid** panel: action cards + info rows. Makes notifications **two-way** over the existing recipient-keyed `request_notifications` (workers now get task assigned/approved/confirmed/reverted + extension + calendar decisions) via one `notify()` funnel; `category` derived from `type` (no backfill). **Routing follows the event:** task-bound → the single assigned manager; person-level (calendar) → ALL the worker's managers via `managerIds` `array-contains` (no composite index; `pending` filtered in memory). `CalendarRequestStatusBanner` + the inline `ManagerView` feed are removed. No rules/index deploy needed; **`functions` deploy (founder)** adds FCM copy for the new types + calendar push fan-out. |
| [0007](./adr/0007-senior-manager-subtree.md) | 2026-06-23 | Accepted | Senior manager as a scoped subtree (four-level hierarchy: **Administratorius → Vyr. vadovas → Vadovas → Vykdytojas**). Supersedes ADR 0005's "senior = whole company" follow-up: a `seniorManager` is now SCOPED to its transitive subtree (its assigned managers + those managers' workers), querying identically to a scoped manager. Two admin-only membership fields — `teamManagerIds` (a worker's managers) + `seniorManagerIds` (a manager's seniors); the Cloud Function folds them into an `overseerIds` closure on the user doc (function-only, no client write) **and** stamps the same closure onto each owned row's `teamManagerIds`. CREATE rule reads `overseerIds` (row unstamped at create); a manager's senior-change **cascades** a re-stamp to that manager's whole crew. `UserManagement` gets bidirectional assignment (rank-correct candidate pools); client switches the six read-surfaces to `isScopedOverseer` and drops `seniorManager` from `canSeeWholeTeam`. Founder-run: rules + functions deploy + one `backfillTeamStamps` run. |
| [0008](./adr/0008-user-selectable-theme.md) | 2026-06-23 | Accepted | User-selectable light/dark theme — a 3-state choice (`Sistema`/`Šviesi`/`Tamsi`, default follows the OS) switchable from the profile. Reverses ADR 0001's dark-mode deferral by separating the **calm canvas** (inverts with the theme) from the **loud session color** (stays invariant — the identity). Mechanism: the `brand`/`surface`/`ink`/`line`/`feedback` tokens become CSS-variable-backed (`rgb(var(--x)/<alpha-value>)`) and swap on a single `<html data-theme>`; `feedback.*` grows soft/border/text/hover sub-tokens; the priority ramp goes theme-reactive (inverts in dark). No-flash boot script + `ThemeProvider` above `AuthProvider`; persists to localStorage **and** the Firestore user doc (`themePreference`). **No `firestore.rules` change** (owner self-write already allowed). Session shells, tier medallions, the modal scrim and the loud time popups stay theme-invariant. |
| [0009](./adr/0009-session-time-editing.md) | 2026-06-23 | Accepted | Per-session time editing (admin) — **`work_sessions` is the canonical logged-time record**; an admin edits a finished session's **start/end** (the credited `durationMinutes` + Vilnius day bucket are DERIVED and clamped; totals recompute live, nothing to backfill) with a live **"Bendra suma: A → B"** readout, **mutate-in-place + original snapshot + reason** audit, and full CRUD (edit · soft-delete · add missing). Opens from the day-timeline rows (`SessionEditModal`). The two legacy **delta** editors are **retired** (`DailyStatistics` task-total pencil removed; `TimeAdjustmentsModal` → read-only), with all existing `timeChanged*`/`isManualAdjustment`/`timeAdjustments` data **kept and still visible**; double-count reconciliation unchanged. Admin-only (`userRole === 'admin'`); **no `firestore.rules` change** (admin already has `work_sessions` CRUD via ADR 0005). |
| [0012](./adr/0012-tiered-pay-rates-earnings.md) | 2026-06-23 | Accepted | Tiered per-worker pay rates + after-tax earnings popup — admin sets each Vykdytojas a **monthly-hours MARGINAL** tier table of **NET** hourly rates (`payRate.tiers` on the user doc; admin-only write, new `firestore.rules` clause mirroring `teamManagerIds`); the system derives GROSS from one **orientation effective tax rate ≈ 29.22%** (LT individuali veikla 2026: GPM 11.667% at €30k + Sodra 19.5% on 90% base, **no** expense deduction — knobs in `src/utils/payRate.js`). After a worker finishes their own task a popup (`EarningsModal`) shows **gross first, net beside**, valuing the task as the marginal slice it adds on top of the month's cumulative worked hours (tasks + quick-work + calls from `work_sessions`; breaks excluded). Currency via `formatEur` (lt-LT). **Founder-run:** rules deploy. |
| [0011](./adr/0011-data-durability-and-integrity.md) | 2026-06-23 | Accepted (live) | Data durability & integrity safety net — a **four-layer** answer to "an AI agent or bug could destroy the work-hours data". A live DB check found **PITR disabled, delete-protection disabled, no scheduled backups** (only task-level archive existed; a prior bug already wrote 247 corrupt `break_sessions` cleaned by a one-off script). Layers: (1) **PITR + delete-protection** (managed, 7-day rewind — the primary recovery), (2) **native scheduled backups** (daily 7d + weekly 14w, off-database), (3) **rules shape/range validation** — `durationMinutes ∈ [0,1440]` on `work_sessions`/`break_sessions`, string `start`/`end` on `work_hours`, validated only when present (create) or changed (update) so partial updates and corrupt-row remediation still pass, and (4) **`dailyIntegrityScan` Cloud Function** — daily volume-drop canary (>30% day-over-day = `critical`) + value-anomaly scan → `integrity_reports/{date}` (manager/admin-read, client-immutable). **All four layers activated & verified live 2026-06-23** — PITR + delete-protection via the Firebase admin API; daily (7d) + weekly (98d/Sunday) backup schedules + rules + `dailyIntegrityScan` via the Firebase CLI (gcloud here lacked the owner credential, so the CLI/admin-API path was used). No client change. Runbook: [`firestore-backup-recovery.md`](./runbooks/firestore-backup-recovery.md). |
| [0010](./adr/0010-custom-icon-system.md) | 2026-06-23 | Accepted (phased) | Custom symbol/icon system — coherent glyph families on one drawing canon (24px, monochrome `currentColor`, glyph always paired with its Lithuanian label) and a grammar of orthogonal modifiers (WHICH = silhouette · WHOSE = team badge · STATE = countable/fill). One keyed map per family under `src/components/icons/`. Shipped: status-circle (running = green play no-ring, completed = green ring+check, confirmed = green fill+white check) + priority meter; nav silhouettes + team badge; role/rank insignia (+ `seniorManager` mislabel fix); calendar change-deltas; offline glyph; reports metric time-bars; notification hourglass family. Founder scoping: sessions kept as-is, no on-site calendar glyph, crests dropped, admin = shield only. Renumbered from 0007 (collided with the senior-subtree ADR). Client-only — no rules/index/functions change. |
| [0014](./adr/0014-dev-test-login-and-visual-qa.md) | 2026-06-23 | Accepted | Dev-only test login for repeatable visual QA — closes the standing *"not visually QA'd — needs Google auth"* gap. The Google popup can't be driven by an automated browser, so a **dev-only email/password panel** was added to `Login.jsx`, gated by `import.meta.env.DEV` (dead-code-eliminated from prod builds, like the existing "Skip Loading" debug button). The test identity is a real Firebase Auth user whose Firestore doc is `role: 'admin'` (full visibility — no rules change; "see everything" is one field) + `isTest: true` (already excluded from Reports/Statistics) + parked `isDisabled: true` at rest. Credentials live in gitignored `.env.local` (public repo → never committed; `.env.local.example` documents the vars). Security is the "disable when done" itself: a disabled Auth user can't mint a token, so a leaked password is inert. **Founder-run setup** (enable Email/Password provider — no API/MCP path; create auth user; seed admin doc). Procedure + teardown: [`visual-qa-test-account.md`](./runbooks/visual-qa-test-account.md). **No `firestore.rules` change.** |
| [0015](./adr/0015-ai-native-command-substrate.md) | 2026-06-23 | Accepted (Phase 1) | AI-native **command substrate** — the foundation for connecting AI manager agents later. A new transport-agnostic `src/domain/` command layer designs in four cross-cutting concerns from the first command: an **actor model** (`human`/`agent`/`system`, acting as itself — the `[ai-author]` instinct at the data layer), an append-only **decision log** (`decision_log`, the event/audit spine; doc id = idempotency key → retries don't duplicate; best-effort, never aborts the command), a **`defineCommand` kernel** (pure `plan` shared by both modes + soft `authorize` refusals + `apply`), and a **propose/commit** contract (**default is propose** — never writes unless asked). First command **`assignTask`** makes work distribution a first-class, audited operation; the **human-only boundary is in code** (an agent may propose but is refused on commit). New `decision_log` rules clause: append-only, provenance-bound (`actorId == uid`), manager/admin read, admin delete. Additive + inert-safe; `assignTask` built+tested but **not yet UI-wired**. **Adversarial multi-agent review** (15 findings → 7 fixed) hardened it: `actorType:'human'` pin on create, kernel-owns the audit-never-aborts guarantee (+ non-throwing `appendDecision`), `apply`-idempotency contract, `assignedUserName` no longer persisted, decision_log shape guards, failure-class crash-log tagging. Gate green (lint · **226 tests** · build · rules MCP-validated). **Increment 2 (same worktree):** `TaskModal` reassignment now routes through `assignTask` (command owns the assignee write + audit; non-atomic 2nd write surfaces a precise error + suppresses a false notification on failure — driven by a focused review). **Founder-run:** deploy `firestore.rules` to activate the audit. **Increment 3:** a `createTask` command is the single audited create path — `createManagerTask` delegates to it and `TaskModal`'s create branch calls it (inline `addDoc` removed), killing the dual-create drift; kernel result gained `targetId`. Adversarial review clean (0 findings); live-QA'd in prod (field-equivalent doc + `createTask` audit entry). **Increment 4:** `completeTask` + `reopenTask` make completion/reopen audited lifecycle transitions (`toggleTaskCompletion`/`revertTask` delegate; dead one-way `completeTask` util + `sanitizeTaskData` removed; acting user threaded for attribution). Review clean (0/4); live-QA'd a full create→complete→reopen cycle in prod (3 matching decision entries). **Increment 5:** `approveTask` consolidates 4 identical scattered approve writes (TaskCard, TaskTable, ManagerNotifications ×2) into one audited command; `reprioritizeTask` + `rescheduleTask` are agent-ready triage verbs (not yet UI-wired). Review clean (0/0); live-QA'd create→approve→reprioritize→reschedule in prod (4 matching decision entries). Vocabulary now: create · assign · approve · complete · reopen · reprioritize · reschedule. |
| [0016](./adr/0016-theme-reactive-session-colors.md) | 2026-06-24 | Accepted | Theme-reactive session colors — the four session hues (quick-work red, call blue, break amber, task green) were frozen as theme-INVARIANT literal hex by ADR 0008, but three are pale light-canvas tints that glared as bright full-screen washes on the dark canvas. Narrows 0008: the **hue** stays the identity, the **tone** now follows the canvas. Each session token (`shell`/`surface`/`accent`/`soft`) moves to CSS-variable-backed (light values byte-identical → behaviour-neutral); dark mode keeps the four hues as deep `*-900` shells (`#7F1D1D`/`#1E3A8A`/`#78350F`/`#14532D`) + deep hued surface/border, white on-shell text (≥7:1), and the `feedback`-style fill-vs-foreground split (`accent` fill unchanged, `accent`-as-text lightened to `*-400` via `[data-theme="dark"] .text-session-*-accent`). Client-only — **no rules/functions/index change, no deploy.** Gate green (lint · build · 436 tests). |
| [0013](./adr/0013-test-gate-for-time-credit.md) | 2026-06-23 | Accepted | Automated test gate for the stateful **time-credit / ghost-time** paths. Added Vitest coverage (firebase mocked, `timeUtils` real except an injectable `getLithuanianNow`) for `taskActions`/`sessionActions` pause/resume/end **credit math** — the clamp, the double-credit guard (a paused task clears `timerStartedAt`), single-level `pausedSession` nesting, and orphan-recovery accounting (a multi-day stale timer credits the 16 h ceiling, not the gap) — plus `errorLog` durable sinks (node env + `vi.stubGlobal`, **no jsdom**), `getSecondarySession` (exported pure), and extended `calculateCurrentTotalMinutes` cases (152 tests total). And **wired `npm test` into the `/ship` gate** (step 5, after build) behind a `vitest`-resolvability **preflight**: a worktree has no local `node_modules` and resolves the runner from the primary checkout's (like lint/build), so a missing runner **STOPs with remediation** instead of the old *spurious* red. The orphan hooks' React wiring is not rendered (no harness; the accounting is covered at the action layer they delegate to). CI clean-room backstop recommended, deferred. Only a pure `export` of `getSecondarySession` changed in app code — no rules/index/functions/behaviour change. |
| [0017](./adr/0017-notification-registry.md) | 2026-06-24 | Accepted | Notification **registry** — one source of truth (`src/notifications/registry.js`) declaring each `request_notifications` type's four delivery dimensions (**category · copy · sound · external push · link**), collapsing the old four-file edit (notify category map + toast copy + server push copy + feed renderer) that had **silently drifted** (`task_confirmed` "priimta" vs "patvirtinta"; `recurring_reassign` had no client copy). Client reads it directly; the Cloud Function keeps a hand-copied `copyForRequestNotification` mirror that `firebaseConsistency.test.js` now **evals + fails the gate on divergence** (like the priority/estimate/recurrence mirrors). Coupled fixes: **sound moved to the always-on toast plane** (`playNotificationCue` fires for every type whether the bell is open or not — was 1 type, only-when-open; toast was silent), **`playBeep` decoupled** from its hard-coded "7 min" notification (→ `playSevenMinuteBlock`), and the **4 remaining inline `addDoc` writers migrated to `notify()`**. Client-only at runtime; **no `firestore.rules` change**. Authoring guide: [`docs/guides/adding-a-notification.md`](./guides/adding-a-notification.md). **Founder-run (post-ship):** `firebase deploy --only functions` for the `task_confirmed`/`session_correction_request` push-copy fix. Gate green (lint · **458 tests** · build). |
| [0019](./adr/0019-priority-board-and-canonical-task-order.md) | 2026-06-26 | Accepted (client-only; no deploy) | Priority board + one canonical task order. A single comparator `compareTasksCanonical` (finished-last → **priority** → manual **`boardRank`** within the priority → **deadline** → **completion** = time spent/estimated → **createdAt**) becomes the order on **every** surface (worker + manager, mobile + desktop): `sortWorkerTasks` delegates to it and it is the manager list's default (search still ranks by relevance). Manual order is now **shared on the task** (`boardRank`, compared only within a priority; "freeze the column" = a present rank sorts above an absent one). A desktop-only, lazy `PriorityBoard` (four priority columns, **@dnd-kit** for keyboard-operable drag, reusing the mobile `TaskCard` with a drag handle) lets a manager **drag between columns to reprioritize** (audited via ADR-0015 `reprioritizeTask`) and **within a column to reorder** (`boardRank` batch). The toggle persists per user (`teamBoardView` on the user doc); the **personal `manualTaskOrder` + ↑/↓ arrows + `'Rankiniu būdu'` sort are retired**. **No `firestore.rules` change** (`taskFieldsOk` permissive; owner self-write) — client-only, no deploy. Gate green (lint · **625 tests** · build). |
| [0020](./adr/0020-reliable-offline-session-engine.md) | 2026-07-09 | Accepted (incremental rollout; task-timer slice first) | Revisioned offline session engine — one canonical `active_sessions/{uid}` record with stable `runId` + monotonic `revision`; persistent IndexedDB command outbox with explicit queued/confirmed/rejected/conflicted outcomes; rules-enforced expected-revision/run conflict checks; atomic active/task/ledger batches; deterministic one-row-per-run credit; metadata-aware confirmed state plus a narrow pending projection; automatic credit-and-continue recovery with worker undo; `work_sessions` remains the sole credited-time authority. Migration dual-writes legacy projections behind feature gates and keeps compatibility reads/rollback until telemetry proves the new path. No deployment during implementation; rules/functions remain founder-run post-ship. |
| [0021](./adr/0021-server-authoritative-timer-session-write-path.md) | 2026-07-12 | Accepted — Option A (rules binding shipped; R-04/R-06-create deferred as accepted risks) | Server-authoritative timer/session write path (audit **R-04** + **R-12**). Design session concluded that R-12 (atomicity) and R-04 (credited-time correctness) are **different** properties sharing one root cause (the client authors canonical timer state), and only R-12 is safely closeable at the rules level. **R-12 fixed now:** a `getAfter` bundle-binding on the `active_sessions` update rule (`taskCloseLedgerBound`) requires the deterministic `work_sessions/sess_run_{runId}` ledger row in the SAME batch, with a matching `runId` (content check, not mere existence), whenever a transition closes a task run — converting ADR-0020 invariant #6 from client-batch convention into a rule-enforced guarantee for the dominant task path (`closeTaskWrites` always emits that row). **Emulator spike disproved the budget fear:** the binding does not trip the per-request evaluation budget even stacked on the manager force-idle `overseesUser()` read (`active_sessions` is lean, unlike the `users` rule's ~10 pins). Break/call/quick closes (duration-gated or `startMs`-keyed ledgers the rule can't reconstruct) stay convention-enforced until the ADR-0020 migration folds them into the engine batch. **R-04 (a worker can mint unlimited canonical `work_sessions`)** and the create-time half of **R-06** are **formally deferred as accepted risks**: closing them requires a Firestore-**trigger** intent processor (a callable breaks offline start→stop — ADR-0020 explicitly rejected the sole-function path), which amends ADR-0020 §3 and is a large rewrite of the paid-time path validated only by emulator. Crucially the R-04 surface is **self-shrinking** — a full trace found 8 client `work_sessions`-create sites / 7 intents, but 4 are legacy siblings ADR-0020 migration retires, leaving 3 durable low-volume intents (self-backdate, gap-claim, manager-manual) for a later, smaller scoped ADR. Interim mitigations: `durationInRange` clamp, `MAX_BACKDATE_DAYS`/16h clamps, `dailyIntegrityScan`, `isTest`/quick-work report exclusions, manager pay review. Gate green (lint · **858 unit + 44 emulator** incl. 5 new R-12 oracles + R-08 regression · build). **Founder-run (post-ship):** `firebase deploy --only firestore:rules` from up-to-date `main`, then re-verify the LIVE ruleset via Firebase MCP. |
| [0018](./adr/0018-secondary-session-resume-and-server-net.md) | 2026-06-24 | Accepted (client live on merge; server net awaits a `functions` deploy) | Resume backgrounded secondary sessions; bound abandoned ones server-side. Quick-work/call/break are **server-anchored** (`now − persisted startTime`, 16h clamp), so screen-off/minimise lose nothing — the real cause of timers "finishing" is the boot orphan-recovery finalising **any** pre-boot session (mobile OS discards the PWA → reopen is a fresh load). Now the hook **resumes** unless the session is genuinely abandoned (new pure `isAbandonedSession`: crossed a Vilnius day OR elapsed > 16h), applied to all three types. The "never reopens" case is bounded server-side by new `autoCloseForgottenSessions` (in `dailyIntegrityScan`): it **credits** the clamped time as a real record (mirrors `handleLegacyLogging`; idempotent via deterministic ids + `create()`) — never discarded — clears the flags, audits under the ADR-0015 system actor. Manager force-end now flags **break** at **4h** (`BREAK_STALE_MINUTES`); call/quick-work/task stay 16h (force-end discards, so only non-work break drops early). **Adversarial review** hardened it: latch the boot decision (don't re-finalize a live session at midnight), shared deterministic record ids client↔server (`sess_*`, locked by `firebaseConsistency`) so the two closers can't double-credit, server net drops the display-only break accumulation. Gate green (lint · **442 tests** · build · functions lint). **Founder-run:** `functions` deploy (post-merge) — no rules/index change. |

## Notable inline decisions

- **2026-06-30** — **Firebase-shaped threat model + security-test checklist.** Added
  [`docs/security/threat-model-checklist.md`](./security/threat-model-checklist.md): a STRIDE
  pass and a 10-item pre-change checklist retargeted to how WORKZ actually enforces security —
  Firebase Auth identity, `firestore.rules`/`storage.rules` as the boundary, "reads broad,
  writes scoped", and the one-shared-project deploy reality. Grounded in recurring WORKZ pain
  (userId/actorId owner pins, self-escalation of `role`/`payRate`/`overseerIds`, scoped-manager
  out-of-scope writes, the `isDisabled` `.get()` trap, session-toggle races/double-credit). It
  is the security lens for `/security-review` and the gate to run **before** any human-only
  rules/functions deploy. Cherry-picked from the `agency-agents` security-architect agent and
  rewritten for Firestore — **adopted as a doc, not a standing agent** (curated-setup ethos).
  Docs-only; no code/rules/functions change.

- **2026-06-24** — **Undo affordance + guard-matches-reversibility rule.** Reworked the app's
  control logic so the *guard* fits the *cost of being wrong*, not how consequential an action feels:
  irreversible/destructive → confirm before (`ConfirmDialog`); cleanly reversible one-tap state
  flips → act immediately + offer undo for a few seconds; continuous timer control → no undo (the
  loud session color is the live feedback); trivially repeatable micro-edits → no undo. Built the
  canonical undo affordance on the existing `Toast` (new `action` slot = a ≥44 px brand-tinted
  "Atšaukti" pill + a GPU-safe draining countdown bar) and a one-line `useUndoableAction` hook
  (`run`/`undo`/`message`); undo is a **compensating inverse committed now**, never a deferred write
  (realtime + multi-device), routing through the audited `completeTask`↔`reopenTask` commands where
  they exist. Wired to the completion/approval/confirmation lifecycle (founder follow-up extended undo to manager
  **approve** with a DEFERRED outbound ping — the approve/confirm state commits now, but the worker
  notification is held for the undo window via `deferredEffect` and fires only if NOT undone, so an
  undo leaves the worker nothing to see and re-surfaces the manager's own request; approve's exact
  prior status is snapshotted so undo restores it precisely) — the everyday high-frequency flips:
  `TaskTable` complete↔reopen (its mark-complete confirm dialog removed — friction before a
  cheap-to-undo action), `TaskCard` manager "confirm finished" (its confirm dialog removed), and
  `ManagerNotifications` confirm-completion (single **and** the high-risk bulk "confirm all", which
  now reverses the whole batch from one snackbar). **Deliberately NOT wired** (documented): hard
  delete (irreversible — `deleteDoc` removes the doc), time-crediting finish (kept its confirm),
  revert-for-rework / calendar decisions (dual-case inverse / compound writes
  — confirm-before stays the right guard), and timers. Documented in `DESIGN_SYSTEM.md` §8 + the §11
  checklist. Client-only — no rules/index/functions/data change. Gate green (lint + build + 288
  tests); undo snackbar visually verified via Preview (44 px targets, brand-tinted pill, draining
  bar, theme-correct tokens in dark mode).

- **2026-06-23** — **"Task people" standard — one visual language to SHOW and to CHOOSE a task's
  Vykdytojas / Vadovas, plus a rebuilt create form.** Formalised in
  [`DESIGN_SYSTEM.md`](./design/DESIGN_SYSTEM.md) §8 ("Task people") + the §11 checklist: a person
  reads the same — avatar + `formatDisplayName` at one calm size — whether *displayed* (`AssigneeChip`
  for the assignee, with the worker-colour dot; `UserChip` + the `Vad.` label for the manager) or
  *chosen*. The missing half — choosing — is the new **`PersonSelect`**
  (`src/components/ui/PersonSelect.jsx`), wrapping the canonical `Select` (extended to carry an
  optional per-option `leading` avatar on the trigger AND every row) so the picker mirrors the chips.
  **`TaskModal` rebuilt** to consume it and to cut height: labels above text inputs become
  placeholders (title → "Ką reikia padaryti?"; deadline → "Atlikti iki… (neprivalomas įrašas)"), the
  ✨ AI parse button moved onto the title's own row, and the spine reordered **title → priority →
  deadline → Vykdytojas | Vadovas (side by side) → planned time → Daugiau**. The Vadovas picker was
  promoted out of "Daugiau" onto the spine, and the self-assigned collapse affordance dropped
  (assignee is always shown). Defaults unchanged (assignee = self; manager = the creator's default
  manager, or the creating manager themselves). Client-only — no rules/index/functions/data change.
  Gate: `lint` + `build` green; **live-QA'd via Preview** at 360 px (placeholder-as-label, AI inline,
  field order, side-by-side avatar pickers, a 17-person dropdown all carrying avatars, 44 px targets,
  no horizontal overflow, no console errors).

- **2026-06-23** — **Canonical `Select` dropdown — every native `<select>` migrated.** A new
  `src/components/ui/Select.jsx` is the one single-choice control, replacing all 20 native
  `<select>` across the filters (`ManagerView`, `WorkerView`, `TaskHistory`, `Reports`), the task
  form (`TaskModal`), the role editor (`UserManagement`), and the inline-edit / shift-time pickers
  (`InlineEditModal`, `WorkPlanner`). A native select cannot honour the app's pop-up rules — the
  browser fixes its panel width/position and its first row echoes the field label — so the module
  gives **two presentations on one behaviour**, mirroring the 2026-06-22 unified pop-up decision and
  `InfoPopover`: an **anchored panel the exact width of the trigger** on a normal page, and a
  **centred full-screen sheet** (canonical `Modal`, `level="top"`) when the trigger sits inside a
  scrollable modal/table (`alwaysSheet`) or on a phone (`<640px`). The **category name is now the
  panel heading, never the first option** — the disabled `Šablonai` / `Planuojamas laikas…` echo
  rows are gone and the trigger carries a `placeholder` instead. Accessible listbox (keyboard,
  `aria-activedescendant`, 44px targets, focus restored to the trigger). On a phone the filter
  classifiers pack two-per-row (Komandos darbai: `[Vykdytojas | Rūšiavimas]` over
  `[Prioritetas | Žyma]`). Documented in DESIGN_SYSTEM §8 + the §11 checklist. **Pure client/UI —
  no data, rules or schema change.**
- **2026-06-22** — **Four-level manager hierarchy — added the `seniorManager` (Vyr. vadovas)
  rank.** A fourth role was inserted between `admin` and `manager` so the org chain reads
  `Administratorius → Vyr. vadovas → Vadovas → Vykdytojas`. Per the founder's scoping choices it
  is deliberately the SIMPLE shape: a senior manager sees the **whole company** (no transitive
  subtree → **no** new denormalization / re-stamp Cloud Function, unlike [ADR 0005](./adr/0005-scoped-manager-hierarchy.md));
  its powers are **view + assign/confirm tasks + reports** (account management — role changes,
  block/unblock, team membership, logged-time edits — stays admin-only); and the existing manual
  per-manager scope toggle (`scopedManager`) is kept for `manager` only — a senior is **never**
  scoped. Security-wise the rank equals an *unscoped* manager: `isManagerRole` (`src/utils/formatters.js`),
  `canSeeWholeTeam` (`src/utils/teamScope.js`) and the `firestore.rules` predicates
  `isManagerOrAdmin`/`canSeeWholeTeam` were broadened to include it (new `isSeniorManager()`),
  while the admin-only gates (the `users`/"Vartotojai" tab in `navTabs.js`, the role-change rule,
  `canEditTime`) were left untouched. The role label was added to all four role→label maps
  (`UserManagement`, `SideRail`, `ProfilePage`, plus the `RoleSelect` dropdown). **Additive — no
  data migration.** **Rollout ordering:** the client makes a senior issue whole-company queries the
  OLD rules would deny, so the `firestore.rules` change must be deployed (founder-run) **before**
  anyone is promoted to Vyr. vadovas; until a senior account exists, shipping the client is inert.
  **Superseded by [ADR 0007](./adr/0007-senior-manager-subtree.md):** the senior is no longer an
  unscoped whole-company manager — it is now SCOPED to its transitive subtree (its managers + their
  workers), with the `overseerIds` closure + per-row stamping this note said it deliberately avoided.
- **2026-06-22** — **Unified pop-up presentation on one shell.** Every informational pop-up /
  dialog renders through the canonical `Modal`: the scrim dims the whole viewport and the
  dialog is a content-sized card **centred over it**, including on phones, where a pop-up must
  appear centred over the full screen rather than anchored to a trigger or corner (it is *not*
  stretched edge-to-edge). The two worker time pop-ups (`TaskTimeWarningPopup`,
  `TaskTimeLimitPopup`) — previously hand-rolled `fixed inset-0` overlays with their own scrim
  opacities (`bg-black/40` vs `/50`), focus-traps and z-values — were folded onto `Modal` via
  two new escape hatches: `bare` (caller-owned full-bleed chrome) and `level="top"` (alarm
  above any open modal). `InfoPopover` keeps its compact anchored bubble on `≥sm` but opens as
  a centred `Modal` over the dimmed screen on phones (so it is no longer a bubble that can clip
  off the edge). Toast stays a transient top notification (already on the shared tokens).
  Rationale + the design rule live in `DESIGN_SYSTEM.md` §8.
- **2026-06-20** — Retired the legacy **"Viduramžiai.LT"** brand. The product name is now
  **WORKZ** only; the old name was removed from `index.html`, `vite.config.js`, and
  `README.md`, and must not be reintroduced anywhere in code or copy.
- **2026-06-20** — `index.html` `lang` corrected from `en` to **`lt`** (the UI is Lithuanian).
- **2026-06-22** — Retroactive description for **remote-ended quick-work sessions** (audit
  #8(a)). A quick-work session ended on another device is auto-logged with a generic title and
  `autoStopped: true` (the worker never saw the naming prompt); that flag was previously written
  but never read. The worker can now describe it after the fact, surfaced both ways: a one-shot
  "prompt on return" modal and a persistent "Aprašyti" banner in `Layout`, sourced from
  `useUndescribedQuickWork` (live `tasks`, so an entry drops out when described **or** when the
  nightly automation archives it — "until archived"). `addQuickWorkDescription` renames BOTH the
  task and its work_session; to make that join reliable the auto-log path now stores a
  `workSessionId` link on the task (the session's own `taskId` is synthetic, so the two were
  otherwise unjoined). Stays within existing Firestore rules (owner update, no approval-field
  flip) — no rules change. Legacy pre-link records fall back to a bounded best-effort session
  lookup. The bold whole-screen session red stays reserved for the ACTIVE state; the reminder is
  a calm card with only a quick-work accent strip.
- **2026-06-22** — **Checklists (sub-tasks) Phase 1** shipped. Stored as a `checklist` array on
  the task document (`{id, text, done, doneBy, doneByName, doneAt, createdAt}`), mirroring the
  `comments[]`/`links[]` pattern — chosen over a subcollection for free reads, single-`updateDoc`
  writes, and rule simplicity. **No `firestore.rules` change needed**: the assigned worker may
  already update their own task as long as it does not flip the manager-only approval fields, and
  a checklist mutation never does. Logic in `src/utils/checklistActions.js`; surfaces: `TaskModal`
  (authoring), `TaskCard` + `TaskTable` (progress badge + `ChecklistModal` to tick/add/delete).
  Manager saves reconcile the checklist via an atomic transaction (three-way merge of
  baseline/authored/live) so a worker's concurrent live ticks/adds are never clobbered.
- **2026-06-22** — **Photo attachments** improved for field use: a direct-camera button
  (`capture="environment"`) beside the gallery picker, a combined upload-progress bar, and
  per-file size shown before upload (`TaskModal`). Client-only; compression already existed
  (`imageUtils.js`). Storage-orphan cleanup + a content-type rule were deliberately **not** done
  here (they touch production data / need a human-run rules deploy) and remain open follow-ups.
- **2026-06-22** — **Resolved the three remaining deferrals** (see [ADR 0004](./adr/0004-notification-infrastructure.md)):
  (a) **FCM background push** — added a `functions/` Cloud Functions codebase as the sender
  (data-only messages on `request_notifications`/`calendar_requests`), client token registration
  (`src/utils/messaging.js`), a dedicated FCM service worker, and an `fcm_tokens/{uid}` owner rule.
  (b) **Badge + toast** — a new `ToastProvider` and a global `NotificationsProvider` (single unread
  source → OS app-icon badge + foreground toast from the live listeners, push-independent).
  (c) **Storage orphan cleanup + content-type rule** — done server-side via Cloud Functions
  (admin SDK deletes objects on attachment removal / true task deletion, with an archive-vs-delete
  sibling guard) plus a tightened `storage.rules` (`image/*`, < 20 MB). **Activation is founder-run**
  (Blaze plan, VAPID key, `firebase deploy --only functions` + rules) — `docs/runbooks/fcm-notifications-deploy.md`.
- **2026-06-22** — **Notification module cross-device hardening** (multi-agent review of the FCM
  stack). Fixes, no architectural change to ADR 0004: (1) **Android-safe local notifications** —
  session/timer alerts used the page `new Notification(...)` constructor, which throws "Illegal
  constructor" on Android Chrome / installed PWAs (silently swallowed → dead on the worker's main
  device). New `src/utils/localNotify.js` routes through a service worker (FCM SW → desktop
  constructor → Workbox SW fallback), with real PNG icons instead of emoji/`favicon.ico`. (2)
  **Token lifecycle** — `registerFcmToken` now re-runs on `visibilitychange` (FCM tokens rotate;
  login-only registration let a rotated token go stale), returns a status; new `removeFcmToken`
  (arrayRemove + `deleteToken`) runs on explicit logout so a handed-over device stops receiving
  the previous user's push (owner-rule requires it BEFORE `signOut`). (3) **Push routing/dedup** —
  FCM SW `notificationclick` honors a per-message `data.link` (deep link to `?tab=`); per-event
  `notifId` tag + `renotify` so distinct alerts (esp. multiple pending calendar requests) no longer
  silently collapse onto one slot. (4) **SW resilience** — pinned FCM SDK bumped 10.8.0 → 10.14.1
  (match bundle) and `importScripts`/init wrapped in try/catch. (5) **Payload hygiene** — comment
  text clamped/whitespace-collapsed (100 ch) before it crosses onto a lockscreen; removed the dead
  `onForegroundMessage` export + corrected the "onMessage foreground" doc/comments (foreground is
  Firestore-listener-sourced by design). (6) **iOS** — InstallPrompt now states push needs the PWA
  installed to Home Screen. **`firestore.rules` change (needs founder deploy):** `request_notifications`
  CREATE was `if isUserActive()` with no shape check, yet each doc triggers a push — now requires a
  string `recipientId`, binds provenance to the caller (`createdBy` OR `userId` == uid, so a user
  can't forge a notification "from" someone else), requires unread, and clamps `commentText` ≤ 2000.
  All four client write-sites satisfy it. Residual (rules can't rate-limit): a per-sender throttle
  belongs in the Cloud Function — open follow-up.
- **2026-06-22** — **Desktop app shell → a single left rail.** On `lg+` (≥1024 px) the bottom
  tab bar and the floating work pill are replaced by one docked left rail (`SideRail`), read
  top→bottom: brand → primary `Sukurti` → grouped destinations (Mano / Komanda /
  Administravimas) → session work-controls → account. This merges the two stacked bottom
  surfaces into one (DESIGN_SYSTEM §9 "prefer merging into one docked surface") and follows the
  desktop convention of an edge rail over a thumb-reach bottom bar. **Phones and tablets keep the
  bottom bar unchanged.** Tab definitions were extracted to a shared `src/config/navTabs.js` so
  the rail and the bottom bar can never drift (§3 "one way to do a thing"). The rail-vs-bottom-bar
  choice is gated by a **JS media query** (`src/hooks/useMediaQuery.js`), *not* CSS, on purpose:
  both navs mount the session timers, whose `useTimerState` starts a `SoundManager` singleton beep
  and an SR live-region announcement, so a CSS-hidden duplicate would double both — exactly one nav
  is mounted at a time. The whole-screen session signature is preserved; on desktop the workspace
  area carries the tint while the rail stays a calm neutral panel.
- **2026-06-22** — **Subtle motion system** — a calm, state-conveying animation layer across the
  app, hand-rolled in `src/index.css` with **no animation dependency** (chosen over installing
  `tailwindcss-animate`, whose vocabulary the code already referenced but which was never
  installed, so `animate-in`/`fade-in`/`zoom-in-95`/`slide-in-*` were dead classes — defining
  them locally revived all of it: toasts, manager notifications, banners, time-limit popups,
  WorkPlanner, the login success message). Adds composable enter utilities + five purpose-built
  effects (`wz-pulse-soft` "alive" breath, `wz-pop` completion pill, `wz-flash-success` card halo,
  `wz-shake` error nudge, `wz-float` empty-state idle). Applied in four layers — signature
  (session change, task completion), feedback (press, modal entry, toast, validation), reveal
  (lists, accordions, status tone), ambient (one low-amplitude loop per region). All
  `transform`/`opacity`/`box-shadow` only (never layout), ease-out-expo (no bounce), 150–300 ms,
  and fully neutralised by the existing `prefers-reduced-motion` guard, so no `motion-safe:`
  prefixes. A Tailwind `duration-*` → `--wz-enter-duration` bridge keeps `animate-in … duration-300`
  honest. Reviewed adversarially (4 lenses × 3 skeptics): one confirmed intent-fidelity issue
  fixed (the bridge), three findings dismissed. Documented in
  [`DESIGN_SYSTEM.md`](./design/DESIGN_SYSTEM.md) §12 + [`tokens.md`](./design/tokens.md) §7.
  No backend/rules impact.
- **2026-06-22** — **Functions migrated to Node 22 + `firebase-functions` 7 (deployed & verified).**
  Node 20 is decommissioned for Cloud Functions **after 2026-10-30**, so `functions/package.json`
  was moved to `engines.node: "22"` and `firebase-functions ^6.1.0 → ^7.2.5`. `firebase-admin` is
  **held at `^13`**: `firebase-functions@7` declares its peer as `firebase-admin ^11.10 || ^12 || ^13`,
  so admin 14 (which itself requires Node ≥22) must wait for a later `firebase-functions` peer bump —
  minor follow-up. Verified locally on Node 22 (clean `npm install`, every `index.js` import target —
  v2 firestore triggers, `setGlobalOptions`, `logger`, admin `getFirestore`/`getMessaging`/`getStorage`
  — resolves on the new majors, `eslint` clean), then deployed and **confirmed via the Firebase API
  that all five functions report runtime `nodejs22`**. NB: deploy from a checkout that has the latest
  `main` — a stale checkout silently deploys old code and reports "Skipped (No changes detected)"; and
  confirm the live runtime via the API/console, not the deploy log. See
  [ADR 0004](./adr/0004-notification-infrastructure.md) and the
  [FCM runbook](./runbooks/fcm-notifications-deploy.md).
- **2026-06-23** — **Modal dismiss policy decoupled; 5 hand-rolled shells canonicalised.** The
  canonical `Modal` gained a `closeOnBackdrop` prop (default `true`, so all existing callers are
  unchanged) that peels backdrop-tap-to-dismiss off the `dismissible` master switch. This unblocks
  the long-deferred modal canonicalisation: a form holding unsaved input can now stay
  `Escape`-dismissible while a stray backdrop tap no longer discards it (`dismissible` +
  `closeOnBackdrop={false}`) — previously impossible, which is why `TaskModal` had hand-rolled its
  own scrim. Migrated onto the shared shell (via `bare` mode, preserving each dialog's exact
  chrome): `TaskModal`, `DeleteConfirmationModal`, and WorkPlanner's three dialogs (Edit Event,
  Reason — both forms, backdrop-no; Approval Feedback — acknowledgement, backdrop-yes). This also
  **removed WorkPlanner's ~45-line hand-rolled a11y effect, which lacked the WCAG 2.4.3 Tab
  focus-trap** — that trap is now present via the shared `useModalA11y`. Net −57 lines. **Deferred
  (with reason):** `DetailsModal` (+ its 5 content viewers) and `ImageModal` — already a11y-correct
  and either already matching the default backdrop behaviour or intentionally full-bleed (the image
  viewer is a black zoom/drag surface, a poor fit for a centred card). Gate: `lint` + `build` only
  (no component tests exist; app not visually QA'd — needs Google auth). Adversarially reviewed
  (4 targets × skeptic verify): one HIGH regression caught and fixed (bare form bodies needed
  `flex-1 min-h-0 overflow-y-auto` so tall content scrolls within the new `max-h-[90vh]` cap instead
  of clipping). Documented in [`DESIGN_SYSTEM.md`](./design/DESIGN_SYSTEM.md) §8. Pre-existing
  WorkPlanner delete-confirm-vs-edit-event z-order issue flagged as a follow-up (not introduced
  here). No backend/rules impact.
