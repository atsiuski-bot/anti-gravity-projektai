# ADR 0016 — Resume backgrounded secondary sessions; bound abandoned ones server-side

- **Date:** 2026-06-24
- **Status:** Accepted (client live on merge; server net awaits a `functions` deploy)
- **Supersedes:** the "finalize every pre-boot secondary session on boot" behaviour introduced
  alongside the orphan-recovery hook (ADR 0011 / 0013 era).

## Context

A **secondary session** is quick-work (`quickWork`), call (`call`), or break (`break`) — the
red/blue/amber whole-screen timers a worker starts and stops by hand. Workers reported that these
timers get **"finished" on their own** when the phone screen turns off, the app is minimised, or it
is closed and reopened.

The time itself is **server-anchored**: the start instant is persisted to `users/{uid}.activeSession`
and the displayed/credited elapsed is a pure `now − startTime` (clamped to the 16h
`MAX_SESSION_MINUTES`). There is no client-accumulated counter, so backgrounding loses nothing. The
actual cause is the **boot orphan-recovery** hook (`useOrphanedSessionRecovery`): it captured
`APP_LOAD_TIME` at module load and **finalised any session whose `startTime` predated this boot**.
On mobile the OS discards a backgrounded PWA within minutes, so reopening is a *fresh load* with a
new `APP_LOAD_TIME` — and the still-running session, started before it, was force-closed. The blunt
"predates this boot = orphan" test could not tell a field worker who pocketed the phone (still
working) from a genuinely abandoned timer.

The hook exists for a real reason: the catastrophic early "190-day break" was a timer left running
with no bound, crediting the whole offline gap. Today a 16h clamp bounds magnitude, and a server
scan (`autoStopForgottenTimers`) reconciles **task** timers — but **nothing** bounds an abandoned
**secondary** session except this hook.

## Decision

**1. Resume, don't finalise, a still-legitimate reopened session (client).** The orphan-recovery
hook now finalises a pre-boot secondary session **only when it is genuinely abandoned** — a new pure,
unit-tested `isAbandonedSession(start, now)`: it **crossed a Vilnius calendar day** OR its elapsed
**exceeds the 16h ceiling**. Otherwise it is *resumed* — the hook returns without touching
`activeSession`, and the live timer simply keeps counting from the persisted `startTime`. The 16h
abandonment bound is the same value `clampSessionMinutes` enforces on credited time, so the
resume window and the write clamp agree on where "real session" ends and "ghost time" begins. This
applies to **all three** secondary types (the founder chose to treat break like the others).

**2. Bound the "never reopens" case server-side, by *logging* not discarding (Cloud Function).**
A worker who never reopens would otherwise leave a session hanging forever, since the client closer
only runs at boot. New `autoCloseForgottenSessions()`, folded into the daily `dailyIntegrityScan`,
scans every user for an abandoned secondary session (same `isAbandonedSession` test, mirrored as
`secondarySessionAbandoned`), **credits the clamped elapsed as a real record** (mirroring the client
`handleLegacyLogging` shapes — `break_sessions` for a break; `tasks` + `work_sessions` for a call /
quick-work), clears the live flags, and audits under the ADR-0015 **system** actor
(`integrity.autoCloseSession`). Deterministic record ids + `create()` make a re-fired scan
idempotent. Data continuity in the work-hour records is the whole point — time is **never discarded**.

**3. Let a manager clear an obvious ghost earlier (client).** `ActiveWorkSessions` flagged a live
session "galimai pasenusi" + offered a force-end only past 16h. A break or call is never legitimately
multi-hour, and clearing one loses no real work (a break is non-work; a multi-hour "call" has no
plausible real time), so those now flag at **4h** (`SHORT_SESSION_STALE_MINUTES`). Quick-work and
tasks keep the **16h** mark — a manager must not be nudged to discard a genuinely long run.

## Alternatives considered

- **Keep finalising on every reopen.** The status quo; it is exactly the bug.
- **Resume quick-work/call but keep auto-closing break.** Safer for the manager live-credit panels
  (`DailyStatistics`/`CombinedHoursSummary` live-credit a running break), but the worker asked for
  all three, and a forgotten break is no worse in the persisted layer than today (today it persists
  the same clamped span on reopen). Rejected in favour of treating break uniformly + the 4h manager
  affordance + the server net.
- **A liveness heartbeat** (periodic `lastActiveAt` write) to distinguish "pocketed phone, still
  working" from "abandoned". More precise, but adds Firestore write volume and complexity; the
  day-boundary + 16h envelope is sufficient and free. Left as a future option.

## Consequences

- A field worker keeps their timer through screen-off / app-kill / reopen — the reported bug is gone.
- The persisted-record layer is unchanged: a resumed session writes **no** record until it is
  explicitly stopped or closed (by reopen-finalise, or the server net), so no report double-counts.
  Logged `date` is still the **stop** day (existing behaviour); a cross-day session is force-closed.
- A genuinely forgotten same-day session shows its live elapsed on the manager dashboard until closed
  (accepted trade-off); the 4h force-end + the server net bound it.
- A continuously-open app across midnight is closed by the **server net** (the client hook only fires
  at boot), keeping client and server on one abandonment definition.

## Review hardening (adversarial pass)

A multi-lens review of the diff confirmed full client↔server record parity and idempotency, and
caught three issues, all fixed:

- **Latch the boot decision.** The resume path returned without setting `handledRef`, so the
  always-mounted effect could re-decide on a later snapshot and finalize a still-live session when
  the wall clock crossed Vilnius midnight (or 16h) with the app open. Fixed by latching the one
  pre-boot decision before the resume/finalize split.
- **Shared deterministic record ids (no double-credit).** Two independent closers — the client on
  reopen and the server net — could each write a random-id record for the *same* abandoned session,
  crediting the time twice. Both now write under one id pinned to (kind + uid + session start)
  (`sess_break_…` / `sess_call_…` / `sess_qw_…`), so the second writer dedups (`setDoc` client /
  `create()` server). The prefixes are locked across the two runtimes by `firebaseConsistency.test.js`.
- **Break-only manager threshold.** The 4h force-end window was narrowed to break only; call,
  quick-work, and task keep the 16h ceiling — force-end *discards* time, and a call/quick-work is
  real work that the server net should *credit*, not have a manager throw away early. The server net
  also no longer bumps the display-only `breakState.dailyAccumulatedMinutes` (wiped client-side on a
  new day anyway; the durable `break_sessions` row is the truth).

## Follow-ups

- **Founder-run:** `firebase deploy --only functions` (post-merge, from an up-to-date `main` checkout)
  to activate `autoCloseForgottenSessions`; then re-verify live via the Firebase MCP. **No rules or
  index change** (the function uses the Admin SDK; all written collections already have rule blocks;
  `firebaseConsistency` gate green). Until deployed, the client resume + 16h clamp + next-reopen close
  still bound everything; only the "never reopens" case waits on the deploy.
- Possible later: route the manager force-end for a secondary session through the same server logging
  close (so it credits instead of discarding), which would let the 4h threshold drop further safely.
