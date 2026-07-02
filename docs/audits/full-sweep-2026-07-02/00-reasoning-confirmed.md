# 00 — Reasoning track (triage-sweep, 11 dimensions)

**Method:** 11 read-only finders → 37 findings (0 dup) → 3 skeptics each. **The verify stage
was partially crippled by a session limit** (resets 16:30 Vilnius): 2 findings fully
confirmed, 2 genuinely rejected (3 skeptic reads each), and **~25 findings went UNVERIFIED**
(all skeptics died). The main agent hand-verified the highest-stakes unverified items below;
the rest are listed for a cheap follow-up pass.

Cost (measured): find ~632 k + verify ~190 k ≈ **822 k output tokens**, 122 agents.

## ✅ Confirmed by skeptics

### 1. 🔴 Interrupting an active BREAK silently drops its pre-interruption elapsed time (1/1 + hand-confirmed)

[sessionActions.js:97](../../../src/utils/sessionActions.js) banks a partial `work_sessions`
segment only for `quickWork`/`call` — never `break`. An interrupted break nests into
`pausedSession` with nothing written; on restore,
[sessionActions.js:290](../../../src/utils/sessionActions.js) resets `startTime` to the
resume instant (its comment — "already logged in startSession" — is **false for breaks**),
and the final end computes duration from the reset start
([line 322](../../../src/utils/sessionActions.js) adds only that to
`dailyAccumulatedMinutes`).

**Scenario:** break 11:00 → call at 11:20 → call ends 11:25 → break ends 11:35 ⇒ only 10 min
of break recorded; 11:00-11:20 vanishes everywhere. Breaks are subtracted from payable time,
so under-recording a break **inflates** the payable total — a real-money integrity bug in
both directions of trust. Reachable by design (CallTimer/QuickWorkTimer explicitly allow
starting during a break). The existing nesting test asserts shape only, not elapsed survival.

**Fix direction:** bank a break partial exactly like quickWork/call (or fold the elapsed
into `dailyAccumulatedMinutes` at interruption time). Also closes the nested-chain corollary
in [01-timer-trust.md](./01-timer-trust.md) #2.

### 2. 🟠 Task deadline field uses banned native `<input type="date">` (3/3)

[TaskModal.jsx:1577-1596](../../../src/components/TaskModal.jsx) — the sole remaining native
date input; DESIGN_SYSTEM §8 bans it (calendar chrome renders in the browser's UI language,
not Lithuanian). The canonical `DatePicker` satisfies the same one-click UX. Introduced one
day after the ban with no documented exception; 12 other files already migrated.

## ❌ Rejected by skeptics (3 reads each)

- `window.alert` in `migrateDB.js` — not reachable from UI flows.
- Hand-rolled anchored dialog in `TaskHistory.jsx` — deliberate/acceptable variant.

## 🔎 Unverified by skeptics → hand-verified by the main agent

| # | Claim | Hand verdict |
|---|---|---|
| 1 | 3 compound queries missing composite indexes (`request_notifications` recipientId+isRead; `tasks` assignedUserId+timerStatus; `work_sessions` userId+taskTitle) | **Reject all 3 — false positives.** All are equality-only compound queries, which Firestore serves by merging single-field indexes; no composite index is required (composites are for equality+orderBy/range/array-contains — exactly what the 12 entries in `firestore.indexes.json` cover). These queries run in production daily. |
| 2 | Firebase config hardcoded fallback in `src/firebase.js` is a secret leak | **Reject.** Web `apiKey`/`projectId`/`appId` are public client config by design (CLAUDE.md states this explicitly). |
| 3 | "Gildija" is a retired brand reintroduced (index.html, vite.config.js) | **Reject — finder misread which brand is retired.** *Viduramžiai.LT* is retired; **Gildija is the current deliberate brand** (`2954c6e`). BUT this exposes real docs drift → #4. |
| 4 | *(new, from #3)* CLAUDE.md/AGENTS.md still say "WORKZ is the only name" while the shipped product brands as **Gildija** | **Confirm — docs drift.** Agents reading CLAUDE.md will "fix" Gildija back to WORKZ. Update the naming section. |
| 5 | Orphan components: `DailyHoursSummary`, `MonthlyHours`, `InlineEditModal`, `TaskAnomalyBadge`, `useFrequentQuickWork` | **Confirm — 0 importers each (grep-verified).** Note: the perf finding against `DailyHoursSummary` (3 unscoped collection listeners) is thereby moot — dead code, not a live leak. |
| 6 | README.md:7 "Hosting: Netlify" vs actual primary host Cloudflare Pages | **Confirm — drift** (CLAUDE.md too). |
| 7 | docs/README.md calls the tailwind token block "proposed" | **Confirm — drift** (config is wired). |
| 8 | DEPLOY_FIRESTORE_RULES.md claims `deleted_tasks` fully locked | **Partially confirm** — write is `false` but read is allowed (`firestore.rules:459-461`). |

## ⚪ Remaining unverified (cheap re-verify or next sweep)

- **ux-a11y:** clickable `<div>` without role/keyboard in `TaskCard.jsx:333-345` and
  `TaskTable.jsx:470-474` (plausible — recurring pattern class).
- **perf:** `useManagerData` tasks listener with no `limit()`; TaskHistory export N+1 reads;
  duplicate WorkerView listeners; `reportData` per-worker `getDoc`.
- **crashsafety:** abandoned-secondary finalization drops nested chain — *superseded by the
  hand-verified corollary in 01-timer-trust.md #2.*
- **session-color:** CallTimer desktop border/ring drift from SESSION_COLORS (low).
- **i18n:** raw Storage `error.message` in a rejected Error (`TaskModal.jsx:832`) (low).
- **docsdrift:** fcm-notifications-deploy.md trigger count; visual-qa runbook port;
  DESIGN_SYSTEM stale "Fix required" item.
- **deadcode (low):** dead exports `updateChecklistItem`, `NOTIFICATION_CATEGORY`,
  `UI_COLORS`, `deriveConfirmation`, `teamScopeConstraint`; known orphan rules entries.
