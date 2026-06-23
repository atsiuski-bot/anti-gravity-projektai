# ADR 0012 — Tiered per-worker pay rates + after-tax earnings popup

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |

## Context

A worker (Vykdytojas) is a freelancer on an individual-activity certificate (individuali veikla
pagal pažymą), not an employee. The founder wants to (a) set each worker's hourly pay as a
**monthly-hours tiered table** — a higher rate kicks in only for the hours that cross a threshold —
and (b) show the worker, right after they finish a piece of work, **how much it earned**: the
gross (with-tax) amount first, the net (take-home) beside it.

Two modelling questions are genuinely load-bearing and were settled with the founder:

- **How to compute tax.** The net↔gross conversion is not a fixed percentage: Lithuanian GPM is
  progressive (5%→20% across €20k–€42.5k of taxable income) and Sodra has a 90%-of-income base.
  Worse, WORKZ cannot see a freelancer's *total* annual income (other clients), so a true
  year-to-date progressive engine would be both fragile and misleading.
- **The "~30%".** The founder's "~30%" was the *expense deduction*; on inspection that is the
  allowable-expenses figure, while the actual **total** tax burden (GPM + Sodra, no deduction, at
  ~€30k) is ≈ 29%. The founder chose to compute taxes **with no expense deduction**.

## Decision

- **One orientation effective tax rate, derived from a fixed assumption.** Rather than a
  per-worker progressive engine, the system derives a single effective rate from: annual taxable
  income = **€30,000**, **no** allowable-expense deduction, 2026 rules — GPM effective 11.667% at
  €30k (5% to €20k, slope to 20% at €42.5k) + Sodra 19.5% on 90% of income (VSD 12.52% + PSD
  6.98%). Result ≈ **29.22%**, i.e. net ≈ **70.78%** of gross. The assumption knobs live in one
  place (`src/utils/payRate.js`) so re-baselining is a one-line change.
- **The admin enters NET (take-home) hourly rates.** `payRate.tiers = [{fromHours, netRate}, …]`
  on the user doc — ascending, first tier starts at 0, last is open-ended. The system derives the
  GROSS rate (`netToGross = net / 0.7078`) and shows both. Tiers are **marginal**: crossing a
  threshold re-prices only the hours above it.
- **Tiers reset per calendar month**, driven by the worker's cumulative **worked hours** — tasks +
  quick-work + calls (these all live in `work_sessions`; breaks live in `break_sessions` and are
  naturally excluded). The earnings popup sums the month's `work_sessions` (range on `date` only —
  no composite index, mirroring Reports — narrowed to the worker client-side), drops this task's
  own segments to avoid double-counting, then stacks the finished task's full total on top and
  integrates the marginal net rate over that slice.
- **Surfaces.** Admin: a per-worker, admin-only tier editor (`PayRateModal`, opened from
  `UserManagement`, shown for workers only) with per-row gross hints. Worker: a popup
  (`EarningsModal`) after finishing their **own** task, fired by `TaskTimerControls.performFinish`
  only when a rate is set — gross prominent, net beside, plus the effective per-hour rates and the
  tax note.
- **`firestore.rules` — `payRate` is admin-only-write.** A new clause on the `/users` update rule
  gates `payRate` exactly like `teamManagerIds`: `isAdmin() || request.resource.data.get('payRate',
  {}) == resource.data.get('payRate', {})`. A worker can still read their **own** `payRate` (needed
  for the popup) but can never set it.

Logic: `src/utils/payRate.js` (tax model + tier math), currency helpers in
`src/utils/formatters.js` (`formatEur` / `formatEurPerHour`, lt-LT, "€" after the number). UI:
`src/components/PayRateModal.jsx`, `src/components/EarningsModal.jsx`, wired into
`src/components/UserManagement.jsx`, `src/pages/WorkerView.jsx`, `src/components/TaskTimerControls.jsx`.

## Alternatives considered

- **Full progressive LT engine (year-to-date).** Most accurate only if all of a worker's income
  flows through WORKZ; otherwise wrong, and it makes the *same* job earn a different net depending
  on when in the year it is done. Rejected for an orientation figure.
- **Admin types a flat tax % per worker.** Simplest, but the founder wanted the LT rules applied,
  not a hand-entered number. Rejected; the single derived rate captures the intent and stays
  auditable.
- **Per-task earnings without the marginal stack.** Simpler, but would mis-price work once a worker
  crosses a tier mid-month. Rejected — the marginal stack is the whole point of tiers.

## Consequences

- The net↔gross factor is a **constant** until the assumption is changed, so the popup is
  deterministic and explainable; it does **not** track a worker's real annual progression.
- The same task shows a higher value later in the month (once cumulative hours cross a tier) — the
  honest consequence of marginal monthly tiers shown per task.
- A long task spanning a month boundary attributes its **full** total to the completion month
  (minor; tasks rarely span months).
- **Founder-run:** `firestore.rules` deploy is required before the admin-only `payRate` guard is
  live (the classifier blocks prod rule deploys). Until then the client write still works for an
  admin but is not yet server-enforced.

## Follow-ups

- Optionally extend the earnings popup to quick-work / call completions (they already count toward
  monthly hours; only the popup trigger is task-scoped today).
- Optional monthly earnings summary surface for the worker (the founder chose the per-task popup
  only for now).
- Optional per-worker tax-rate override if a worker's real situation diverges from the €30k
  assumption.
- Optional unit tests for `marginalNetEarnings` / the tax derivation (vitest; needs a local
  `npm install` in a fresh worktree).
