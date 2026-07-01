---
description: Read-only forensics for a "disappeared work time after a reload/crash" report via the Firebase MCP. Pulls the affected workers' users doc (leftover activeSession / heartbeat), their sessions + work_sessions for a given date, and any writeFail/pauseFail error_logs — then reports whether each stretch was logged, clamped, or lost, and to which recovery path it maps. Pure inspection: makes NO writes and triggers NO deploy. Use to pin the cause of a lost-time complaint before touching any code.
argument-hint: [YYYY-MM-DD] [workerName ...]
allowed-tools: mcp__firebase__firestore_query_collection, mcp__firebase__firestore_list_documents, mcp__firebase__firestore_get_document, mcp__firebase__functions_get_logs, Read, Grep, Glob
---

# /lost-time-triage — why did a session's time disappear? (read-only)

Pin the cause of a "app skaičiavo, tada persikrovė ir dingo laikas" complaint entirely through
the Firebase MCP — no console snippets, no keys, no writes, no deploy. Every tool here is
read-only and pre-approved in `.claude/settings.json`.

Default target if no args: **date `2026-07-01`**, workers **Giedrius** and **Kastytis**
(the 2026-07-01 report: Giedrius 11:43–13:45 "Woolų darymas"; Kastytis 12:50–13:43 "fontanų
darymas"). Override by passing a date and one or more display-name fragments.

## Why this exists

The static code path proves BOTH reload-recovery routes credit a same-day, sub-16h session
correctly: the heartbeat is stamped at session start and every minute
(`src/hooks/useSessionHeartbeat.js`), and a finalize with no valid beat falls back to
end-at-now (`src/utils/sessionActions.js` `endSessionImpl`). So a 2-hour same-day session
should never credit zero from recovery alone. That leaves one class of cause — the persisted
session state (`activeSession` + legacy per-type flags) was **lost or overwritten** during the
crash, so `endSession` (the only place time is logged) never ran. That is invisible in code and
only provable from live data. This command gets that data.

## Steps

Resolve the target date (arg 1, else `2026-07-01`) and worker name fragments (remaining args,
else `Giedrius`, `Kastytis`). Then, for context, first map each name → `uid`:

1. **Identify the workers.** `firestore_query_collection` on `users` — pull the docs whose
   `displayName` matches each fragment. Record `uid`, `displayName`, and CRUCIALLY the current
   `activeSession`, `activeSessionLastHeartbeat`, `breakState`, `callState`, `quickWorkState`,
   `workStatus`. A leftover non-null `activeSession` or per-type `isX===true` flag whose
   `startTime`/`lastStartedAt` is on the target date = a **pending/abandoned session that was
   never finalized** (the "shows inactive but was really working" smell if the UI stopped
   rendering it).

2. **Was the stretch logged at all?** `firestore_query_collection` on `sessions` AND on
   `work_sessions` filtered `date == <target>` (and, if the SDK allows, `userId == <uid>`).
   For each worker, list every segment with `startTime`, `endTime`, `durationMinutes`, `type`.
   Compare against the reported wall-clock window:
   - **Segment present, full duration** → time WAS credited; the complaint is a display/reporting
     issue, not lost data. Check which tab/collection the worker was looking at.
   - **Segment present but clamped short** (endTime ≈ a mid-window heartbeat, duration << window)
     → finalize credited to a stale beat. Note the beat instant.
   - **No segment at all** → the session was never logged: `endSession` did not run for it →
     state was lost/overwritten. This is the silent-loss case.

3. **Did a write fail?** `firestore_query_collection` on `error_logs` for the target date (and
   the workers' `userId` if present on the doc), especially `source` starting `writeFail:` or
   `pauseFail:` (e.g. `writeFail:endSession.sessionLog`, `writeFail:endSession.legacyLog`,
   `pauseFail:startSession.taskPause`, `startSession`, `orphanRecovery:endSession`). A hit here
   names the exact failed write and closes the case.

4. **Cross-check the server net.** `functions_get_logs` for `autoCloseForgottenSessions` and
   `autoStopForgottenTimers` around the target date — did the daily net later close a leftover
   session, and with how much credited?

## Output

A short per-worker verdict:

- **Worker** — displayName + uid, and the current leftover state (activeSession / flags / last
  heartbeat) with its date.
- **Logged?** — for each reported window: `CREDITED FULL` / `CLAMPED to <beat>` / `NOT LOGGED`,
  with the concrete `sessions`/`work_sessions` doc (or its absence).
- **Error trail** — any `writeFail:`/`pauseFail:` error_logs hit, quoted `source` + message.
- **Server net** — whether `autoCloseForgottenSessions`/`autoStopForgottenTimers` touched it.
- **Cause** — one line mapping the evidence to a path: *reporting/display only* /
  *finalize-clamped-to-stale-beat* / *state lost, never logged* / *write failure (named)*.
- **Fix proposal** — the smallest targeted code change that the evidence (not speculation)
  justifies, plus whether the two records still need in-app backdate restoration.

**This command writes nothing and deploys nothing.** Restoring the affected time is a separate,
human/in-app action (worker self-backdate ≤7d via the app, or an admin on their behalf).
