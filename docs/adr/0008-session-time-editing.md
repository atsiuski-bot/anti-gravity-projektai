# ADR 0008 — Per-session time editing (admin)

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Supersedes** | The two legacy delta-style time editors (see Decision) |

## Context

An admin needs to correct an already-finished work session's recorded **start and end** times
and see the resulting **total** update as they type — and, more broadly, tidy up logged time
(remove a bogus session, add one a worker forgot to track).

Logged time is stored two ways:

- **Per-session** — `work_sessions` rows (`startTime`, `endTime`, `durationMinutes`, `date`).
- **Per-task** — `timerMinutes` / `manualMinutes` / `timeAdjustments[]` on the task document.

Every report and `DailyStatistics` total is **recomputed live** by summing
`work_sessions.durationMinutes` over a Vilnius work-day window; the per-task fields are
reconciled to avoid double counting (a task that has real sessions contributes through those
sessions, not its `manualMinutes`; an edited task is skipped via `timeChanged`). There are **no
cached cumulative counters**.

Two **delta-style** editors existed: a task-total override in `DailyStatistics` (wrote
`timeChanged*` + a correction `work_sessions` row) and `TimeAdjustmentsModal` (added an
`isManualAdjustment` row). Neither can express a *real* new start/end — they only nudge a
duration — and editing a task total cannot move a specific session's day bucket.

## Decision

- **`work_sessions` is the canonical record of logged time.** The admin edits sessions directly.
- The admin enters only **start + end**; the credited `durationMinutes` (rejecting `end ≤ start`
  and clamping at the 16 h single-session ceiling) and the `date` bucket (the Vilnius day of the
  **end**, matching every other writer) are **derived** and written. Because totals recompute
  live from these two fields, every report self-corrects with **nothing to backfill**.
- **Mutate in place + original snapshot.** An edit overwrites the session's start/end but, on the
  **first** edit only, snapshots `originalStartTime` / `originalEndTime` /
  `originalDurationMinutes` and stamps `edited` / `editedBy` / `editedByName` / `editedAt` /
  `editReason`. The original is never lost; a second edit keeps the first-captured original.
- **Full CRUD.** Edit start/end, **soft-delete** an erroneous session (`isDeleted` — excluded
  from aggregation but kept for audit), and **add a missing session** (synthetic `taskId`,
  `isManualSession: true`).
- **UX.** An admin-only editor (`SessionEditModal`) opens from the day-timeline rows — both the
  individual drill-down timeline and the team-report `WorkerDayDetailModal`. It shows a live
  **Trukmė** and **Bendra suma: A → B** readout and warns when an edit crosses midnight (the
  session moves to another day). An edited row carries a **Redaguota** badge
  (`SessionEditedBadge`) showing original → new + reason. A mandatory reason gates every write.
- **The legacy delta editors are retired.** The `DailyStatistics` task-total pencil is removed;
  `TimeAdjustmentsModal` becomes a **read-only** history. All existing `timeChanged*` /
  `isManualAdjustment` / `timeAdjustments[]` data is **kept and stays visible** (timeline rows,
  reports, the read-only modal), and the double-count reconciliation is **unchanged**.
- **No Firestore rules change.** An admin (`canSeeWholeTeam`) already has create / update / delete
  on `work_sessions` (ADR 0005). The editor is admin-only client-side (`userRole === 'admin'`),
  mirroring the legacy `canEditTime` gate.

Logic: `src/utils/sessionEditActions.js` (+ `vilniusWallClockToISO` in `timeUtils.js`). UI:
`src/components/SessionEditModal.jsx`, `src/components/task/SessionEditedBadge.jsx`, wired into
`src/components/DailyStatistics.jsx`.

## Alternatives considered

- **Append a correction instead of mutating.** Keeps the raw row immutable, but cannot express a
  literal new start/end (the explicit requirement) — the timeline would carry synthetic rows.
  Rejected; the embedded original snapshot preserves auditability without it.
- **Keep editing the per-task total (the legacy delta path).** Cannot move a specific session's
  day bucket and drifts from the session-summed payable figure. Retired.

## Consequences

- Editing a session is **sufficient**: `durationMinutes` + `date` are the only fields the
  aggregators read, so all totals, the combined-hours summary and payroll move automatically.
- Editing a historical **start** time can retroactively shift server-awarded "on-time start"
  recognition — correct (it reflects reality), but real.
- Breaks and the legacy synthetic `isManualAdjustment` rows are **out of scope** for the editor
  (shown read-only; not editable here).

## Follow-ups

- Optionally extend the editor to `break_sessions`.
- Optional **overlap warning** when an edit makes a user's sessions overlap (a sum double-counts
  the overlap).
- Optional unit tests for `vilniusWallClockToISO` / `deriveSessionFields` (vitest; needs a local
  `npm install` in a fresh worktree).
