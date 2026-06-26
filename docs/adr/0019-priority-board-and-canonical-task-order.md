# ADR 0019 — Priority board (drag-and-drop) + one canonical task order

- **Date:** 2026-06-26
- **Status:** Accepted (client-only; no deploy)

## Context

Two unrelated problems were entangled in how tasks are ordered:

1. **No single order.** The worker active list used a fixed comparator (`sortWorkerTasks`:
   completed-last → priority → deadline → createdAt-desc), while the manager team list defaulted to
   raw Firestore order (`useTaskFiltering` `sortBy: 'none'`) and only sorted by priority when a
   manager explicitly picked it. The same task could appear in a different position on every surface.

2. **No shared manual ordering.** Manual reordering existed only as a *personal* device of the
   manager team list — `user_settings/{uid}.manualTaskOrder` (a flat id array) applied behind the
   `'Rankiniu būdu'` sort, surfaced as ↑/↓ arrows on the card/table. It followed one user, not the work.

The founder asked for a **desktop priority board**: the team task list, on a toggle, becomes four
columns split by priority; dragging a card **between** columns changes its priority, dragging
**within** a column reorders it — and that arrangement, plus one canonical sort, must hold
**everywhere** (worker + manager, mobile + desktop).

## Decision

**A. One canonical comparator, used everywhere.** `compareTasksCanonical` (in `utils/taskUtils.js`)
is now the single order, each key breaking only the previous tie:

0. finished (completed) last · 1. **priority** desc · 2. **manual `boardRank`** within the priority ·
3. **deadline** asc (none last) · 4. **completion** desc · 5. **createdAt** asc.

Completion is **time progress** (`spent / estimated`, the card's existing glance signal); no estimate
or no spent time ⇒ 0. `sortWorkerTasks` now delegates to it (so worker + personal lists adopt it),
and it is the manager team list's **default** (`sortBy: 'none'`) — except while a free-text search is
active, where best-match relevance still wins. The other manager sort overrides (by user, deadline,
tag…) stay as opt-in.

**B. Shared manual order lives on the task** (`boardRank`, a per-task integer). It is compared only
*within* a priority (priority is the higher key), so reusing the same integers across columns is fine.
"**Freeze the column**" semantics fall out of the comparator: a card *with* a rank sorts above one
*without*, so the first drag writes sequential ranks to the whole column and it thereafter follows the
manual order; an untouched column stays fully automatic; a newly-arrived (rank-less) card lands at the
bottom. Because the rank is on the task, **every** surface reads the same arrangement.

**C. The board is desktop-only and lazy.** `components/board/PriorityBoard.jsx` renders four columns
(Skubus / Aukštas / Vidutinis / Žemas) using **@dnd-kit** — chosen over native HTML5 DnD because the
design system mandates keyboard operability (its `KeyboardSensor` gives Space-pick-up / arrows /
Space-drop). It **reuses the mobile `TaskCard`** with a left **drag handle** (the only draggable
element, so the card body stays tap-/button-interactive). It is `React.lazy`-loaded, so @dnd-kit
enters the bundle only when a manager turns the board on.

**D. Drag writes** go through `utils/boardOrder.js`: a **cross-column** drop is an *audited*
reprioritize (`reprioritizeTask`, `humanActor` commit — finally wiring an ADR-0015 command into the
UI) followed by a `boardRank` batch on the target column; a **within-column** drop is just a
`boardRank` batch. Optimistic local state drives the drag; the Firestore snapshot reconciles it.

**E. The toggle persists per user** on the user doc (`teamBoardView`), read live from
`userData` (Firestore latency-compensates the flip). It is desktop-only twice over: the toggle lives
in the `md+` toolbar, and the board only renders when `viewMode === 'desktop'` (the 768 px gate).

**F. The personal manual-order mechanism is retired** — `user_settings.manualTaskOrder` +
`saveManualOrder` + the `'Rankiniu būdu'` sort option + the ↑/↓ reorder controls on `TaskCard`/
`TaskTable`. A single shared order and a per-user one cannot both be "the" order; the board is now the
only place a manual arrangement is created.

## Alternatives considered

- **Per-user manual order (keep the old model).** Rejected: the founder's requirement is one order
  *everywhere, including worker lists* — a personal arrangement can't satisfy that.
- **Native HTML5 drag-and-drop (no dependency).** Rejected: no keyboard support and poor a11y, which
  would violate the design system's keyboard/focus requirements.
- **A bespoke board card.** Rejected: the mobile `TaskCard` is width-fluid and self-contained; reusing
  it keeps one card design and identical detail/sign-off behaviour.

## Consequences

- **Behaviour changes to be aware of:** the worker list's createdAt tiebreaker flips (oldest-first
  now), deadline drops below the manual key, and the manager team list is priority-ordered by default
  instead of Firestore order. "Started tasks higher" is no longer a separate rule — it emerges from
  completion (a not-started task is 0 %).
- **No `firestore.rules` change / no deploy.** `taskFieldsOk` is permissive (it validates only
  priority/estimate shape, ignores unknown fields), so a whole-team manager may write `boardRank` like
  any task field; the toggle is an owner self-write on the user doc. Entirely client-side.
- **Dependency added:** `@dnd-kit/core` + `/sortable` + `/utilities`, lazy-loaded (≈19 kB gzip, only
  in the board chunk).
- Gate green: **lint · 625 tests · build** (13 new tests cover the canonical comparator). No
  functions/index change.

## Follow-ups

- The drag was **not exercised against live data** in QA on purpose: the dev environment shares the
  production Firestore and `boardRank`/`priority` are now shared, so a test drag would reorder real
  views and write a real `decision_log` entry. Structure (columns, sortable wiring, persistence,
  zero console errors) was verified via the DOM; a human should confirm one real drag.
- Source-column ranks are left with a gap when a card leaves (harmless); repacking is deferred.
- Mobile has no manual reorder by design — workers/managers on phones consume the shared order.
