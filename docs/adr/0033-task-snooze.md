# ADR 0033 — Task snooze ("Atidėti iki"): a visibility state, not a lifecycle state

- **Date:** 2026-10-21
- **Status:** Accepted
- **Deciders:** founder (scope + four product choices, 2026-10-21), agent (design)

## Context

A worker sometimes cannot finish a task for a reason outside their control (materials, the client,
the weather) and wants it out of the way until a known day — "make it reappear on Monday". The only
existing tool was the recurring templates, which do not fit a one-off task. The founder asked for a
Gmail-like flow: swipe a card to snooze it, pick when it comes back from a pop-up.

## Alternatives

1. **Move the deadline.** The task stays in the list (nothing is cleared) and the original deadline
   is lost, which corrupts the "when was this actually due" record.
2. **A "blocked / waiting" status with no date.** Comes back only when someone remembers — the
   existing "Laukiama" flag already covers that signal.
3. **Hide until an instant (chosen).** The task leaves the active list and returns on its own.

## Decision

- Snooze is a **visibility** state carried in plain task fields (`snoozedUntil`, `snoozedBy`,
  `snoozedByName`, `snoozedAt`, `snoozeReason`, `snoozeWakePending`). Status, priority, deadline and
  credited time are untouched, so reports, pay and the approval gates never see it.
- "Snoozed" is **derived from the clock at read time** (`snoozedUntil > now`, never while running),
  so a task returns on time with no job involved. `useSnoozeSplit` re-splits the list at the soonest
  return instant.
- Parked tasks **never vanish**: they collect in a collapsed "Atidėta (N)" section under every task
  list (worker, manager "Mano darbai", manager team list), showing the return time, the optional
  reason and — when someone else parked it — who did.
- Founder choices (2026-10-21):
  1. Hidden from the active list for everyone; the manager sees it in "Atidėta" and can bring it
     back ("Grąžinti dabar").
  2. Reason is optional, from four chips.
  3. A push to the assignee when the task returns — the `wakeSnoozedTasks` sweep (every 15 min)
     sends `task_snooze_ended` once per snooze and disarms `snoozeWakePending`.
  4. A return after the deadline is warned about ("Po termino"), not blocked.
- **Entry points:** swipe left on the mobile card (a shortcut only), and an "Atidėti" button in the
  task detail sheet (the non-gesture path, WCAG 2.5.1). One tap on a preset commits; the toast's
  "Atšaukti" undoes it. Presets return at 07:00 Vilnius: next work day, next Monday, in a week, or a
  picked date.
- **Not snoozable:** running, unapproved, finished, quick-work and call tasks.
- **Swipe right = finish was declined for now:** finishing stops paid time and starts the hand-in
  flow; a one-gesture finish outdoors is too costly when mis-triggered.

## Consequences

- No rules change is needed for the snooze writes (no field allow-list on `tasks`; none of the
  fields is an approval field). The new server-only notification type is added to the
  `request_notifications` deny-list — a **rules deploy post-ship** (hygiene: until then a client
  could forge a harmless "returned" FYI).
- **Functions deploy post-ship** for `wakeSnoozedTasks` and the `task_snooze_ended` push copy. Until
  it runs, snooze works fully; only the push is missing.

## Follow-ups

- Swipe right = finish, if the founder wants it after watching snooze in use.
- A "Kol grąžinsiu" (no date) option, if real use shows the need.
