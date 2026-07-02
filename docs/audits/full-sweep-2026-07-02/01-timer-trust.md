# 01 — Timer-trust lens (custom reasoning sweep)

**Question audited:** can the timer break, lie, or lose time under bad connectivity, phone
sleep, PWA kill, clock skew, or races — and is sync invisible to the worker?

**Method:** 6 specialized read-only finders (offline-sync, device-lifecycle,
race-double-credit, clock-skew, recovery-paths, trust-ux) → 32 findings → 3 adversarial
skeptics each (majority rules). 96 agents. The verify stage for `trust-ux` (3 findings) and
1 `recovery-paths` finding was cut short by a session limit — those are **UNVERIFIED**, not
rejected; the main agent hand-checked them (below).

## Verdict in one line

**The timer's architectural foundation held up under adversarial attack: 29 of 30 verified
claims were refuted with evidence. One real race survived, plus one corollary confirmed by
hand.**

## ✅ Confirmed findings

### 1. 🔴→🟠 `resumeTask` TOCTOU can overwrite a just-started secondary session (3/3)

[taskActions.js:260-277](../../../src/utils/taskActions.js) + [sessionActions.js:400-443](../../../src/utils/sessionActions.js)

`resumeTaskImpl` unconditionally overwrites `users/{uid}.activeSession` (and force-clears
break/call/quickWork flags) inside its `withUserLock` section **without re-reading state
inside the lock**. The `doResume` supersede safeguard runs OUTSIDE the lock: its server-first
read is a network round-trip, during which a worker tap can let `startSession` win the lock —
the safeguard then passes on stale state and the queued `resumeTask` silently clobbers the
fresh secondary session (which was never logged anywhere — unrecoverable).

- Window: the safeguard's server round-trip (hundreds of ms; seconds on field connections),
  on a routine flow (end break → immediately start call/quick-work).
- Impact: a seconds-old session wiped + its minutes misattributed to the resumed task;
  session color flips visibly. Realistic severity **medium-high**, not hours lost.
- Fix direction: re-validate `activeSession` inside `resumeTask`'s locked section (or pass
  the supersede check into the locked impl). The code's own comments state the intent is
  zero-overwrite — this is an incomplete mitigation, not a design choice.

### 2. 🟠 Corollary (hand-verified): abandoned-session finalization drops the nested `pausedSession` chain

[sessionActions.js:315-316](../../../src/utils/sessionActions.js) — when
`useOrphanedSessionRecovery` finalizes an abandoned secondary session it calls `endSession`
with `skipResume=true`, which sets `activeSession = null`, discarding any nested
`pausedSession`. For a nested **task**: only the auto-resume pointer is lost (its time was
already banked by `pauseTask`; the task shows paused). For a nested **break**: its
pre-interruption time is lost — same root cause as the confirmed break-banking bug in
[00-reasoning-confirmed.md](./00-reasoning-confirmed.md) finding #1.

## ⚪ Unverified by skeptics (session limit) — hand-checked by the main agent

| Claim | Hand verdict |
|---|---|
| Timer display blank on fast reload (`TaskTimerControls.jsx:44`) | **Reject.** Display recomputes synchronously on mount from the task doc; Firestore persistent cache serves the first snapshot from disk, so there is no "blank until network" window. |
| Optimistic UI "reverts silently" (`AuthContext.jsx:315`) | **Reject as stated** — the reconciliation *holds* optimistic state until the DB matches (never auto-reverts). Residual watch item: a permanently *rejected* write could hold optimistic state until the next action. Low. |
| Session shell color desyncs after orphan recovery | **Weak.** Color derives from the same `activeSession` snapshot the recovery writes; only a transient snapshot-lag window exists. Low. |
| Task deletion race losing timer state (`taskActions.js:403`) | **Reject.** Cited line is `saveTaskTemplate`; the claim is mislocated and speculative. |

## 🛡️ Defenses that held (positive assurance, from finder + skeptic reads)

- **Phone sleep / OS kill loses no time.** Elapsed is always a wall-clock delta from the
  Firestore-persisted `startTime` — never a tick accumulator. A frozen interval recomputes
  correctly on the first tick after wake. No lifecycle-save handler is needed because state
  is durable at session *start*.
- **Offline writes cannot be lost to the network.** `persistentLocalCache`
  ([firebase.js:33-34](../../../src/firebase.js)) queues every write durably; recovery paths
  work offline too (local-first apply, background sync).
- **Boot recovery resumes, not kills.** A pre-boot same-day <16 h session is left running
  (time recomputed from persisted start); only day-crossing / >16 h sessions are finalized —
  credited to the **last heartbeat**, not the reopen instant, with a worker-facing
  RecoveryNotice (incl. "16 val. apribojimas" wording when capped).
- **The 16 h clamp is not silent** — `wasCapped` flows into the notice; manager-side
  anomaly flags (`isImplausibleSessionMinutes`) mark implausible rows in reports.
- **Disabled account mid-shift** — live user-doc listener signs out within seconds; the
  Admin-SDK server function (`autoStopForgottenTimers`) reconciles regardless of rules.
- **Rapid toggles / double-tap** — per-user `withUserLock` + `actionInFlightRef` +
  `pauseInFlight` dedup; two-device writes bounded by server-first reads + lock ordering.
- **Backward clock** — negative deltas clamped to 0 before any permanent write.

## Known gap being fixed elsewhere

A separate session is already working on **"gap double-credit when limit pause pre-empts
recovery"** (spawned task) — not re-reported here to avoid duplication.

## Cost (measured)

96 agents, ~6.07 M subagent tokens, ~20 min wall clock. 13 verifier agents lost to the
session limit (trust-ux ×9, recovery-paths ×4).
