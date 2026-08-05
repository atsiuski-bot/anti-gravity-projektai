# ADR 0027 — The work day (05:00→05:00), not the calendar day, is the filing unit for work time

Status: Accepted · Date: 2026-08-05

## Context

WORKZ has had a **work day** distinct from the calendar day since
[the 05:00 change](../../src/utils/timeUtils.js) (`WORK_DAY_START_HOUR`, moved from 03:00 on
2026-07-26). It governs what a worker SEES: how long a finished task lingers in the personal and
team lists, the Dienos statistika day span, when `archiveFinishedTasks` sweeps.

It did **not** govern where a worker's minutes are FILED. Every writer stamped `work_sessions.date`
and `break_sessions.date` with `getLithuanianDateString(end)` — the pure Vilnius *calendar* day of
the moment the session closed. The two rules disagree for exactly five hours a night, 00:00→05:00,
and that band is when night work actually happens.

The consequence is not cosmetic, because **the day windows are queried by that stored field.**
`DailyStatistics` and `Reports` fetch `where('date', '>=', from)` / `<= to`; the task half of the
same screen is windowed by the 05:00 boundary instants. So for a shift running past midnight:

- the task finished at 01:00 stayed in "today" (the work-day rule),
- while the session that paid for it was filed under **tomorrow** (the calendar rule),
- and tomorrow's window has not opened yet — so the minutes appeared on **no screen the worker
  looks at**. They were credited, they were never lost, but they were invisible until the next day
  turned over, and then they showed up on the wrong day.

Two more instances of the same split were live alongside it. `breakState.dailyAccumulatedMinutes` —
the running "today's break" total — was re-dated with the calendar day, so a break taken at 00:30
zeroed the counter mid-shift. And `DailyWorkProgress` computed its "Šiandien" from the calendar day
while summing rows filed by the same calendar day *but shown against a plan matched with the
device-local day*, so after midnight the card paired one day's plan with another day's hours.

The founder's instruction was direct: the work day should run from 05:00, and work done before that
should sit in the **previous day's log**.

## Alternatives considered

**A. Window the readers by instants instead of by the stored day.** Keep `date` on the calendar day
and have every day view select on `startTime`/`endTime` against the 05:00 boundary instants.
Rejected: the reads are Firestore queries, and the collections' composite indexes
(`firestore.indexes.json`) are built on `date` + the ownership key. This would need new indexes on
every scoped read path, and would still leave the stored field meaning something no screen uses.

**B. Change the stamp; leave history alone.** File new rows by the work day. The stored field then
means one thing, every existing day window keeps working unchanged, and no historical document is
touched. **Chosen.**

**C. Change the stamp and backfill the old rows.** Same as B plus a migration re-stamping every
pre-existing row whose work ended in the night band. Rejected *for now*, not on principle: it is a
bulk write against production, which is a human-only operation under `CLAUDE.md`, and it is
separable — B is correct on its own and C can follow at any time.

## Decision

**One question, one answer: `getWorkDayString(instant)` decides which work day any piece of work
time belongs to** — client side, with `currentWorkDay()` in `functions/workDay.js` as its verbatim
server mirror (locked by `src/__tests__/firebaseConsistency.test.js`).

It is applied at three kinds of site, and deliberately nowhere else:

1. **Filing.** Every writer of a `work_sessions` / `break_sessions` `date`, and every writer of
   `breakState.lastDate` — legacy (`sessionActions`, `taskActions`, `TaskTimerControls`), canonical
   (`timerTransitionPlan`), admin (`sessionEditActions`), and both server nets
   (`autoStopForgottenTimers`, `autoCloseForgottenSessions`).
2. **Bucketing on read.** The day a time record is grouped under when it carries no stored `date`,
   the per-worker distinct-work-days key, the day a task's typed-in `manualMinutes` counts toward,
   and the two report-only integrity scans that measure "how much did one person-day hold".
3. **"Today".** The day the log surfaces open on and compare against — `DailyStatistics`'s selected
   day and its live-session gates, `DailyWorkProgress`, the `Reports` default range, and the shared
   period presets.

`getLithuanianDateString` keeps every other job and is not a legacy alias: it remains correct for
calendar dates a human picks or reads — deadlines, planned shifts in `work_hours`, calendar
requests, recurrence anchors, week ids, date-picker values and bounds — and it is **required** for
anchoring a typed wall-clock time to a day (`vilniusWallClockToISO`), where the work-day rule would
build an instant 24 hours off.

`breakDayBaseMinutes` compares on the work day too. The total and the day it is stamped with are one
pair; splitting them is precisely how that counter once walked across the day boundary unbounded.

## Consequences

- A night shift is **one entry in one day's log**, on every surface, and the task and its minutes
  can no longer land in different days.
- Between midnight and 05:00, "today" on the log surfaces is the day the worker started — the day
  stepper's forward arrow is disabled there, and the report defaults open on it.
- The break counter no longer resets at midnight mid-shift.
- `onWorkSessionBadge`'s distinct-work-days high-water gets *stricter and more correct*: a shift
  spanning midnight now counts as one worked day rather than two.
- **Historical rows keep their old bucket.** Only rows whose work ended 00:00→05:00 are affected,
  and only those already in Firestore. Nothing is lost or double-counted — a given row is in exactly
  one bucket, just possibly the calendar one. This is the accepted cost of alternative B.
- The two report-only integrity scans now weigh a night shift as one person-day, so they detect
  inflation they previously split under the threshold. Report-only: no write, no gate.

## Follow-ups

1. **Decide on the backfill (C).** Re-stamp pre-existing `work_sessions`/`break_sessions` rows whose
   work ended in the night band. Bulk production write ⇒ human-only. Worth measuring the row count
   first; if night work is rare in the history, the split is not worth a migration.
2. **The abandonment heuristic still uses the calendar day.** `secondarySessionAbandoned`
   (`functions/index.js`) and its client mirror `isAbandonedSession`
   (`src/hooks/useOrphanedSessionRecovery.js`) treat "crossed a Vilnius calendar day" as evidence a
   break/call/quick-work was abandoned. Under this ADR that reads wrong for a night worker: at 00:01
   a session started at 23:50 is declared abandoned. The 16h ceiling still catches genuinely
   forgotten ones, so this is a correctness-of-reason issue, not a live loss — but the two rules
   should be one. Left out here deliberately: it changes when sessions are force-closed, which is a
   credit path, and belongs in its own reviewed change.
3. **Date-picker upper bounds stay on the calendar day** (`ReportExportModal`, `TaskHistory`,
   `UserProfileModal`, `DatePicker`'s today marker). They are permissive by one day in the night
   band — you can select a day that holds no work yet — which is harmless. Unify if it ever reads as
   inconsistent.
