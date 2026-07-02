# 00 — SYNTHESIS — full sweep 2026-07-02 (timer-trust lens)

**Headline:** the timer's trust architecture is fundamentally sound — offline-durable writes,
wall-clock-derived elapsed, layered recovery (boot + heartbeat + gap-credit + server net),
and the adversarial audit refuted 29/30 timer attack claims with evidence. **Two real
time-integrity defects were confirmed** (both fixable in one small change each), plus one UI
convention bug and a docs-drift cluster.

Deterministic gates: lint ✅ 0/0 · build ✅ (PWA ok) · vitest ✅ 745/745 · deps ✅ (accepted
residual) · functions lint ✅ · firebase live diff ⚠️ **BLOCKED — auth token expired**.

## 🔴 Fix first (time integrity — the product promise)

| # | Finding | Where | Effort | Evidence |
|---|---|---|---|---|
| 1 | **Interrupted BREAK loses all pre-interruption time.** Partial-banking covers only quickWork/call; restore resets `startTime` to "now"; the lost stretch lands nowhere. Real-money bug (under-recorded break ⇒ inflated payable total). Fix also closes the nested-chain drop (see 3). | `sessionActions.js:97, 285-291, 320-322` | **S-M** + unit test | skeptic 1/1 + hand-read |
| 2 | **`resumeTask` TOCTOU** — supersede check runs outside the lock; a worker starting a secondary session during `doResume`'s server read gets it silently overwritten (never logged, unrecoverable). Fix: re-validate `activeSession` *inside* the locked section. | `taskActions.js:260-277` + `sessionActions.js:400-443` | **S** + test | skeptics 3/3 |

## 🟠 Should fix

| # | Finding | Where | Effort |
|---|---|---|---|
| 3 | Abandoned-session finalization drops nested `pausedSession` chain (break time lost via #1; task auto-resume pointer lost) — largely folds into #1's fix | `sessionActions.js:315-316` | folds into #1 |
| 4 | Native `<input type="date">` in the deadline field (banned; English calendar chrome) → migrate to canonical `DatePicker` | `TaskModal.jsx:1577-1596` | S |
| 5 | **Firebase live-state verification blocked** — CLI+MCP token expired; several deploys recorded as PENDING (rules userId-pin/overseesUser, recurrence interval, badge thresholds, VERY_LOW retirement) cannot be confirmed live | founder: `firebase login --reauth` | one founder step |
| 6 | Docs-drift cluster: CLAUDE.md/AGENTS.md say "WORKZ is the only name" (product now brands **Gildija**); README/CLAUDE.md say "Hosting: Netlify" (primary is Cloudflare Pages); docs/README calls tokens "proposed" (wired); DEPLOY_FIRESTORE_RULES overclaims `deleted_tasks` lock | docs | S (one pass) |

## 🟡 Nice to fix / follow-ups

- **Dead code sweep:** 5 orphan components/hooks (`DailyHoursSummary`, `MonthlyHours`,
  `InlineEditModal`, `TaskAnomalyBadge`, `useFrequentQuickWork`; grep-verified 0 importers)
  + 5 dead exports. Removing `DailyHoursSummary` also removes a flagged 3-listener leak.
- **Unverified remainder** (skeptics lost to session limit): TaskCard/TaskTable keyboard
  access, `useManagerData` unbounded listener, TaskHistory export N+1, CallTimer color-token
  drift, raw Storage error message, 3 small docs items. Re-verify cheaply next sweep or via
  `/debug` when touching those files.
- **Coverage gaps:** timer *hooks* (heartbeat/recovery wiring) and Cloud Functions have no
  test harness; rules have no emulator tests. The #1/#2 fixes should land with unit tests in
  the already-tested utils layer.
- **Watch:** Firebase SDK 10.14 (2 majors behind); optimistic-state hold-forever on a
  permanently rejected write (low; AuthContext reconciliation).

## In flight elsewhere (do not duplicate)

- Separate spawned session: **"Fix gap double-credit when limit pause pre-empts recovery"**
  (task_192e8fc0) — same timer-trust family, already being fixed.

## Sweep integrity notes

- Verify fan-out was hit by an account session limit (resets 16:30 Vilnius): timer sweep lost
  13 verifier agents; triage sweep lost ~75 → ~25 triage findings UNVERIFIED, of which the
  main agent hand-verified the 8 highest-stakes (3 index claims, secret-leak claim and both
  "Gildija" claims **rejected**; 5 orphan components and 3 docs drifts **confirmed**).
- Reasoning cost (measured): timer sweep ~6.07 M subagent tokens (96 agents); triage sweep
  ~2.32 M (122 agents; find 632 k / verify 190 k output). Total ≈ 8.4 M subagent tokens.
- The sweep changed nothing outside `docs/audits/full-sweep-2026-07-02/`.
